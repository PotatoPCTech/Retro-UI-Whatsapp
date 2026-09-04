'use strict';

const { createServer } = require('./lib/app');
const { WhatsAppClient } = require('./lib/whatsapp');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const wa = new WhatsAppClient();
const { server } = createServer(wa);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [!] la porta ${PORT} su ${HOST} e' gia' occupata.`);
    console.error('');
    console.error("      Molto probabilmente e' rimasta accesa un'altra istanza di CRT-WA.");
    console.error('      Per vedere chi la sta usando:');
    console.error(`        ss -ltnp | grep :${PORT}`);
    console.error('      Per chiudere la vecchia istanza:');
    console.error('        pkill -f "node server.js"');
    console.error("      Oppure avvia su un'altra porta:");
    console.error(`        PORT=${PORT + 1} npm start`);
    console.error('');
  } else if (err.code === 'EACCES') {
    console.error(`\n  [!] permessi insufficienti per la porta ${PORT}.`);
    console.error('      Sotto la 1024 servono privilegi di root: usa PORT=3000 o simili.\n');
  } else {
    console.error(`\n  [!] impossibile avviare il server: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  +--------------------------------------------------+');
  console.log('  |  CRT-WA  ::  terminale WhatsApp  ::  rev 1.0      |');
  console.log('  +--------------------------------------------------+');
  console.log(`  >> interfaccia pronta su  http://${HOST}:${PORT}`);
  console.log('  >> apri il browser e inquadra il QR con il telefono');
  console.log('');
  wa.connect().catch((e) => console.error('[wa] avvio fallito:', e.message));
});

const shutdown = () => {
  console.log('\n  >> spegnimento, salvataggio cache...');
  wa.store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('[!] promise:', e?.message || e));
