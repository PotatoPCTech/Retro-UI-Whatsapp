'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const F = require('./fixtures');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crtwa-')), 'store.json');
const fresh = () => {
  const s = new Store({ file: tmp() });
  s.me = { id: F.ME, name: 'io' };
  return s;
};
const seeded = () => {
  const s = fresh();
  s.upsertContacts(F.contacts);
  s.upsertChats(F.chats);
  s.upsertGroups(F.groups);
  s.addMessages(F.messages);
  return s;
};

/* ------------------------------------------------------------- filtraggio */

test('scarta stati, canali e altri jid non conversazionali', () => {
  const s = seeded();
  const ids = [...s.chats.keys()];
  assert.ok(!ids.includes(F.BROADCAST), 'status@broadcast non deve entrare');
  assert.ok(!ids.includes(F.NEWSLETTER), 'i canali non devono entrare');
  assert.equal(s.messages.get(F.BROADCAST), undefined);
  assert.equal(s.messages.get(F.NEWSLETTER), undefined);
});

test('i protocolMessage non compaiono nella cronologia', () => {
  const s = seeded();
  const ids = (s.messages.get(F.MARCO) || []).map((m) => m.id);
  assert.ok(!ids.includes('P1'));
});

/* ------------------------------------------------------------ timestamp */

test('i timestamp Long vengono convertiti in numeri', () => {
  const s = seeded();
  for (const m of s.messages.get(F.MARCO)) {
    assert.equal(typeof m.ts, 'number');
    assert.ok(Number.isFinite(m.ts) && m.ts > 0, `ts non valido: ${JSON.stringify(m.ts)}`);
  }
  const chat = s.chats.get(F.MARCO);
  assert.equal(typeof chat.conversationTimestamp, 'number');
});

/* ------------------------------------------------------------------ nomi */

test('risoluzione dei nomi: rubrica > notify > chat > numero', () => {
  const s = seeded();
  assert.equal(s.displayName(F.MARCO), 'Marco Bianchi');       // name della rubrica
  assert.equal(s.displayName(F.ANNA), 'Anna');                 // solo notify
  assert.equal(s.displayName(F.GROUP), 'Serata pizza');        // subject del gruppo
  assert.equal(s.displayName('393339990000@s.whatsapp.net'), '+393339990000'); // nessun nome
});

test('un @lid con numero associato viene risolto sul contatto reale', () => {
  const s = seeded();
  assert.equal(s.resolve(F.LID), '393336667777@s.whatsapp.net');
});

test('un @lid sconosciuto non produce un nome fuorviante', () => {
  const s = fresh();
  const name = s.displayName('999888777666@lid');
  assert.ok(!name.startsWith('+'), `un lid non e' un numero: ${name}`);
  assert.match(name, /^utente /);
});

test('il pushName riempie i contatti mai salvati in rubrica', () => {
  const s = fresh();
  s.addMessages([F.msg({ key: { remoteJid: '393000000000@s.whatsapp.net', id: 'X1' }, pushName: 'Sconosciuto' })]);
  assert.equal(s.displayName('393000000000@s.whatsapp.net'), 'Sconosciuto');
});

test('un aggiornamento parziale non cancella un nome gia noto', () => {
  const s = seeded();
  s.upsertContacts([{ id: F.MARCO, status: 'occupato' }]);
  assert.equal(s.displayName(F.MARCO), 'Marco Bianchi');
});

/* ------------------------------------------------------ tipi di messaggio */

test('ogni tipo di messaggio produce type e testo sensati', () => {
  const s = fresh();
  const expected = {
    text_plain: ['text', 'testo semplice'], text_ext: ['text', 'testo esteso'],
    image: ['image', 'foto'], video: ['video', 'clip'], gif: ['gif', ''],
    audio: ['audio', ''], ptt: ['ptt', ''], sticker: ['sticker', ''],
    document: ['document', 'preventivo.pdf'], doc_caption: ['document', 'nota.docx'],
    location: ['location', 'Piazza Duomo'], live_loc: ['location', 'posizione in tempo reale'],
    contact: ['contact', 'Idraulico'], contacts: ['contact', '3 contatti'],
    poll: ['poll', 'Che pizza?'], reaction: ['reaction', '👍'],
    ephemeral: ['text', 'effimero'], viewonce: ['image', 'una volta sola'],
    quoted: ['text', 'rispondo'],
  };
  for (const [name, content] of Object.entries(F.everyType)) {
    const norm = s.normalize(F.msg({ key: { id: `T-${name}` }, message: content }));
    assert.ok(norm, `${name}: normalize ha restituito null`);
    const [type, text] = expected[name];
    assert.equal(norm.type, type, `${name}: tipo atteso ${type}, ottenuto ${norm.type}`);
    assert.equal(norm.text, text, `${name}: testo atteso "${text}", ottenuto "${norm.text}"`);
  }
});

test('la citazione riporta autore e testo originale', () => {
  const s = seeded();
  const norm = s.normalize(F.msg({ key: { id: 'Q1' }, message: F.everyType.quoted }));
  assert.equal(norm.quoted.author, 'Marco Bianchi');
  assert.equal(norm.quoted.text, 'domanda originale');
});

test('la durata dei vocali sopravvive alla normalizzazione', () => {
  const s = fresh();
  const norm = s.normalize(F.msg({ key: { id: 'V1' }, message: F.everyType.ptt }));
  assert.equal(norm.seconds, 5);
});

/* -------------------------------------------------------------- anteprime */

test('le anteprime etichettano i media e comprimono gli a capo', () => {
  const s = fresh();
  assert.equal(s.previewOf({ type: 'ptt', text: '' }), '[VOCALE]');
  assert.equal(s.previewOf({ type: 'image', text: 'due gatti' }), '[IMMAGINE] due gatti');
  assert.equal(s.previewOf({ type: 'text', text: 'prima\nseconda' }), 'prima seconda');
  assert.equal(s.previewOf({ type: 'document', text: 'x.pdf' }), '[FILE] x.pdf');
});

/* ----------------------------------------------------------- autore gruppi */

test('nei gruppi ogni messaggio porta il nome di chi lo ha scritto', () => {
  const s = seeded();
  const g = s.messages.get(F.GROUP).find((m) => m.id === 'G1');
  assert.equal(g.authorName, 'Anna');
  assert.equal(g.author, F.ANNA);
});

test('nelle chat singole non si stampa il nome dell autore', () => {
  const s = seeded();
  const m = s.messages.get(F.MARCO).find((x) => x.id === 'M1');
  assert.equal(m.authorName, undefined);
  assert.equal(m.author, undefined);
});

test('ai propri messaggi in gruppo non si attribuisce il nome altrui', () => {
  const s = seeded();
  s.addMessages([F.msg({ key: { remoteJid: F.GROUP, id: 'G9', fromMe: true, participant: F.ME }, pushName: 'io' })]);
  const mine = s.messages.get(F.GROUP).find((m) => m.id === 'G9');
  assert.equal(mine.fromMe, true);
  assert.equal(mine.authorName, undefined);
});

/* ------------------------------------------------------------ elenco chat */

test('l elenco e ordinato dal messaggio piu recente', () => {
  const s = seeded();
  const list = s.chatList();
  const ts = list.filter((c) => c.ts).map((c) => c.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
});

test('le chat fissate restano in cima anche se vecchie', () => {
  const s = seeded();
  s.upsertChats([{ id: F.ANNA, pinned: true }]);
  assert.equal(s.chatList()[0].jid, F.ANNA);
});

test('l elenco distingue contatti e gruppi e conta i partecipanti', () => {
  const s = seeded();
  const list = s.chatList();
  const group = list.find((c) => c.jid === F.GROUP);
  const contact = list.find((c) => c.jid === F.MARCO);
  assert.equal(group.kind, 'group');
  assert.equal(group.participants, 3);
  assert.equal(contact.kind, 'contact');
  assert.equal(contact.participants, 0);
});

test('il silenziamento scaduto non viene segnalato', () => {
  const s = seeded();
  s.upsertChats([{ id: F.MARCO, muteEndTime: F.long(1) }]); // 1970
  assert.equal(s.chatList().find((c) => c.jid === F.MARCO).muted, false);
  assert.equal(s.chatList().find((c) => c.jid === F.ANNA).muted, true);
});

test('un gruppo scoperto solo dai metadati compare comunque in elenco', () => {
  const s = seeded();
  const fam = s.chatList().find((c) => c.jid === F.GROUP2);
  assert.ok(fam, 'il gruppo Famiglia deve essere in elenco');
  assert.equal(fam.name, 'Famiglia');
});

/* ---------------------------------------------------------------- non letti */

test('i non letti crescono e si azzerano all apertura', () => {
  const s = seeded();
  s.bumpUnread(F.GROUP);
  s.bumpUnread(F.GROUP);
  assert.equal(s.chats.get(F.GROUP).unreadCount, 2);
  s.markRead(F.GROUP);
  assert.equal(s.chats.get(F.GROUP).unreadCount, 0);
});

/* ------------------------------------------------------------ deduplicazione */

test('lo stesso messaggio non viene inserito due volte', () => {
  const s = seeded();
  const before = s.messages.get(F.MARCO).length;
  s.addMessages(F.messages);
  assert.equal(s.messages.get(F.MARCO).length, before);
});

test('un reinserimento aggiorna il messaggio esistente', () => {
  const s = seeded();
  s.addMessages([F.msg({ key: { id: 'M2', fromMe: true }, message: { conversation: 'corretto' }, status: 4 })]);
  const m = s.messages.get(F.MARCO).find((x) => x.id === 'M2');
  assert.equal(m.text, 'corretto');
  assert.equal(s.messages.get(F.MARCO).filter((x) => x.id === 'M2').length, 1);
});

test('gli aggiornamenti di stato consegna arrivano al messaggio giusto', () => {
  const s = seeded();
  s.updateMessages([{ key: { remoteJid: F.MARCO, id: 'M2' }, update: { status: 4 } }]);
  assert.equal(s.messages.get(F.MARCO).find((m) => m.id === 'M2').status, 4);
});

test('un aggiornamento per una chat sconosciuta non fa esplodere nulla', () => {
  const s = seeded();
  assert.doesNotThrow(() => s.updateMessages([{ key: { remoteJid: 'ignoto@s.whatsapp.net', id: 'Z' }, update: { status: 3 } }]));
});

/* ------------------------------------------------------------ ordinamento */

test('i messaggi restano in ordine cronologico anche se arrivano sparsi', () => {
  const s = fresh();
  s.addMessages([
    F.msg({ key: { id: 'B' }, messageTimestamp: 300 }),
    F.msg({ key: { id: 'A' }, messageTimestamp: 100 }),
    F.msg({ key: { id: 'C' }, messageTimestamp: 200 }),
  ]);
  assert.deepEqual(s.messages.get(F.MARCO).map((m) => m.id), ['A', 'C', 'B']);
});

test('la cronologia per chat e limitata e tiene i messaggi piu recenti', () => {
  const s = fresh();
  const many = Array.from({ length: 420 }, (_, i) =>
    F.msg({ key: { id: `N${i}` }, messageTimestamp: 1000 + i }));
  s.addMessages(many);
  const list = s.messages.get(F.MARCO);
  assert.equal(list.length, 300);
  assert.equal(list[list.length - 1].id, 'N419');
});

/* ------------------------------------------------------------ persistenza */

test('salvataggio e ricarica preservano chat, nomi e messaggi', () => {
  const s = seeded();
  s.save();
  const back = new Store({ file: s.file });
  back.load();
  assert.equal(back.displayName(F.MARCO), 'Marco Bianchi');
  assert.equal(back.displayName(F.GROUP), 'Serata pizza');
  assert.equal(back.resolve(F.LID), '393336667777@s.whatsapp.net');
  assert.deepEqual(back.chatList().map((c) => c.jid), s.chatList().map((c) => c.jid));
  assert.ok(back.messages.get(F.MARCO).length > 0);
});

test('un file di cache corrotto non impedisce l avvio', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ questo non e json');
  const s = new Store({ file });
  assert.doesNotThrow(() => s.load());
  assert.equal(s.chats.size, 0);
});

test('clear cancella memoria e file su disco', () => {
  const s = seeded();
  s.save();
  assert.ok(fs.existsSync(s.file));
  s.clear();
  assert.equal(s.chats.size, 0);
  assert.equal(fs.existsSync(s.file), false);
});

/* ------------------------------------------------------------- robustezza */

test('input malformati non fanno cadere lo store', () => {
  const s = fresh();
  assert.doesNotThrow(() => {
    s.upsertContacts([null, undefined, {}, { id: null }]);
    s.upsertChats([null, {}, { id: undefined }]);
    s.upsertGroups([null, {}]);
    s.addMessages([null, {}, { key: {} }, { key: { id: 'x' } }]);
    s.normalize(null);
    s.normalize({ key: { id: 'y', remoteJid: F.MARCO } }); // nessun campo message
    s.chatList();
  });
});

test('le statistiche contano contatti e gruppi separatamente', () => {
  const s = seeded();
  const st = s.stats();
  assert.equal(st.groups, 2);
  assert.equal(st.contacts, st.chats - st.groups);
  assert.ok(st.contactsKnown >= 4);
});
