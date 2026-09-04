'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pino = require('pino');
const QR = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  DisconnectReason,
  isJidGroup,
  Browsers,
} = require('@whiskeysockets/baileys');

const { Store } = require('./store');

const DEFAULT_AUTH_DIR = process.env.CRTWA_AUTH || path.join(__dirname, '..', 'auth');
const MAX_RAW = 400;

class WhatsAppClient extends EventEmitter {
  constructor({ authDir = DEFAULT_AUTH_DIR, dataFile } = {}) {
    super();
    this.authDir = authDir;
    this.store = new Store(dataFile ? { file: dataFile } : {});
    this.store.load();
    this.sock = null;
    this.state = 'offline';      // offline | connecting | qr | connected
    this.qrDataUrl = null;
    this.lastError = null;
    this.raw = new Map();        // "jid:msgId" -> WAMessage grezzo (per i media)
    this.logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
    this._chatsTimer = null;
    this._reconnectTimer = null;
    this._stopping = false;
  }

  /* ------------------------------------------------------------ ciclo vita */

  async connect() {
    if (this.sock) return;
    this._stopping = false;
    this.setState('connecting', 'apertura canale con i server WhatsApp');

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (version) console.log(`[wa] protocollo WhatsApp Web v${version.join('.')}`);

    const sock = makeWASocket({
      version,
      logger: this.logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      browser: Browsers.appropriate('CRT-WA'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.raw.get(`${key.remoteJid}:${key.id}`)?.message || undefined,
      cachedGroupMetadata: async (jid) => this.store.groups.get(jid),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnectionUpdate(u));

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress }) => {
      for (const m of lidPnMappings || []) this.store.addLidMapping(m);
      this.store.upsertContacts(contacts || []);
      this.store.upsertChats(chats || []);
      this.keepRaw(messages || []);
      this.store.addMessages(messages || []);
      this.setState(this.state, `sincronizzazione cronologia ${progress ? progress + '%' : '...'}`);
      this.pushChats();
    });

    sock.ev.on('contacts.upsert', (c) => { this.store.upsertContacts(c); this.pushChats(); });
    sock.ev.on('contacts.update', (c) => { this.store.upsertContacts(c); this.pushChats(); });
    sock.ev.on('lid-mapping.update', (m) => this.store.addLidMapping(m));
    sock.ev.on('chats.upsert', (c) => { this.store.upsertChats(c); this.pushChats(); });
    sock.ev.on('chats.update', (c) => { this.store.upsertChats(c); this.pushChats(); });
    sock.ev.on('chats.delete', (ids) => {
      for (const id of ids) { this.store.chats.delete(id); this.store.messages.delete(id); }
      this.pushChats();
    });
    sock.ev.on('groups.upsert', (g) => { this.store.upsertGroups(g); this.pushChats(); });
    sock.ev.on('groups.update', (g) => { this.store.upsertGroups(g); this.pushChats(); });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.keepRaw(messages);
      const touched = this.store.addMessages(messages);
      for (const raw of messages) {
        const msg = this.store.normalize(raw);
        if (!msg) continue;
        if (type === 'notify' && !msg.fromMe) this.store.bumpUnread(msg.jid);
        this.emit('message', msg);
      }
      if (touched.length) this.pushChats();
    });

    sock.ev.on('messages.update', (u) => {
      const touched = this.store.updateMessages(u);
      for (const jid of touched) this.emit('messages-updated', jid);
    });

    sock.ev.on('presence.update', ({ id, presences }) => {
      const entry = Object.values(presences || {})[0];
      if (!entry) return;
      this.emit('presence', { jid: id, presence: entry.lastKnownPresence, lastSeen: entry.lastSeen });
    });
  }

  async onConnectionUpdate(u) {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.qrDataUrl = await QR.toDataURL(qr, {
        margin: 1, scale: 6, errorCorrectionLevel: 'M',
        color: { dark: '#04120a', light: '#8dffb8' },
      });
      this.setState('qr', 'in attesa della scansione del codice');
      this.emit('qr', this.qrDataUrl);
    }

    if (connection === 'connecting') this.setState('connecting', 'handshake in corso');

    if (connection === 'open') {
      this.qrDataUrl = null;
      this.store.me = {
        id: this.store.norm(this.sock.user?.id),
        lid: this.sock.user?.lid,
        name: this.sock.user?.name || this.sock.user?.verifiedName || 'io',
      };
      this.setState('connected', 'collegato');
      this.emit('ready', this.store.me);
      this.loadGroups().catch(() => {});
      this.pushChats();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden;
      this.sock = null;
      this.qrDataUrl = null;

      if (this._stopping) { this.setState('offline', 'disconnesso'); return; }

      if (loggedOut) {
        this.lastError = 'sessione terminata dal telefono';
        await this.wipeAuth();
        this.setState('offline', 'sessione chiusa: serve un nuovo QR');
        this.scheduleReconnect(1500);
      } else {
        this.setState('connecting', `riconnessione (codice ${code || '???'})`);
        this.scheduleReconnect(2500);
      }
    }
  }

  scheduleReconnect(ms) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => {
        this.lastError = e.message;
        this.setState('offline', `errore: ${e.message}`);
        this.scheduleReconnect(5000);
      });
    }, ms);
  }

  async loadGroups() {
    try {
      const all = await this.sock.groupFetchAllParticipating();
      this.store.upsertGroups(Object.values(all || {}));
      this.pushChats();
    } catch (e) {
      console.error('[wa] impossibile leggere i gruppi:', e.message);
    }
  }

  async logout() {
    this._stopping = true;
    clearTimeout(this._reconnectTimer);
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end?.(undefined); } catch {}
    this.sock = null;
    await this.wipeAuth();
    this.store.clear();
    this.setState('offline', 'disconnesso, cache locale cancellata');
    this.emit('chats', []);
    setTimeout(() => this.connect().catch(() => {}), 800);
  }

  async wipeAuth() {
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  /* --------------------------------------------------------------- azioni */

  keepRaw(messages = []) {
    for (const m of messages) {
      if (!m?.key?.id) continue;
      this.raw.set(`${m.key.remoteJid}:${m.key.id}`, m);
    }
    while (this.raw.size > MAX_RAW) this.raw.delete(this.raw.keys().next().value);
  }

  async sendText(jid, text) {
    if (!this.sock) throw new Error('non connesso');
    const res = await this.sock.sendMessage(jid, { text });
    if (res) { this.keepRaw([res]); this.store.addMessages([res]); }
    return this.store.normalize(res);
  }

  async openChat(jid) {
    this.store.markRead(jid);
    if (this.sock) {
      this.sock.presenceSubscribe(jid).catch(() => {});
      const last = (this.store.messages.get(jid) || []).slice(-1)[0];
      const raw = last && this.raw.get(`${jid}:${last.id}`);
      if (raw && !last.fromMe) this.sock.readMessages([raw.key]).catch(() => {});
      if (isJidGroup(jid) && !this.store.groups.get(jid)?.participants) {
        this.sock.groupMetadata(jid).then((g) => this.store.upsertGroups([g])).catch(() => {});
      }
    }
    return {
      info: this.store.chatInfo(jid),
      messages: this.store.chatMessages(jid),
    };
  }

  async setTyping(jid, on) {
    if (!this.sock) return;
    try { await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid); } catch {}
  }

  async getMedia(jid, msgId) {
    const raw = this.raw.get(`${jid}:${msgId}`);
    if (!raw) throw new Error('messaggio non piu\' in cache');
    const buffer = await downloadMediaMessage(raw, 'buffer', {}, {
      logger: this.logger,
      reuploadRequest: this.sock?.updateMediaMessage,
    });
    const inner = raw.message?.imageMessage || raw.message?.stickerMessage
      || raw.message?.videoMessage || raw.message?.audioMessage || raw.message?.documentMessage;
    return { buffer, mimetype: inner?.mimetype || 'application/octet-stream' };
  }

  async profilePicture(jid) {
    if (!this.sock) return null;
    try { return await this.sock.profilePictureUrl(jid, 'preview'); } catch { return null; }
  }

  /* ------------------------------------------------------------- emissione */

  setState(state, message) {
    this.state = state;
    this.emit('status', { state, message, me: this.store.me, stats: this.store.stats() });
  }

  /** raggruppa gli aggiornamenti: durante il sync arrivano a raffica */
  pushChats() {
    if (this._chatsTimer) return;
    this._chatsTimer = setTimeout(() => {
      this._chatsTimer = null;
      this.emit('chats', this.store.chatList());
      this.emit('status', {
        state: this.state, message: null, me: this.store.me, stats: this.store.stats(),
      });
    }, 400);
  }

  snapshot() {
    return {
      state: this.state,
      qr: this.qrDataUrl,
      me: this.store.me,
      stats: this.store.stats(),
      chats: this.store.chatList(),
    };
  }
}

module.exports = { WhatsAppClient };
