'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { Store } = require('../lib/store');
const F = require('./fixtures');

/**
 * Sostituisce solo il socket Baileys: store, normalizzazione, elenco chat,
 * anteprime e API restano quelli veri. Serve sia ai test sia alla demo UI.
 */
class FakeWhatsApp extends EventEmitter {
  constructor({ seed = true } = {}) {
    super();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crtwa-fake-')), 'store.json');
    this.store = new Store({ file });
    this.state = 'offline';
    this.qrDataUrl = null;
    this.sent = [];
    this.typing = [];
    this.readCalls = [];
    this.failSend = null;
    this.mediaOf = new Map();

    if (seed) this.seed();
  }

  seed() {
    this.store.me = { id: F.ME, name: 'Giulio' };
    this.store.upsertContacts(F.contacts);
    this.store.upsertChats(F.chats);
    this.store.upsertGroups(F.groups);
    this.store.addMessages(F.messages);
    this.state = 'connected';
    this.mediaOf.set(`${F.GROUP}:G1`, { buffer: pngBuffer(), mimetype: 'image/png' });
  }

  /* ---- stessa interfaccia pubblica di WhatsAppClient ---- */

  snapshot() {
    return {
      state: this.state, qr: this.qrDataUrl, me: this.store.me,
      stats: this.store.stats(), chats: this.store.chatList(),
    };
  }

  async openChat(jid) {
    this.store.markRead(jid);
    this.readCalls.push(jid);
    return { info: this.store.chatInfo(jid), messages: this.store.chatMessages(jid) };
  }

  async sendText(jid, text) {
    if (this.failSend) throw new Error(this.failSend);
    const raw = F.msg({
      key: { remoteJid: jid, fromMe: true, id: `OUT${this.sent.length}` },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text },
      status: 1,
    });
    this.sent.push({ jid, text });
    this.store.addMessages([raw]);
    const msg = this.store.normalize(raw);
    this.emit('message', msg);
    this.pushChats();
    return msg;
  }

  async setTyping(jid, on) { this.typing.push({ jid, on }); }
  async loadGroups() { this.store.upsertGroups(F.groups); }
  async logout() {
    // come il client vero: svuota, avvisa, e torna a chiedere un QR
    this.store.clear();
    this.emit('chats', []);
    this.setState('offline', 'disconnesso, cache locale cancellata');
    setTimeout(() => this.showQR(), 300);
  }
  async profilePicture(jid) { return jid === F.MARCO ? 'https://pps.example/img.jpg' : null; }

  async getMedia(jid, id) {
    const m = this.mediaOf.get(`${jid}:${id}`);
    if (!m) throw new Error("messaggio non piu' in cache");
    return m;
  }

  pushChats() {
    this.emit('chats', this.store.chatList());
    this.emit('status', { state: this.state, message: null, me: this.store.me, stats: this.store.stats() });
  }

  setState(state, message) {
    this.state = state;
    this.emit('status', { state, message, me: this.store.me, stats: this.store.stats() });
  }

  /* ---- comandi di scena per i test e la demo ---- */

  receive({ jid = F.MARCO, text = 'nuovo messaggio', author, pushName, message } = {}) {
    const raw = F.msg({
      key: { remoteJid: jid, fromMe: false, id: `IN${Date.now()}${Math.random().toString(36).slice(2, 6)}`, participant: author },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName, message: message || { conversation: text },
    });
    this.store.addMessages([raw]);
    this.store.bumpUnread(jid);
    this.emit('message', this.store.normalize(raw));
    this.pushChats();
  }

  showQR(dataUrl = 'data:image/png;base64,iVBORw0KGgo=') {
    this.state = 'qr';
    this.qrDataUrl = dataUrl;
    this.emit('qr', dataUrl);
    this.setState('qr', 'in attesa della scansione del codice');
  }
}

/** PNG valido generato a mano, per non dipendere da file esterni */
function pngBuffer(size = 120) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      // scacchiera a blocchi + diagonale: riconoscibile a colpo d'occhio
      const block = (((x / 15) | 0) + ((y / 15) | 0)) % 2 === 0;
      const diag = Math.abs(x - y) < 6;
      const v = diag ? 255 : block ? 200 : 40;
      raw[p] = v; raw[p + 1] = v; raw[p + 2] = v;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

module.exports = { FakeWhatsApp, pngBuffer };
