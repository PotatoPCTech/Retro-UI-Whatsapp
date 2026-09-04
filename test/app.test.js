'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { createServer } = require('../lib/app');
const { FakeWhatsApp } = require('./fake-wa');
const F = require('./fixtures');

/* ------------------------------------------------------------- infrastruttura */

async function boot() {
  const wa = new FakeWhatsApp();
  const { server } = createServer(wa);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = ioClient(url, { transports: ['websocket'], forceNew: true });
  await once(client, 'connect');
  return {
    wa, server, url, client,
    async close() {
      client.close();
      await new Promise((r) => server.close(r));
    },
  };
}

const once = (emitter, event, timeout = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout in attesa di "${event}"`)), timeout);
  emitter.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

const ask = (client, event, payload, timeout = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`nessun ack per "${event}"`)), timeout);
  client.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
});

/* --------------------------------------------------------------- HTTP */

test('la pagina e le risorse statiche vengono servite', async () => {
  const h = await boot();
  try {
    for (const [p, needle] of [
      ['/', '<title>CRT-WA'],
      ['/css/crt.css', '--fg:'],
      ['/js/app.js', 'renderMessages'],
    ]) {
      const res = await fetch(h.url + p);
      assert.equal(res.status, 200, `${p} ha risposto ${res.status}`);
      assert.ok((await res.text()).includes(needle), `${p} non contiene "${needle}"`);
    }
  } finally { await h.close(); }
});

test('/api/state espone lo stato completo', async () => {
  const h = await boot();
  try {
    const s = await (await fetch(h.url + '/api/state')).json();
    assert.equal(s.state, 'connected');
    assert.equal(s.me.name, 'Giulio');
    assert.ok(s.chats.length >= 4);
    assert.ok(s.stats.groups >= 2);
  } finally { await h.close(); }
});

test('un media in cache torna con il mime giusto, uno scaduto da 404', async () => {
  const h = await boot();
  try {
    const ok = await fetch(`${h.url}/api/media/${encodeURIComponent(F.GROUP)}/G1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await ok.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', 'il corpo non e un PNG');

    const gone = await fetch(`${h.url}/api/media/${encodeURIComponent(F.MARCO)}/NONESISTE`);
    assert.equal(gone.status, 404);
    assert.ok((await gone.json()).error);
  } finally { await h.close(); }
});

test('l avatar risponde 404 quando non c e una foto', async () => {
  const h = await boot();
  try {
    assert.equal((await fetch(`${h.url}/api/avatar/${encodeURIComponent(F.MARCO)}`)).status, 200);
    assert.equal((await fetch(`${h.url}/api/avatar/${encodeURIComponent(F.ANNA)}`)).status, 404);
  } finally { await h.close(); }
});

/* ----------------------------------------------------------- WebSocket */

test('appena connesso il client riceve lo snapshot', async () => {
  const wa = new FakeWhatsApp();
  const { server } = createServer(wa);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = ioClient(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], forceNew: true });
  try {
    const snap = await once(client, 'snapshot');
    assert.equal(snap.state, 'connected');
    assert.ok(Array.isArray(snap.chats));
    assert.ok(snap.chats.some((c) => c.kind === 'group'));
  } finally {
    client.close();
    await new Promise((r) => server.close(r));
  }
});

test('aprire una chat restituisce info e cronologia e azzera i non letti', async () => {
  const h = await boot();
  try {
    assert.equal(h.wa.store.chats.get(F.MARCO).unreadCount, 2);
    const data = await ask(h.client, 'open', F.MARCO);
    assert.equal(data.info.name, 'Marco Bianchi');
    assert.equal(data.info.kind, 'contact');
    assert.ok(data.messages.length >= 2);
    assert.equal(h.wa.store.chats.get(F.MARCO).unreadCount, 0);
  } finally { await h.close(); }
});

test('aprire un gruppo riporta il numero di partecipanti', async () => {
  const h = await boot();
  try {
    const data = await ask(h.client, 'open', F.GROUP);
    assert.equal(data.info.kind, 'group');
    assert.match(data.info.subtitle, /3 partecipanti/);
  } finally { await h.close(); }
});

test('l invio arriva al client e torna il messaggio normalizzato', async () => {
  const h = await boot();
  try {
    const res = await ask(h.client, 'send', { jid: F.MARCO, text: '  ciao mondo  ' });
    assert.equal(res.ok, true);
    assert.equal(res.msg.text, 'ciao mondo', 'il testo va ripulito dagli spazi');
    assert.equal(res.msg.fromMe, true);
    assert.deepEqual(h.wa.sent, [{ jid: F.MARCO, text: 'ciao mondo' }]);
  } finally { await h.close(); }
});

test('un messaggio vuoto o senza destinatario viene rifiutato senza inviare nulla', async () => {
  const h = await boot();
  try {
    assert.match((await ask(h.client, 'send', { jid: F.MARCO, text: '   ' })).error, /vuoto/);
    assert.match((await ask(h.client, 'send', { jid: F.MARCO, text: '' })).error, /vuoto/);
    assert.match((await ask(h.client, 'send', { text: 'orfano' })).error, /canale/);
    assert.equal(h.wa.sent.length, 0);
  } finally { await h.close(); }
});

test('un errore di invio torna al client invece di far cadere il server', async () => {
  const h = await boot();
  try {
    h.wa.failSend = 'connessione persa';
    const res = await ask(h.client, 'send', { jid: F.MARCO, text: 'test' });
    assert.equal(res.error, 'connessione persa');
    assert.equal(res.ok, undefined);
    h.wa.failSend = null;
    assert.equal((await ask(h.client, 'send', { jid: F.MARCO, text: 'ancora' })).ok, true);
  } finally { await h.close(); }
});

test('i messaggi in arrivo vengono trasmessi a tutti i client collegati', async () => {
  const h = await boot();
  const second = ioClient(h.url, { transports: ['websocket'], forceNew: true });
  try {
    await once(second, 'connect');
    const a = once(h.client, 'message');
    const b = once(second, 'message');
    h.wa.receive({ jid: F.MARCO, text: 'sveglia' });
    const [m1, m2] = await Promise.all([a, b]);
    assert.equal(m1.text, 'sveglia');
    assert.equal(m2.text, 'sveglia');
    assert.equal(m1.fromMe, false);
  } finally { second.close(); await h.close(); }
});

test('anche l elenco chat aggiornato viene trasmesso in broadcast', async () => {
  const h = await boot();
  try {
    const wait = once(h.client, 'chats');
    h.wa.receive({ jid: F.GROUP, text: 'ping', author: F.ANNA, pushName: 'Anna' });
    const chats = await wait;
    const g = chats.find((c) => c.jid === F.GROUP);
    assert.equal(g.preview, 'ping');
    assert.equal(g.unread, 1);
    assert.equal(chats[0].jid, F.GROUP, 'la chat con l ultimo messaggio va in cima');
  } finally { await h.close(); }
});

test('qr e stato arrivano al browser', async () => {
  const h = await boot();
  try {
    const qr = once(h.client, 'qr');
    const st = once(h.client, 'status');
    h.wa.showQR('data:image/png;base64,TEST');
    assert.equal(await qr, 'data:image/png;base64,TEST');
    assert.equal((await st).state, 'qr');
  } finally { await h.close(); }
});

test('typing e refresh raggiungono il client whatsapp', async () => {
  const h = await boot();
  try {
    h.client.emit('typing', { jid: F.MARCO, on: true });
    h.client.emit('typing', {});                       // payload rotto: da ignorare
    const chats = once(h.client, 'chats');
    h.client.emit('refresh');
    await chats;
    assert.deepEqual(h.wa.typing, [{ jid: F.MARCO, on: true }]);
  } finally { await h.close(); }
});

test('aprire una chat inesistente non fa cadere la connessione', async () => {
  const h = await boot();
  try {
    const data = await ask(h.client, 'open', 'nonesiste@s.whatsapp.net');
    assert.ok(data.info, 'deve comunque tornare una scheda vuota');
    assert.deepEqual(data.messages, []);
    assert.equal((await ask(h.client, 'send', { jid: F.MARCO, text: 'vivo' })).ok, true);
  } finally { await h.close(); }
});

test('il logout svuota lo store e avvisa i client', async () => {
  const h = await boot();
  try {
    const wait = once(h.client, 'chats');
    h.client.emit('logout');
    assert.deepEqual(await wait, []);
    assert.equal(h.wa.store.chats.size, 0);
  } finally { await h.close(); }
});
