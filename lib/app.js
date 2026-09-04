'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/**
 * Costruisce app HTTP + Socket.IO attorno a un client WhatsApp.
 * Il client e' iniettato cosi' da poterlo sostituire nei test.
 */
function createServer(wa) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  /* ------------------------------------------------------------- HTTP API */

  app.get('/api/state', (_req, res) => res.json(wa.snapshot()));

  app.get('/api/media/:jid/:id', async (req, res) => {
    try {
      const { buffer, mimetype } = await wa.getMedia(req.params.jid, req.params.id);
      res.set('Content-Type', mimetype);
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(buffer);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.get('/api/avatar/:jid', async (req, res) => {
    const url = await wa.profilePicture(req.params.jid);
    if (!url) return res.status(404).end();
    res.json({ url });
  });

  /* ------------------------------------------------------------ WebSocket */

  io.on('connection', (socket) => {
    socket.emit('snapshot', wa.snapshot());

    socket.on('open', async (jid, ack) => {
      try {
        const data = await wa.openChat(jid);
        ack?.(data);
        socket.emit('chats', wa.store.chatList());
      } catch (e) {
        ack?.({ error: e.message });
      }
    });

    socket.on('send', async ({ jid, text } = {}, ack) => {
      try {
        if (!jid) return ack?.({ error: 'nessun canale selezionato' });
        if (!text?.trim()) return ack?.({ error: 'messaggio vuoto' });
        const msg = await wa.sendText(jid, text.trim());
        ack?.({ ok: true, msg });
      } catch (e) {
        ack?.({ error: e.message });
      }
    });

    socket.on('typing', ({ jid, on } = {}) => { if (jid) wa.setTyping(jid, on); });
    socket.on('refresh', () => { wa.loadGroups().catch(() => {}); wa.pushChats(); });
    socket.on('logout', () => wa.logout().catch(() => {}));
  });

  const events = ['status', 'qr', 'ready', 'chats', 'message', 'presence', 'messages-updated'];
  for (const ev of events) wa.on(ev, (payload) => io.emit(ev, payload));

  return { app, server, io };
}

module.exports = { createServer };
