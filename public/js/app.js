/* =========================================================================
   CRT-WA :: logica di interfaccia
   ========================================================================= */
'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), bootLog: $('bootLog'), app: $('app'), led: $('led'),
  clock: $('clock'), meName: $('meName'),
  search: $('search'), tabs: $('tabs'), chatList: $('chatList'),
  chatCount: $('chatCount'), sideFoot: $('sideFoot'),
  convName: $('convName'), convSub: $('convSub'), convKind: $('convKind'),
  convAvatar: $('convAvatar'), messages: $('messages'), placeholder: $('placeholder'),
  typing: $('typing'), composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'),
  stState: $('stState'), stChats: $('stChats'), stGroups: $('stGroups'),
  stContacts: $('stContacts'), stMsg: $('stMsg'),
  qrOverlay: $('qrOverlay'), qrImg: $('qrImg'), qrFoot: $('qrFoot'),
  waitOverlay: $('waitOverlay'), waitTitle: $('waitTitle'), waitMsg: $('waitMsg'),
  btnPhosphor: $('btnPhosphor'), btnRefresh: $('btnRefresh'), btnLogout: $('btnLogout'),
};

const state = {
  chats: [], filter: 'all', query: '', current: null,
  messages: [], connection: 'offline', booted: false,
};

/* ----------------------------------------------------------------- utili */

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hhmm(ts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'ieri';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'OGGI';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'IERI';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function initials(name) {
  const clean = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const STATUS_TAG = { 0: '[..]', 1: '[..]', 2: '[->]', 3: '[>>]', 4: '[OK]', 5: '[OK]' };
const TYPE_TAG = {
  image: '[IMMAGINE]', video: '[VIDEO]', gif: '[GIF]', audio: '[AUDIO]',
  ptt: '[MESSAGGIO VOCALE]', sticker: '[STICKER]', document: '[DOCUMENTO]',
  location: '[POSIZIONE]', contact: '[CONTATTO]', poll: '[SONDAGGIO]',
  reaction: '[REAZIONE]',
};

/* ------------------------------------------------------------------ boot */

const BOOT_LINES = [
  'SANYODYNE DM-1400  --  BIOS rev 2.14',
  'Copyright (C) 1997 Sanyodyne Display Systems',
  '',
  'Test memoria video ............ 512 KB  OK',
  'Rilevamento porta seriale ..... COM1 38400 8N1',
  'Caricamento driver fosforo .... P31 verde  OK',
  'Sincronismo verticale ......... 50 Hz stabile',
  '',
  'CRT-WA  terminale di messaggistica  rev 1.0',
  'Inizializzazione stack di rete ... attendere',
  '',
  'Pronto.',
];

async function playBoot() {
  const skip = sessionStorage.getItem('crtwa-booted');
  if (skip) { el.boot.classList.add('hidden'); el.app.classList.remove('hidden'); state.booted = true; return; }

  let text = '';
  for (const line of BOOT_LINES) {
    for (const ch of line) {
      text += ch;
      el.bootLog.textContent = text + '█';
      await sleep(line.startsWith('  ') ? 4 : 7);
    }
    text += '\n';
    el.bootLog.textContent = text + '█';
    await sleep(line === '' ? 40 : 110);
  }
  await sleep(400);
  sessionStorage.setItem('crtwa-booted', '1');
  el.boot.classList.add('hidden');
  el.app.classList.remove('hidden');
  state.booted = true;
  applyConnectionUI();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- orologio */

setInterval(() => {
  const d = new Date();
  el.clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}, 1000);

/* ------------------------------------------------------------- socket.io */

const socket = io();

socket.on('connect', () => setTicker('canale con il server aperto'));
socket.on('disconnect', () => {
  state.connection = 'offline';
  setTicker('server locale non raggiungibile');
  applyConnectionUI();
});

socket.on('snapshot', (snap) => {
  state.connection = snap.state;
  if (snap.qr) showQR(snap.qr);
  if (snap.me) el.meName.textContent = snap.me.name || '--';
  renderStats(snap.stats);
  state.chats = snap.chats || [];
  renderChats();
  applyConnectionUI();
});

socket.on('status', ({ state: st, message, me, stats }) => {
  state.connection = st;
  if (me) el.meName.textContent = me.name || '--';
  if (stats) renderStats(stats);
  if (message) setTicker(message);
  applyConnectionUI();
});

socket.on('qr', (dataUrl) => { state.connection = 'qr'; showQR(dataUrl); applyConnectionUI(); });

socket.on('ready', (me) => {
  el.meName.textContent = me?.name || '--';
  setTicker('collegato: cronologia in arrivo');
});

socket.on('chats', (chats) => { state.chats = chats; renderChats(); });

socket.on('message', (msg) => {
  if (msg.jid === state.current?.jid) {
    const i = state.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) state.messages[i] = msg; else state.messages.push(msg);
    renderMessages(true);
    if (!msg.fromMe) socket.emit('open', msg.jid, () => {});
  } else if (!msg.fromMe) {
    setTicker(`nuovo messaggio da ${nameOf(msg.jid)}`);
  }
});

socket.on('messages-updated', (jid) => {
  if (jid !== state.current?.jid) return;
  socket.emit('open', jid, (data) => {
    if (data?.messages) { state.messages = data.messages; renderMessages(false); }
  });
});

let typingTimer = null;
socket.on('presence', ({ jid, presence }) => {
  if (jid !== state.current?.jid) return;
  clearTimeout(typingTimer);
  if (presence === 'composing') {
    el.typing.textContent = '>> sta scrivendo...';
    typingTimer = setTimeout(() => (el.typing.textContent = ''), 6000);
  } else if (presence === 'recording') {
    el.typing.textContent = '>> sta registrando un vocale...';
    typingTimer = setTimeout(() => (el.typing.textContent = ''), 6000);
  } else {
    el.typing.textContent = presence === 'available' ? '-- online' : '';
  }
});

/* ------------------------------------------------------------ stato / UI */

function setTicker(text) { el.stMsg.textContent = text; }

function renderStats(s) {
  if (!s) return;
  el.stChats.textContent = `CHAT: ${s.chats}`;
  el.stGroups.textContent = `GRUPPI: ${s.groups}`;
  el.stContacts.textContent = `RUBRICA: ${s.contactsKnown}`;
}

function applyConnectionUI() {
  const map = {
    offline:    ['STATO: OFFLINE',     'err'],
    connecting: ['STATO: CONNESSIONE', 'warn'],
    qr:         ['STATO: ATTESA QR',   'warn'],
    connected:  ['STATO: IN LINEA',    'on'],
  };
  const [label, led] = map[state.connection] || map.offline;
  el.stState.textContent = label;
  el.led.className = `led ${led}`;

  if (!state.booted) return;
  const showQr = state.connection === 'qr';
  const showWait = state.connection === 'connecting' || (state.connection === 'offline' && !state.chats.length);
  el.qrOverlay.classList.toggle('hidden', !showQr);
  el.waitOverlay.classList.toggle('hidden', showQr || !showWait);
  el.waitTitle.textContent = state.connection === 'offline' ? 'NESSUN COLLEGAMENTO' : 'CONNESSIONE IN CORSO';
  el.waitMsg.innerHTML = `${esc(el.stMsg.textContent)}<span class="blink">_</span>`;

  const live = state.connection === 'connected' && !!state.current;
  el.input.disabled = !live;
  el.sendBtn.disabled = !live;
}

function showQR(dataUrl) {
  el.qrImg.src = dataUrl;
  el.qrFoot.innerHTML = 'in attesa di scansione<span class="blink">_</span>';
}

/* --------------------------------------------------------- elenco chat */

function nameOf(jid) {
  return state.chats.find((c) => c.jid === jid)?.name || jid.split('@')[0];
}

function visibleChats() {
  const q = state.query.trim().toLowerCase();
  return state.chats.filter((c) => {
    if (state.filter === 'group' && c.kind !== 'group') return false;
    if (state.filter === 'contact' && c.kind !== 'contact') return false;
    if (state.filter === 'unread' && !c.unread) return false;
    if (q && !(`${c.name} ${c.preview}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderChats() {
  const list = visibleChats();
  el.chatCount.textContent = list.length;
  el.chatList.innerHTML = list.map((c) => `
    <li class="chat-item${c.jid === state.current?.jid ? ' active' : ''}" data-jid="${esc(c.jid)}">
      <span class="ci-sigil">${c.kind === 'group' ? '##' : '&gt;&gt;'}</span>
      <span class="ci-name">${esc(c.name)}${c.pinned ? ' *' : ''}${c.muted ? ' ~' : ''}</span>
      <span class="ci-time">${shortTime(c.ts)}</span>
      <span class="ci-preview">${c.lastFromMe ? 'io: ' : ''}${esc(c.preview) || '&nbsp;'}</span>
      ${c.unread ? `<span class="ci-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </li>`).join('') || '<li class="panel-foot">nessuna voce corrisponde</li>';

  const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
  el.sideFoot.textContent = `${state.chats.length} canali indicizzati / ${unread} non letti`;
}

el.chatList.addEventListener('click', (e) => {
  const li = e.target.closest('.chat-item');
  if (li) openChat(li.dataset.jid);
});

el.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  [...el.tabs.children].forEach((t) => t.classList.toggle('active', t === tab));
  state.filter = tab.dataset.filter;
  renderChats();
});

el.search.addEventListener('input', () => { state.query = el.search.value; renderChats(); });

/* -------------------------------------------------------- conversazione */

function openChat(jid) {
  socket.emit('open', jid, (data) => {
    if (!data || data.error) return setTicker(`errore apertura: ${data?.error || 'ignoto'}`);
    state.current = data.info;
    state.messages = data.messages || [];
    el.convName.textContent = data.info.name.toUpperCase();
    el.convSub.textContent = data.info.subtitle || '';
    el.convKind.textContent = data.info.kind === 'group' ? '[ GRUPPO ]' : '[ CONTATTO ]';
    el.convAvatar.textContent = initials(data.info.name);
    el.typing.textContent = '';
    renderMessages(true);
    renderChats();
    applyConnectionUI();
    el.input.focus();
  });
}

function renderMessages(scroll) {
  el.placeholder?.remove();
  if (!state.messages.length) {
    el.messages.innerHTML = '<div class="placeholder"><pre>-- nessun messaggio in cache per questo canale --</pre></div>';
    return;
  }

  let html = '';
  let lastDay = '';
  for (const m of state.messages) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) { html += `<div class="daysep">${day}</div>`; lastDay = day; }
    html += renderMessage(m);
  }
  el.messages.innerHTML = html;
  if (scroll !== false) el.messages.scrollTop = el.messages.scrollHeight;
}

function renderMessage(m) {
  const tag = TYPE_TAG[m.type];
  const body = [];

  if (m.quoted) {
    body.push(`<div class="msg-quote">| ${esc(m.quoted.author)}: ${esc((m.quoted.text || '').slice(0, 140))}</div>`);
  }
  if (tag) {
    const secs = m.seconds ? ` ${Math.floor(m.seconds / 60)}:${pad(m.seconds % 60)}` : '';
    body.push(`<span class="msg-tag">${tag}${secs}</span>`);
  }
  if (m.text) body.push(esc(m.text));
  if (m.type === 'image' || m.type === 'sticker') {
    body.push(`<img class="msg-media" loading="lazy" alt="allegato"
      src="/api/media/${encodeURIComponent(m.jid)}/${encodeURIComponent(m.id)}"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'msg-tag',textContent:'[ALLEGATO NON PIU\\' DISPONIBILE]'}))">`);
  }
  if (!body.length) body.push(`<span class="msg-tag">[${esc(m.type.toUpperCase())}]</span>`);

  const author = m.authorName ? `<span class="msg-author">${esc(m.authorName)}</span>` : (m.fromMe ? '<span class="msg-author">io</span>' : '');
  const status = m.fromMe ? `<span class="msg-status">${STATUS_TAG[m.status] || '[..]'}</span>` : '';

  return `<div class="msg ${m.fromMe ? 'out' : 'in'}">
    <div class="msg-head">${author}<span>${hhmm(m.ts)}</span>${status}</div>
    <div class="msg-body">${body.join('\n')}</div>
  </div>`;
}

/* ------------------------------------------------------------- invio */

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.input.value;
  if (!text.trim() || !state.current) return;
  const jid = state.current.jid;
  el.input.value = '';
  autoGrow();
  socket.emit('send', { jid, text }, (res) => {
    if (res?.error) { setTicker(`invio fallito: ${res.error}`); el.input.value = text; }
    else if (res?.msg && jid === state.current?.jid) {
      if (!state.messages.some((m) => m.id === res.msg.id)) state.messages.push(res.msg);
      renderMessages(true);
    }
  });
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.composer.requestSubmit(); }
});

let typingSent = 0;
el.input.addEventListener('input', () => {
  autoGrow();
  const now = Date.now();
  if (state.current && now - typingSent > 3000) {
    typingSent = now;
    socket.emit('typing', { jid: state.current.jid, on: true });
  }
});

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 96) + 'px';
}

/* ----------------------------------------------------------- comandi */

const PHOSPHORS = ['green', 'amber', 'ice'];
el.btnPhosphor.addEventListener('click', () => {
  const cur = document.documentElement.dataset.phosphor;
  const next = PHOSPHORS[(PHOSPHORS.indexOf(cur) + 1) % PHOSPHORS.length];
  document.documentElement.dataset.phosphor = next;
  localStorage.setItem('crtwa-phosphor', next);
  setTicker(`fosforo impostato su ${next}`);
});

el.btnRefresh.addEventListener('click', () => { socket.emit('refresh'); setTicker('richiesta rilettura elenco'); });

el.btnLogout.addEventListener('click', () => {
  if (!confirm('Scollegare questo dispositivo e cancellare la cache locale?')) return;
  socket.emit('logout');
  state.chats = []; state.current = null; state.messages = [];
  renderChats(); renderMessages();
  el.convName.textContent = 'NESSUN CANALE SELEZIONATO';
  el.convSub.textContent = 'seleziona una voce dalla directory';
  setTicker('disconnessione richiesta');
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== el.input && document.activeElement !== el.search) {
    e.preventDefault(); el.search.focus();
  }
  if (e.key === 'Escape') { el.search.value = ''; state.query = ''; renderChats(); el.input.blur(); }
});

/* ------------------------------------------------------------- avvio */

const saved = localStorage.getItem('crtwa-phosphor');
if (saved && PHOSPHORS.includes(saved)) document.documentElement.dataset.phosphor = saved;

playBoot();
