'use strict';

const fs = require('fs');
const path = require('path');
const { isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser, getContentType } = require('@whiskeysockets/baileys');

const DEFAULT_DATA_FILE = process.env.CRTWA_DATA || path.join(__dirname, '..', 'data', 'store.json');
const MAX_MSG_PER_CHAT = 300;
const MAX_MSG_SAVED = 80;

/**
 * Store in memoria (Baileys 7 non ne fornisce piu' uno).
 * Tiene contatti, chat, gruppi e messaggi; si autosalva su disco.
 */
class Store {
  constructor({ file = DEFAULT_DATA_FILE } = {}) {
    this.file = file;
    this.contacts = new Map(); // jid -> Contact
    this.chats = new Map();    // jid -> Chat
    this.groups = new Map();   // jid -> GroupMetadata
    this.messages = new Map(); // jid -> [msg normalizzati, ordine cronologico]
    this.lidToPn = new Map();  // @lid -> @s.whatsapp.net
    this.me = null;
    this.dirty = false;
    this._timer = null;
  }

  /* ---------------------------------------------------------------- utils */

  static isRelevantJid(jid) {
    if (!jid) return false;
    if (isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return false;
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  }

  norm(jid) {
    if (!jid) return jid;
    try { return jidNormalizedUser(jid) || jid; } catch { return jid; }
  }

  /** risolve un @lid al numero di telefono quando lo conosciamo */
  resolve(jid) {
    if (!jid) return jid;
    const n = this.norm(jid);
    return this.lidToPn.get(n) || n;
  }

  /* ------------------------------------------------------------- contatti */

  upsertContacts(list = []) {
    for (const c of list) {
      if (!c || !c.id) continue;
      const id = this.norm(c.id);
      const prev = this.contacts.get(id) || {};
      const merged = { ...prev, ...c, id };
      // non sovrascrivere un nome buono con undefined
      merged.name = c.name || prev.name;
      merged.notify = c.notify || prev.notify;
      this.contacts.set(id, merged);
      if (c.lid && c.phoneNumber) this.lidToPn.set(this.norm(c.lid), this.norm(c.phoneNumber));
      if (id.endsWith('@lid') && c.phoneNumber) this.lidToPn.set(id, this.norm(c.phoneNumber));
    }
    this.touch();
  }

  addLidMapping(m) {
    if (!m) return;
    const lid = m.lid || m.lidJid;
    const pn = m.pn || m.pnJid || m.phoneNumber;
    if (lid && pn) { this.lidToPn.set(this.norm(lid), this.norm(pn)); this.touch(); }
  }

  /* ----------------------------------------------------------------- chat */

  upsertChats(list = []) {
    for (const c of list) {
      if (!c || !Store.isRelevantJid(c.id)) continue;
      const id = this.norm(c.id);
      const prev = this.chats.get(id) || { id, unreadCount: 0 };
      const next = { ...prev };
      if (c.name !== undefined && c.name !== null) next.name = c.name;
      if (c.conversationTimestamp) next.conversationTimestamp = Number(c.conversationTimestamp.low ?? c.conversationTimestamp);
      if (c.unreadCount !== undefined && c.unreadCount !== null) next.unreadCount = Math.max(0, Number(c.unreadCount));
      if (c.archived !== undefined) next.archived = !!c.archived;
      if (c.pinned !== undefined) next.pinned = !!c.pinned;
      if (c.muteEndTime) next.muteEndTime = Number(c.muteEndTime.low ?? c.muteEndTime);
      this.chats.set(id, next);
    }
    this.touch();
  }

  ensureChat(jid) {
    const id = this.norm(jid);
    if (!this.chats.has(id) && Store.isRelevantJid(id)) {
      this.chats.set(id, { id, unreadCount: 0 });
    }
    return this.chats.get(id);
  }

  upsertGroups(list = []) {
    for (const g of list) {
      if (!g || !g.id) continue;
      const id = this.norm(g.id);
      const prev = this.groups.get(id) || {};
      this.groups.set(id, { ...prev, ...g, id });
      const chat = this.ensureChat(id);
      if (chat && g.subject) chat.name = g.subject;
    }
    this.touch();
  }

  /* ------------------------------------------------------------- messaggi */

  /** estrae testo + tipo leggibile da un messaggio Baileys grezzo */
  static describe(raw) {
    let m = raw?.message;
    if (!m) return { type: 'unknown', text: '' };
    if (m.ephemeralMessage) m = m.ephemeralMessage.message || {};
    if (m.viewOnceMessage) m = m.viewOnceMessage.message || {};
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || {};
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || {};
    const type = getContentType(m) || 'unknown';

    switch (type) {
      case 'conversation':
        return { type: 'text', text: m.conversation || '' };
      case 'extendedTextMessage':
        return { type: 'text', text: m.extendedTextMessage?.text || '' };
      case 'imageMessage':
        return { type: 'image', text: m.imageMessage?.caption || '', media: true };
      case 'videoMessage':
        return { type: m.videoMessage?.gifPlayback ? 'gif' : 'video', text: m.videoMessage?.caption || '' };
      case 'audioMessage':
        return { type: m.audioMessage?.ptt ? 'ptt' : 'audio', text: '', seconds: m.audioMessage?.seconds || 0 };
      case 'stickerMessage':
        return { type: 'sticker', text: '' };
      case 'documentMessage':
        return { type: 'document', text: m.documentMessage?.fileName || '' };
      case 'locationMessage':
        return { type: 'location', text: m.locationMessage?.name || '' };
      case 'liveLocationMessage':
        return { type: 'location', text: 'posizione in tempo reale' };
      case 'contactMessage':
        return { type: 'contact', text: m.contactMessage?.displayName || '' };
      case 'contactsArrayMessage':
        return { type: 'contact', text: `${m.contactsArrayMessage?.contacts?.length || 0} contatti` };
      case 'pollCreationMessage':
      case 'pollCreationMessageV2':
      case 'pollCreationMessageV3':
        return { type: 'poll', text: (m[type]?.name) || 'sondaggio' };
      case 'reactionMessage':
        return { type: 'reaction', text: m.reactionMessage?.text || '' };
      case 'protocolMessage':
        return { type: 'protocol', text: '' };
      default:
        return { type, text: '' };
    }
  }

  /** converte un WAMessage in un oggetto snello per il frontend */
  normalize(raw) {
    if (!raw?.key?.id) return null;
    const jid = this.norm(raw.key.remoteJid);
    if (!Store.isRelevantJid(jid)) return null;

    const d = Store.describe(raw);
    if (d.type === 'protocol') return null;

    const ts = Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0);
    const isGroup = isJidGroup(jid);
    const authorRaw = raw.key.participant || raw.participant || (raw.key.fromMe ? this.me?.id : jid);
    const author = this.resolve(authorRaw);

    const ctx = raw.message?.extendedTextMessage?.contextInfo
      || raw.message?.imageMessage?.contextInfo
      || raw.message?.videoMessage?.contextInfo;
    let quoted = null;
    if (ctx?.quotedMessage) {
      const q = Store.describe({ message: ctx.quotedMessage });
      quoted = {
        author: this.displayName(this.resolve(ctx.participant)),
        text: q.text || `[${q.type}]`,
      };
    }

    return {
      id: raw.key.id,
      jid,
      fromMe: !!raw.key.fromMe,
      ts,
      type: d.type,
      text: d.text,
      seconds: d.seconds,
      hasMedia: !!d.media,
      author: isGroup ? author : undefined,
      authorName: isGroup && !raw.key.fromMe ? (raw.pushName || this.displayName(author)) : undefined,
      status: raw.status,
      quoted,
    };
  }

  addMessages(rawList = [], { prepend = false } = {}) {
    const touched = new Set();
    for (const raw of rawList) {
      const msg = this.normalize(raw);
      if (!msg) continue;
      // nome utile dal pushName
      if (!msg.fromMe && raw.pushName) {
        const who = this.resolve(raw.key.participant || raw.key.remoteJid);
        const c = this.contacts.get(who) || { id: who };
        if (!c.notify) { c.notify = raw.pushName; this.contacts.set(who, c); }
      }
      const list = this.messages.get(msg.jid) || [];
      const i = list.findIndex((m) => m.id === msg.id);
      if (i >= 0) list[i] = { ...list[i], ...msg };
      else list.push(msg);
      this.messages.set(msg.jid, list);
      touched.add(msg.jid);
    }

    for (const jid of touched) {
      const list = this.messages.get(jid);
      list.sort((a, b) => a.ts - b.ts);
      if (list.length > MAX_MSG_PER_CHAT) this.messages.set(jid, list.slice(-MAX_MSG_PER_CHAT));
      const chat = this.ensureChat(jid);
      const last = list[list.length - 1];
      if (chat && last && (!chat.conversationTimestamp || last.ts > chat.conversationTimestamp)) {
        chat.conversationTimestamp = last.ts;
      }
    }
    this.touch();
    return [...touched];
  }

  updateMessages(updates = []) {
    const touched = new Set();
    for (const u of updates) {
      const jid = this.norm(u.key?.remoteJid);
      const list = this.messages.get(jid);
      if (!list) continue;
      const m = list.find((x) => x.id === u.key.id);
      if (!m) continue;
      if (u.update?.status !== undefined) m.status = u.update.status;
      touched.add(jid);
    }
    this.touch();
    return [...touched];
  }

  markRead(jid) {
    const chat = this.chats.get(this.norm(jid));
    if (chat) { chat.unreadCount = 0; this.touch(); }
  }

  bumpUnread(jid) {
    const chat = this.ensureChat(jid);
    if (chat) { chat.unreadCount = (chat.unreadCount || 0) + 1; this.touch(); }
  }

  /* ------------------------------------------------------------ interfaccia */

  displayName(jid) {
    if (!jid) return '???';
    const id = this.resolve(jid);
    if (isJidGroup(id)) {
      return this.groups.get(id)?.subject || this.chats.get(id)?.name || 'GRUPPO';
    }
    const c = this.contacts.get(id) || this.contacts.get(this.norm(jid));
    const name = c?.name || c?.verifiedName || c?.notify;
    if (name) return name;
    const chatName = this.chats.get(id)?.name;
    if (chatName) return chatName;
    const user = (c?.phoneNumber || id).split('@')[0].split(':')[0];
    return id.endsWith('@lid') && !c?.phoneNumber ? `utente ${user.slice(-6)}` : `+${user}`;
  }

  chatList() {
    const out = [];
    for (const [id, chat] of this.chats) {
      if (!Store.isRelevantJid(id)) continue;
      const msgs = this.messages.get(id) || [];
      const last = msgs[msgs.length - 1];
      const group = isJidGroup(id);
      out.push({
        jid: id,
        name: this.displayName(id),
        kind: group ? 'group' : 'contact',
        participants: group ? (this.groups.get(id)?.participants?.length || 0) : 0,
        unread: chat.unreadCount || 0,
        pinned: !!chat.pinned,
        archived: !!chat.archived,
        muted: !!(chat.muteEndTime && chat.muteEndTime * 1000 > Date.now()),
        ts: last?.ts || chat.conversationTimestamp || 0,
        preview: last ? this.previewOf(last) : '',
        lastFromMe: last ? last.fromMe : false,
      });
    }
    out.sort((a, b) => (b.pinned - a.pinned) || (b.ts - a.ts));
    return out;
  }

  previewOf(m) {
    const label = {
      image: '[IMMAGINE]', video: '[VIDEO]', gif: '[GIF]', audio: '[AUDIO]',
      ptt: '[VOCALE]', sticker: '[STICKER]', document: '[FILE]',
      location: '[POSIZIONE]', contact: '[CONTATTO]', poll: '[SONDAGGIO]',
      reaction: '[REAZIONE]',
    }[m.type];
    const body = (m.text || '').replace(/\s+/g, ' ').trim();
    if (label) return body ? `${label} ${body}` : label;
    return body || `[${m.type.toUpperCase()}]`;
  }

  chatMessages(jid, limit = 120) {
    const id = this.norm(jid);
    const list = this.messages.get(id) || [];
    return list.slice(-limit);
  }

  chatInfo(jid) {
    const id = this.norm(jid);
    const group = isJidGroup(id);
    const g = this.groups.get(id);
    return {
      jid: id,
      name: this.displayName(id),
      kind: group ? 'group' : 'contact',
      subtitle: group
        ? `${g?.participants?.length || 0} partecipanti`
        : `+${(this.contacts.get(id)?.phoneNumber || id).split('@')[0].split(':')[0]}`,
      description: group ? (g?.desc || '') : (this.contacts.get(id)?.status || ''),
    };
  }

  stats() {
    let groups = 0, contacts = 0;
    for (const id of this.chats.keys()) (isJidGroup(id) ? groups++ : contacts++);
    return { chats: this.chats.size, groups, contacts, contactsKnown: this.contacts.size };
  }

  /* ------------------------------------------------------------ persistenza */

  touch() {
    this.dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.save(); }, 4000);
    this._timer.unref?.();
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const msgs = {};
      for (const [jid, list] of this.messages) msgs[jid] = list.slice(-MAX_MSG_SAVED);
      const payload = {
        v: 1,
        me: this.me,
        contacts: [...this.contacts.values()],
        chats: [...this.chats.values()],
        groups: [...this.groups.values()].map((g) => ({
          id: g.id, subject: g.subject, desc: g.desc,
          participants: (g.participants || []).map((p) => ({ id: p.id })),
        })),
        lidToPn: [...this.lidToPn.entries()],
        messages: msgs,
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(payload));
    } catch (e) {
      console.error('[store] salvataggio fallito:', e.message);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.me = raw.me || null;
      for (const c of raw.contacts || []) this.contacts.set(c.id, c);
      for (const c of raw.chats || []) this.chats.set(c.id, c);
      for (const g of raw.groups || []) this.groups.set(g.id, g);
      for (const [k, v] of raw.lidToPn || []) this.lidToPn.set(k, v);
      for (const [jid, list] of Object.entries(raw.messages || {})) this.messages.set(jid, list);
      console.log(`[store] ripristinate ${this.chats.size} chat dalla cache locale`);
    } catch (e) {
      console.error('[store] caricamento fallito:', e.message);
    }
  }

  clear() {
    this.contacts.clear(); this.chats.clear(); this.groups.clear();
    this.messages.clear(); this.lidToPn.clear(); this.me = null;
    try { fs.existsSync(this.file) && fs.unlinkSync(this.file); } catch {}
  }
}

module.exports = { Store };
