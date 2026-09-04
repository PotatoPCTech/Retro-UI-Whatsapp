'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

const { WhatsAppClient } = require('../lib/whatsapp');
const F = require('./fixtures');

function client() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crtwa-wa-'));
  const c = new WhatsAppClient({
    authDir: path.join(dir, 'auth'),
    dataFile: path.join(dir, 'store.json'),
  });
  c.scheduleReconnect = function (ms) { this._reconnects = (this._reconnects || []).concat(ms); };
  return c;
}

const raw = (id, jid = F.MARCO) => F.msg({ key: { remoteJid: jid, id } });

/* ------------------------------------------------------------------- QR */

test('il QR mostrato a schermo si decodifica nella stringa di pairing', async () => {
  const c = client();
  const payload = '2@abcDEF123/xyz+456==,QWERTYuiop/asdf+ghjkl=,AbCdEf12,1';
  await c.onConnectionUpdate({ qr: payload });

  assert.ok(c.qrDataUrl?.startsWith('data:image/png;base64,'), 'il QR deve essere un PNG in data URL');
  const png = PNG.sync.read(Buffer.from(c.qrDataUrl.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

  assert.ok(decoded, 'il codice generato non e leggibile da un decodificatore');
  assert.equal(decoded.data, payload, 'il QR codifica una stringa diversa da quella di WhatsApp');
});

test('la polarita del QR e quella standard: moduli scuri su fondo chiaro', async () => {
  const c = client();
  await c.onConnectionUpdate({ qr: 'polarita-test' });
  const png = PNG.sync.read(Buffer.from(c.qrDataUrl.split(',')[1], 'base64'));
  const lum = (x, y) => {
    const i = (y * png.width + x) * 4;
    return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  };
  // scale 6, margin 1 modulo: il nucleo scuro del finder in alto a sinistra
  // e' il modulo (3,3), quindi 6 + 3*6 + 3 = 27 px.
  const sfondo = lum(0, 0);
  const nucleoFinder = lum(27, 27);
  assert.ok(sfondo > 150, `lo sfondo deve essere chiaro, luminanza ${sfondo.toFixed(0)}`);
  assert.ok(nucleoFinder < 60, `i moduli devono essere scuri, luminanza ${nucleoFinder.toFixed(0)}`);
  assert.ok(sfondo - nucleoFinder > 120, 'contrasto insufficiente per uno scanner');

  // e nell'immagine devono comparire entrambe le classi di pixel
  let scuri = 0, chiari = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) (lum(x, y) < 100 ? scuri++ : chiari++);
  }
  assert.ok(scuri > png.width * png.height * 0.2, 'troppi pochi moduli scuri');
  assert.ok(chiari > scuri, 'in un QR corretto lo sfondo chiaro e maggioritario');
});

test('emette qr e stato quando WhatsApp chiede l abbinamento', async () => {
  const c = client();
  const eventi = [];
  c.on('qr', () => eventi.push('qr'));
  c.on('status', (s) => eventi.push(`status:${s.state}`));
  await c.onConnectionUpdate({ qr: 'abc' });
  assert.deepEqual(eventi, ['status:qr', 'qr']);
  assert.equal(c.state, 'qr');
});

/* --------------------------------------------------------- riconnessione */

test('una disconnessione temporanea programma la riconnessione senza toccare le credenziali', async () => {
  const c = client();
  fs.mkdirSync(c.authDir, { recursive: true });
  fs.writeFileSync(path.join(c.authDir, 'creds.json'), '{"finto":true}');

  await c.onConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 } } }, // restartRequired
  });

  assert.equal(c.state, 'connecting');
  assert.deepEqual(c._reconnects, [2500]);
  assert.ok(fs.existsSync(path.join(c.authDir, 'creds.json')), 'le credenziali non vanno cancellate');
});

test('un logout dal telefono cancella le credenziali e richiede un nuovo QR', async () => {
  const c = client();
  fs.mkdirSync(c.authDir, { recursive: true });
  fs.writeFileSync(path.join(c.authDir, 'creds.json'), '{"finto":true}');

  await c.onConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } }, // loggedOut
  });

  assert.equal(c.state, 'offline');
  assert.equal(fs.existsSync(path.join(c.authDir, 'creds.json')), false, 'la sessione morta va rimossa');
  assert.ok(c._reconnects?.length, 'deve comunque ripartire per mostrare un nuovo QR');
});

test('uno spegnimento volontario non innesca riconnessioni', async () => {
  const c = client();
  c._stopping = true;
  await c.onConnectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  assert.equal(c.state, 'offline');
  assert.equal(c._reconnects, undefined);
});

test('alla connessione riuscita registra l identita e azzera il QR', async () => {
  const c = client();
  c.qrDataUrl = 'data:image/png;base64,vecchio';
  c.sock = { user: { id: '393401110000:12@s.whatsapp.net', name: 'Giulio' } };
  c.loadGroups = async () => {};
  const ready = new Promise((r) => c.once('ready', r));
  await c.onConnectionUpdate({ connection: 'open' });
  const me = await ready;
  assert.equal(c.state, 'connected');
  assert.equal(c.qrDataUrl, null, 'il QR deve sparire una volta collegati');
  assert.equal(me.id, '393401110000@s.whatsapp.net', 'il device id va normalizzato via');
  assert.equal(me.name, 'Giulio');
});

/* ------------------------------------------------------------ cache media */

test('la cache dei messaggi grezzi e limitata e scarta i piu vecchi', () => {
  const c = client();
  c.keepRaw(Array.from({ length: 450 }, (_, i) => raw(`R${i}`)));
  assert.equal(c.raw.size, 400);
  assert.equal(c.raw.has(`${F.MARCO}:R0`), false, 'i piu vecchi devono uscire');
  assert.equal(c.raw.has(`${F.MARCO}:R449`), true, 'i piu recenti devono restare');
});

test('un media non piu in cache da un errore parlante invece di un crash', async () => {
  const c = client();
  await assert.rejects(() => c.getMedia(F.MARCO, 'SPARITO'), /non piu/);
});

/* --------------------------------------------------------- accorpamento */

test('una raffica di eventi produce un solo aggiornamento dell elenco', async () => {
  const c = client();
  let emissioni = 0;
  c.on('chats', () => emissioni++);
  for (let i = 0; i < 50; i++) c.pushChats();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(emissioni, 1, `50 eventi hanno prodotto ${emissioni} render invece di 1`);
});

test('lo snapshot contiene tutto il necessario per disegnare la pagina', () => {
  const c = client();
  c.store.upsertContacts(F.contacts);
  c.store.upsertChats(F.chats);
  c.store.addMessages(F.messages);
  const s = c.snapshot();
  assert.deepEqual(Object.keys(s).sort(), ['chats', 'me', 'qr', 'state', 'stats']);
  assert.ok(Array.isArray(s.chats));
});

/* ------------------------------------------------------------ invio */

test('sendText rifiuta con un messaggio chiaro se non c e connessione', async () => {
  const c = client();
  await assert.rejects(() => c.sendText(F.MARCO, 'ciao'), /non connesso/);
});

test('sendText memorizza il messaggio inviato nella cronologia locale', async () => {
  const c = client();
  const inviato = F.msg({ key: { remoteJid: F.MARCO, fromMe: true, id: 'OUT1' }, message: { conversation: 'ciao' } });
  c.sock = { sendMessage: async () => inviato };
  const msg = await c.sendText(F.MARCO, 'ciao');
  assert.equal(msg.text, 'ciao');
  assert.equal(msg.fromMe, true);
  assert.ok(c.store.messages.get(F.MARCO).some((m) => m.id === 'OUT1'));
  assert.ok(c.raw.has(`${F.MARCO}:OUT1`), 'va tenuto grezzo per eventuali media');
});
