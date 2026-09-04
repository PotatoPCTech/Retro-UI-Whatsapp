'use strict';

/** Payload nella forma esatta in cui Baileys li emette. */

const ME = '393401110000@s.whatsapp.net';
const MARCO = '393331112222@s.whatsapp.net';
const ANNA = '393334445555@s.whatsapp.net';
const LID = '101112131415@lid';
const GROUP = '120363000000000001@g.us';
const GROUP2 = '120363000000000002@g.us';
const BROADCAST = 'status@broadcast';
const NEWSLETTER = '120363111111111111@newsletter';

/** i timestamp arrivano spesso come Long protobuf, non come numeri */
const long = (n) => ({ low: n, high: 0, unsigned: false });

const contacts = [
  { id: MARCO, name: 'Marco Bianchi', notify: 'Marco' },
  { id: ANNA, notify: 'Anna' },
  { id: LID, lid: LID, phoneNumber: '393336667777@s.whatsapp.net', notify: 'Giulia' },
  { id: '393339990000@s.whatsapp.net' },
];

const chats = [
  { id: MARCO, conversationTimestamp: long(1_700_000_500), unreadCount: 2 },
  { id: GROUP, name: 'Serata pizza', conversationTimestamp: long(1_700_000_400), unreadCount: 0 },
  { id: ANNA, conversationTimestamp: long(1_700_000_300), unreadCount: 0, muteEndTime: long(9_999_999_999) },
  { id: BROADCAST, conversationTimestamp: long(1_700_000_999) },
  { id: NEWSLETTER, conversationTimestamp: long(1_700_000_998) },
];

const groups = [
  {
    id: GROUP, subject: 'Serata pizza', desc: 'LAN party ricorrente',
    participants: [{ id: ME }, { id: MARCO }, { id: ANNA }],
  },
  { id: GROUP2, subject: 'Famiglia', participants: [{ id: ME }, { id: ANNA }] },
];

const msg = (over = {}) => ({
  key: { remoteJid: MARCO, fromMe: false, id: 'AAA1', ...(over.key || {}) },
  messageTimestamp: over.messageTimestamp ?? long(1_700_000_100),
  pushName: over.pushName,
  status: over.status,
  message: over.message ?? { conversation: 'ciao' },
  participant: over.participant,
});

const messages = [
  msg({ key: { id: 'M1' }, messageTimestamp: long(1_700_000_100), message: { conversation: 'ci vediamo alle 21' }, pushName: 'Marco' }),
  msg({ key: { id: 'M2', fromMe: true }, messageTimestamp: long(1_700_000_200), message: { extendedTextMessage: { text: 'perfetto' } }, status: 3 }),
  msg({
    key: { remoteJid: GROUP, id: 'G1', participant: ANNA }, pushName: 'Anna',
    messageTimestamp: long(1_700_000_400),
    message: { imageMessage: { caption: 'guardate che setup', mimetype: 'image/jpeg' } },
  }),
  msg({
    key: { remoteJid: GROUP, id: 'G2', participant: MARCO }, pushName: 'Marco Bianchi',
    messageTimestamp: long(1_700_000_350),
    message: { audioMessage: { ptt: true, seconds: 37, mimetype: 'audio/ogg' } },
  }),
  msg({ key: { remoteJid: BROADCAST, id: 'B1' }, message: { conversation: 'stato da ignorare' } }),
  msg({ key: { remoteJid: NEWSLETTER, id: 'N1' }, message: { conversation: 'canale da ignorare' } }),
  msg({ key: { id: 'P1' }, message: { protocolMessage: { type: 0 } } }),
];

/** un messaggio per ogni tipo che l'interfaccia deve saper etichettare */
const everyType = {
  text_plain:  { conversation: 'testo semplice' },
  text_ext:    { extendedTextMessage: { text: 'testo esteso' } },
  image:       { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } },
  video:       { videoMessage: { caption: 'clip', mimetype: 'video/mp4' } },
  gif:         { videoMessage: { gifPlayback: true, mimetype: 'video/mp4' } },
  audio:       { audioMessage: { seconds: 12, mimetype: 'audio/mp4' } },
  ptt:         { audioMessage: { ptt: true, seconds: 5, mimetype: 'audio/ogg' } },
  sticker:     { stickerMessage: { mimetype: 'image/webp' } },
  document:    { documentMessage: { fileName: 'preventivo.pdf', mimetype: 'application/pdf' } },
  doc_caption: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'nota.docx' } } } },
  location:    { locationMessage: { name: 'Piazza Duomo', degreesLatitude: 45.4, degreesLongitude: 9.1 } },
  live_loc:    { liveLocationMessage: { degreesLatitude: 45.4 } },
  contact:     { contactMessage: { displayName: 'Idraulico' } },
  contacts:    { contactsArrayMessage: { contacts: [{}, {}, {}] } },
  poll:        { pollCreationMessageV3: { name: 'Che pizza?' } },
  reaction:    { reactionMessage: { text: '👍' } },
  ephemeral:   { ephemeralMessage: { message: { conversation: 'effimero' } } },
  viewonce:    { viewOnceMessageV2: { message: { imageMessage: { caption: 'una volta sola' } } } },
  quoted: {
    extendedTextMessage: {
      text: 'rispondo',
      contextInfo: { participant: MARCO, quotedMessage: { conversation: 'domanda originale' } },
    },
  },
};

module.exports = {
  ME, MARCO, ANNA, LID, GROUP, GROUP2, BROADCAST, NEWSLETTER,
  long, contacts, chats, groups, messages, msg, everyType,
};
