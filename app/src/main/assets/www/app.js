'use strict';
/* ============ NearCall UI v2: chats, photos, voice notes, channels, SOS, locate, lock, settings ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rnd = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---- native bridge (harmless mock when previewed in a desktop browser) ---- */
const MOCK = {
  hasPerms: () => true, hasMic: () => true, requestPerms() { setTimeout(() => window.onPerms && onPerms(true), 50); },
  start: () => true, stop() {}, isRunning: () => true, snapshot() {}, drain: () => '[]', callState: () => '{"state":"idle"}',
  netInfo: () => '{"neighbors":[],"peers":0,"relayed":0,"stored":0,"battery":100,"relay":true,"relayOn":true,"lan":true,"id":"mock"}',
  send() {}, sendFile() {}, joinChannel() {}, leaveChannel() {}, sendChannel() {}, sos() {}, ping() {}, block() {}, trust() {},
  call() {}, accept() {}, reject() {}, end() {}, mute() {}, speaker() {},
  vnStart: () => true, vnStop: () => '{"ok":true,"id":"mockvn","dur":3}', vnCancel() {}, vnPlay() {}, vnStopPlay() {}, pickImage() {},
  setRelay() {}, setLan() {}, setContactsOnly() {}, setAllowed() {}, setBt() {}, reconnect() {}, setNearby() {}, openBluetooth() {}, setNotify() {}, secure() {}, copy() {}, backup() {}, restore() {}, shareApk() {},
  openHotspot() {}, openWifi() {}, batteryOk: () => true, batterySettings() {}, getInsets: () => '0,0,0,0'
};
const N = window.AndroidNative || MOCK;
const IOS = N.platform === 'ios';
if (IOS) document.documentElement.classList.add('ios');
const iosOnly = () => toast(tr('Not available on iPhone yet', 'آئی فون پر ابھی دستیاب نہیں'));

/* ---- storage ---- */
const KEY = 'nc:v2';
const DEF = () => ({ me: null, lang: 'en', theme: 'auto', contacts: {}, chats: {}, ch: {}, unread: {}, calls: [], names: {}, avs: {},
  muted: {}, blocked: {}, quiet: { on: false, s: 22, e: 7 }, relay: true, lan: true, btl: true, nbl: true, onlyKnown: true, hideUnknown: false, contactsOnly: false, prevPriv: null, mode: 'bt', cts: null, pin: '', salt: '' });
let DB = Object.assign(DEF(), (() => {
  try { return JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('nc:v1') || '{}'); } catch (e) { return {}; }
})());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) {} };
/* two separate sections: Bluetooth and Wi-Fi / hotspot, each with its own contacts, chats and call log */
if (!DB.cts) DB.cts = { bt: Object.assign({}, DB.contacts || {}), wifi: Object.assign({}, DB.contacts || {}) };
if (DB.mode !== 'bt' && DB.mode !== 'wifi') DB.mode = 'bt';
if (typeof IOS !== 'undefined' && IOS) DB.mode = 'wifi';
const CT = m => DB.cts[m || DB.mode];
const MV = { bt: 'Bluetooth', wifi: 'Wi-Fi', both: 'Bluetooth + Wi-Fi' };
const otherOf = m => (m === 'wifi' ? 'bt' : 'wifi');
/* a number is "known" once it is saved as a contact in either section */
const isSaved = n => !!(DB.cts.bt[n] || DB.cts.wifi[n]);
const savedNums = () => Object.keys(Object.assign({}, DB.cts.bt, DB.cts.wifi));

/* ---- Contacts-only mode: the app and the mesh engine both refuse anything that involves an unsaved number ---- */
function canContact(n) { return !DB.contactsOnly || isSaved(n); }
function syncAllowed() {
  try { N.setAllowed(JSON.stringify(savedNums())); N.setContactsOnly(!!DB.contactsOnly); } catch (e) {}
}
function unsavedSheet(num, what) {
  const w = { message: tr('message', 'پیغام'), call: tr('call', 'کال'), 'voice note': tr('send voice notes to', 'وائس نوٹ بھیجیں'), photo: tr('send photos to', 'تصویر بھیجیں') };
  openSheet('<h3>🛡 ' + tr('Not in your contacts', 'آپ کے رابطوں میں نہیں') + '</h3><p class="hint">' +
    tr('Contacts-only mode is on. Save ', 'صرف رابطے موڈ آن ہے۔ ') + '<b style="direction:ltr;unicode-bidi:embed">' + esc(num) + '</b>' +
    tr(' as a contact to ' + (what === 'message' ? 'message' : what === 'call' ? 'call' : 'contact') + ' this number.', ' کو رابطے کے طور پر محفوظ کریں تاکہ آپ اس سے رابطہ کر سکیں۔') + '</p>' +
    '<div class="btnrow"><button class="btn grow" data-a="savenum" data-v="' + esc(num) + '">' + tr('Save contact', 'رابطہ محفوظ کریں') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}
function conlySheet() {
  const n = savedNums().length;
  openSheet('<h3>🛡 ' + tr('Turn on Contacts-only mode?', 'صرف رابطے موڈ آن کریں؟') + '</h3>' +
    '<div class="kv"><span>✓ ' + tr('You can message, send photos and voice notes, and call only saved numbers', 'آپ صرف محفوظ نمبروں کو پیغام، تصویر، وائس نوٹ اور کال کر سکتے ہیں') + '</span></div>' +
    '<div class="kv"><span>✓ ' + tr('Messages, files and calls from other numbers are dropped silently: not shown, not stored, no notification', 'دوسرے نمبروں کے پیغام، فائلیں اور کالیں خاموشی سے ختم کر دی جاتی ہیں: نہ دکھتی ہیں، نہ محفوظ ہوتی ہیں، نہ اطلاع آتی ہے') + '</span></div>' +
    '<div class="kv"><span>✓ ' + tr('Unknown phones disappear from People and Chats', 'نامعلوم فون لوگ اور چیٹس سے غائب ہو جاتے ہیں') + '</span></div>' +
    '<div class="kv"><span>' + tr('Saved contacts', 'محفوظ رابطے') + '</span><b>' + n + '</b></div>' +
    (n ? '' : '<p class="warn">' + tr('You have no saved contacts yet, so nobody can reach you until you save some.', 'آپ نے ابھی کوئی رابطہ محفوظ نہیں کیا، اس لیے کچھ رابطے محفوظ کرنے تک کوئی آپ سے رابطہ نہیں کر سکے گا۔') + '</p>') +
    '<div class="btnrow"><button class="btn grow" data-a="conlyyes">' + tr('Turn on', 'آن کریں') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}
function enableConly() {
  DB.prevPriv = { onlyKnown: DB.onlyKnown, hideUnknown: DB.hideUnknown };
  DB.onlyKnown = true; DB.hideUnknown = true; DB.contactsOnly = true;
  save(); syncAllowed(); closeSheet(); render();
  toast(tr('Contacts-only mode is on', 'صرف رابطے موڈ آن ہو گیا'));
}
function disableConly() {
  const p = DB.prevPriv || { onlyKnown: true, hideUnknown: false };
  DB.contactsOnly = false; DB.onlyKnown = p.onlyKnown; DB.hideUnknown = p.hideUnknown; DB.prevPriv = null;
  save(); syncAllowed(); render();
  toast(tr('Contacts-only mode is off', 'صرف رابطے موڈ بند ہو گیا'));
}
function toggleConly(el) {
  if (el.checked) { el.checked = false; conlySheet(); } else disableConly();
}

const tr = (en, ur) => DB.lang === 'ur' ? ur : en;
function applyLang() { document.documentElement.lang = DB.lang; document.documentElement.dir = DB.lang === 'ur' ? 'rtl' : 'ltr'; }
function applyTheme() { if (DB.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', DB.theme); }

/* ---- state ---- */
const ui = { tab: 'chats', chat: null, dial: '', call: null, callDir: '', mute: false, spk: false, perm: true, pendCall: null, tm: null,
  rec: null, rt: null, reply: null, playing: '', locate: null, conf: {}, draft: '', imgTo: '', lk: '', pausedAt: 0, locked: false };
let PEERS = [], NEAR = 0, RUN = false, LOWBATT = false, LINK = { bt: 0, wifi: 0 };
let rq = 0;
function scheduleRender() { if (rq) return; rq = setTimeout(() => { rq = 0; if (!ui.chat) render(); }, 250); }

const PAL = ['#0E7C66', '#2F6FDE', '#B4358A', '#D9822B', '#7B52D6', '#C2433F', '#2A8FA6', '#5E7A1F'];
const hashNum = n => { let x = 0; for (let i = 0; i < n.length; i++) x = (x * 31 + n.charCodeAt(i)) >>> 0; return x; };
const colorOf = n => PAL[(Number.isInteger(DB.avs[n]) ? DB.avs[n] : hashNum(String(n))) % PAL.length];
const nameOf = n => (CT()[n] && CT()[n].name) || (DB.cts.bt[n] && DB.cts.bt[n].name) || (DB.cts.wifi[n] && DB.cts.wifi[n].name) || DB.names[n] || n;
const isCh = k => typeof k === 'string' && k.charAt(0) === '#';
const chName = k => k.slice(1);
const viaOf = m => (m && m.via === 'wifi' ? 'wifi' : 'bt');
const ukey = (k, via) => isCh(k) ? k : (via || DB.mode) + ':' + k;
const unreadMode = m => Object.keys(DB.unread).filter(k => k.indexOf(m + ':') === 0).reduce((a, k) => a + (DB.unread[k] || 0), 0);
const initial = n => { const s = nameOf(n); return /^\d+$/.test(s) ? s.slice(-2) : (s.trim().charAt(0) || '?').toUpperCase(); };
const avatar = (n, cls) => isCh(n)
  ? '<div class="av ' + (cls || '') + '" style="background:' + PAL[hashNum(n) % PAL.length] + '">#</div>'
  : '<div class="av ' + (cls || '') + '" style="background:' + colorOf(n) + '">' + esc(initial(n)) + '</div>';
function fmtT(ts) {
  const d = new Date(ts), n = new Date(), p = x => String(x).padStart(2, '0');
  return d.toDateString() === n.toDateString() ? p(d.getHours()) + ':' + p(d.getMinutes()) : p(d.getDate()) + '/' + p(d.getMonth() + 1);
}
const fmtDur = s => { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2800); }
const title = k => isCh(k) ? '#' + chName(k) : nameOf(k);

/* ---- icons ---- */
const IC = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>',
  dial: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-2.7 0-8 1.34-8 4v2h16v-2c0-2.66-5.3-4-8-4z"/></svg>',
  hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 00-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0014 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 00-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z"/></svg>',
  spk: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06a9 9 0 000-17.54z"/></svg>',
  bs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z"/><path d="M18 9l-6 6M12 9l6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 115.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 00-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>'
};

/* ---- data helpers ---- */
function thread(k) { return isCh(k) ? (DB.ch[chName(k)] || (DB.ch[chName(k)] = [])) : (DB.chats[k] || (DB.chats[k] = [])); }
function addMsg(k, m) { const a = thread(k); a.push(m); if (a.length > 500) a.splice(0, a.length - 500); }
const viewOf = k => isCh(k) ? thread(k) : thread(k).filter(m => viaOf(m) === DB.mode);
const lastOf = (k, via) => { const a = isCh(k) ? DB.ch[chName(k)] : (DB.chats[k] || []).filter(m => viaOf(m) === (via || DB.mode)); return a && a[a.length - 1]; };
const totalUnread = () => Object.values(DB.unread).reduce((a, b) => a + (b || 0), 0);
const peerFor = n => PEERS.find(p => p.num === n);
function hopTxt(p) {
  if (!p.near) return p.hp + ' ' + tr(p.hp === 1 ? 'hop' : 'hops', 'ہاپ');
  const via = [p.bt ? 'Bluetooth' : '', p.wifi ? 'Wi-Fi' : ''].filter(Boolean).join(' + ');
  return tr('Direct', 'براہ راست') + (via ? ' · ' + via : '');
}
function linkState(p) {
  if (!p) return tr('not in range now', 'ابھی رینج میں نہیں');
  const f = (conn, any) => conn ? '✓' : (any ? '…' : '✗');
  return '🔵 ' + f(p.btc, p.bt) + ' · 📶 ' + f(p.wfc, p.wifi) + (p.near ? '' : ' · ' + p.hp + ' ' + tr('hops', 'ہاپ'));
}
function reach(p) {
  if (!p) return tr('not in range now', 'ابھی رینج میں نہیں');
  const here = DB.mode === 'wifi' ? p.wifi : p.bt, alt = DB.mode === 'wifi' ? p.bt : p.wifi;
  if (here || !alt) return hopTxt(p);
  return tr('reachable over ', 'دستیاب بذریعہ ') + MV[otherOf(DB.mode)] + ' · ' + tr('auto-switch', 'آٹو سوئچ');
}
/* send again everything that is still waiting for this number (used after "Trust new device") */
function resendPending(num) {
  (DB.chats[num] || []).forEach(m => {
    if (m.me && (m.st || 0) < 2) {
      if (m.k) N.sendFile(num, m.mid, m.k, m.dur || 0, viaOf(m));
      else N.send(num, m.mid, m.t, m.rp ? JSON.stringify(m.rp) : '', viaOf(m));
    }
  });
}
function eachMsg(cb) {
  for (const n in DB.chats) for (const m of DB.chats[n]) cb(m);
  for (const n in DB.ch) for (const m of DB.ch[n]) cb(m);
}
function syncNotify() {
  try { N.setNotify(JSON.stringify({ muted: Object.keys(DB.muted).filter(k => DB.muted[k]), qon: !!DB.quiet.on, qs: DB.quiet.s, qe: DB.quiet.e })); } catch (e) {}
}
const snippet = m => m.k === 'img' ? '📷 ' + tr('Photo', 'تصویر') : m.k === 'vn' ? '🎤 ' + tr('Voice note', 'وائس نوٹ') : (m.t || '').slice(0, 60);

/* ---- events from the native mesh ---- */
window.onMesh = function (ev) {
  if (!ev || !ev.k) return;
  switch (ev.k) {
    case 'peers':
      PEERS = ev.list || []; NEAR = ev.n || 0; RUN = true; LOWBATT = !!ev.lowBatt; LINK = { bt: ev.nbt || 0, wifi: ev.nwf || 0 };
      PEERS.forEach(p => { if (p.name) DB.names[p.num] = p.name; if (Number.isInteger(p.av)) DB.avs[p.num] = p.av; if (p.conflict) ui.conf[p.num] = true; });
      save();
      scheduleRender();
      if (ui.locate && document.getElementById('sheet').classList.contains('on')) renderLocate();
      break;
    case 'status':
      RUN = !!ev.running; if (!RUN) { PEERS = []; NEAR = 0; }
      if (!ui.chat) render();
      break;
    case 'msg':
      if (DB.blocked[ev.from] || (DB.hideUnknown && !isSaved(ev.from))) break;
      if (ev.name) DB.names[ev.from] = ev.name;
      addMsg(ev.from, { mid: ev.mid, me: false, t: ev.text, ts: ev.ts || Date.now(), rp: ev.rp || null, via: ev.via === 'wifi' ? 'wifi' : 'bt' });
      incoming(ev.from, ev.via === 'wifi' ? 'wifi' : 'bt');
      break;
    case 'blob':
      if (DB.blocked[ev.from] || (DB.hideUnknown && !isSaved(ev.from))) break;
      if (ev.name) DB.names[ev.from] = ev.name;
      addMsg(ev.from, { mid: ev.mid, me: false, k: ev.kind, dur: ev.dur || 0, t: '', ts: ev.ts || Date.now(), via: ev.via === 'wifi' ? 'wifi' : 'bt' });
      incoming(ev.from, ev.via === 'wifi' ? 'wifi' : 'bt');
      break;
    case 'chmsg': {
      if (!DB.ch[ev.ch]) DB.ch[ev.ch] = [];
      addMsg('#' + ev.ch, { mid: ev.mid, me: false, who: ev.name || ev.from, t: ev.text, ts: ev.ts || Date.now() });
      incoming('#' + ev.ch);
      break;
    }
    case 'ack': case 'relayed': {
      const st = ev.k === 'ack' ? 2 : 1;
      eachMsg(m => { if (m.me && m.mid === ev.mid) { if ((m.st || 0) < st) m.st = st; if (ev.via) m.u = ev.via; } });
      save();
      if (ui.chat) updateMsgs();
      break;
    }
    case 'call': handleCall(ev); break;
    case 'calllink':
      if (ui.call) { ui.call.via = ev.via; renderCall(); toast(tr('Call is now using ', 'کال اب استعمال کر رہی ہے ') + (MV[ev.via] || ev.via)); }
      break;
    case 'missed':
      if (DB.hideUnknown && !isSaved(ev.num)) break;
      DB.calls.unshift({ num: ev.num, dir: 'missed', ts: ev.ts || Date.now(), dur: 0, via: ev.via === 'wifi' ? 'wifi' : 'bt' });
      DB.calls.length = Math.min(DB.calls.length, 60);
      if (ev.name) DB.names[ev.num] = ev.name;
      save();
      toast(tr('Missed call from ', 'مس کال از ') + nameOf(ev.num));
      if (!ui.chat) render();
      break;
    case 'trusted': resendPending(ev.num); break;
    case 'denied': toast(tr('Contacts-only mode: save this number first', 'صرف رابطے موڈ: پہلے یہ نمبر محفوظ کریں')); break;
    case 'sos': showSos(ev); break;
    case 'pong':
      if (ui.locate && ui.locate.num === ev.num) { ui.locate.pong = ev; renderLocate(); }
      break;
    case 'conflict':
      ui.conf[ev.num] = true;
      toast(tr('Another phone is using the number ', 'کوئی اور فون یہ نمبر استعمال کر رہا ہے ') + ev.num);
      if (!ui.chat) render(); else renderChat();
      break;
    case 'vnend':
      if (ui.playing === ev.id) ui.playing = '';
      if (ui.chat) updateMsgs();
      break;
    case 'dup':
      toast(tr('Another phone nearby uses your number. Pick a different one in Settings.', 'قریب کسی اور فون پر یہی نمبر ہے۔ سیٹنگز میں نیا نمبر چنیں۔'));
      break;
  }
};

function incoming(k, via) {
  const here = isCh(k) || (via || DB.mode) === DB.mode;
  if (ui.chat === k && !ui.locked && here) { updateMsgs(); }
  else {
    const u = ukey(k, via); DB.unread[u] = (DB.unread[u] || 0) + 1; scheduleRender();
    if (!here) toast(tr('New message from ', 'نیا پیغام از ') + title(k) + tr(' in the ', ' — ') + MV[via] + tr(' section', ' سیکشن'));
  }
  save();
}

window.onNativeResume = function () {
  try { JSON.parse(N.drain() || '[]').forEach(window.onMesh); } catch (e) {}
  try { N.snapshot(); } catch (e) {}
  try { const cs = JSON.parse(N.callState()); if (cs.state && cs.state !== 'idle') handleCall(cs); } catch (e) {}
  if (DB.me && !N.hasPerms()) { ui.perm = false; render(); }
  if (DB.pin && ui.pausedAt && Date.now() - ui.pausedAt > 20000) showLock();
  ui.pausedAt = 0;
};
window.onNativePause = function () { ui.pausedAt = Date.now(); };

window.onOpenPeer = function (num) {
  if (!DB.me) return;
  const last = (DB.chats[num] || []).slice(-1)[0];
  if (last) DB.mode = viaOf(last);
  ui.chat = num; DB.unread[ukey(num)] = 0; save();
  if (!ui.locked) render();
};

window.onPerms = function () {
  if (ui.pendCall && N.hasMic()) { const n = ui.pendCall; ui.pendCall = null; placeCall(n); }
  if (N.hasPerms()) startNative();
  else { ui.perm = false; toast(tr('Bluetooth permissions are needed for the mesh to work', 'میش کے لیے بلوٹوتھ اجازتیں ضروری ہیں')); render(); }
};

window.onBack = function () {
  if (ui.locked) return true;
  if ($('#view').classList.contains('on')) { $('#view').classList.remove('on'); return true; }
  if ($('#sheet').classList.contains('on')) { closeSheet(); return true; }
  if (ui.rec) { finishRec(false); return true; }
  if (ui.call) return true;
  if (ui.chat) { leaveChat(); return true; }
  if (DB.me && ui.tab !== 'chats') { ui.tab = 'chats'; render(); return true; }
  return false;
};

window.onImage = function (mid, ok) {
  const to = ui.imgTo;
  if (!ok) { if (mid) toast(tr('Could not use that photo', 'یہ تصویر استعمال نہیں ہو سکی')); return; }
  if (!to || isCh(to)) return;
  addMsg(to, { mid, me: true, k: 'img', t: '', ts: Date.now(), st: 0, via: DB.mode });
  save(); N.sendFile(to, mid, 'img', 0, DB.mode);
  if (ui.chat === to) updateMsgs(true);
};

window.onRestore = function (text) {
  try {
    const o = JSON.parse(text);
    if (!o || !o.db || !o.db.me) throw new Error('bad');
    DB = Object.assign(DEF(), o.db, { pin: DB.pin, salt: DB.salt });
    if (!DB.cts) DB.cts = { bt: Object.assign({}, DB.contacts || {}), wifi: Object.assign({}, DB.contacts || {}) };
    if (DB.mode !== 'bt' && DB.mode !== 'wifi') DB.mode = 'bt';
    save(); location.reload();
  } catch (e) { toast(tr('That is not a NearCall backup', 'یہ NearCall کا بیک اپ نہیں ہے')); }
};

function startNative() {
  if (!DB.me) return;
  if (!N.hasPerms()) { ui.perm = false; render(); return; }
  ui.perm = true;
  N.start(DB.me.num, DB.me.name, Number.isInteger(DB.me.av) ? DB.me.av : 0);
  N.setRelay(!!DB.relay);
  N.setLan(!!DB.lan);
  N.setBt(DB.btl !== false);
  N.setNearby(DB.nbl !== false);
  syncAllowed();
  syncNotify();
  Object.keys(DB.ch).forEach(c => N.joinChannel(c));
  Object.keys(DB.blocked).forEach(n => { if (DB.blocked[n]) N.block(n, true); });
  setTimeout(() => { RUN = N.isRunning(); N.snapshot(); if (!ui.chat) render(); }, 900);
}

/* ---- sending ---- */
function sendDm(num, text, replyObj) {
  if (!canContact(num)) { unsavedSheet(num, 'message'); return null; }
  const mid = rnd();
  const rp = replyObj ? { m: replyObj.m, t: replyObj.t } : null;
  addMsg(num, { mid, me: true, t: text, ts: Date.now(), st: 0, rp, via: DB.mode });
  save();
  if (!N.isRunning()) toast(tr('Mesh is off. Message will wait.', 'میش بند ہے۔ پیغام انتظار کرے گا۔'));
  N.send(num, mid, text, rp ? JSON.stringify(rp) : '', DB.mode);
  return mid;
}
function sendMsg() {
  const t = $('#cin'); if (!t || !ui.chat) return;
  const text = t.value.trim(); if (!text) return;
  if (!isCh(ui.chat) && !canContact(ui.chat)) { unsavedSheet(ui.chat, 'message'); return; }
  t.value = ''; t.style.height = 'auto'; ui.draft = '';
  if (isCh(ui.chat)) {
    const mid = rnd(), name = chName(ui.chat);
    addMsg(ui.chat, { mid, me: true, who: DB.me.name, t: text, ts: Date.now(), st: 0 });
    save(); N.sendChannel(name, mid, text);
  } else {
    sendDm(ui.chat, text, ui.reply);
  }
  ui.reply = null; renderReplyBar(); syncBtn();
  updateMsgs(true);
  t.focus();
}

/* ---- calls ---- */
function placeCall(num) {
  if (IOS) { iosOnly(); return; }
  if (!/^\d{3,15}$/.test(num)) { toast(tr('Enter a valid number', 'درست نمبر لکھیں')); return; }
  if (num === DB.me.num) { toast(tr('That is your own number', 'یہ آپ کا اپنا نمبر ہے')); return; }
  if (!canContact(num)) { unsavedSheet(num, 'call'); return; }
  if (DB.blocked[num]) { toast(tr('Unblock this number first', 'پہلے اس نمبر کو ان بلاک کریں')); return; }
  if (!N.hasPerms()) { N.requestPerms(); return; }
  if (!N.hasMic()) { ui.pendCall = num; N.requestPerms(); return; }
  if (!N.isRunning()) { toast(tr('Mesh is starting, try again', 'میش شروع ہو رہا ہے، دوبارہ کوشش کریں')); startNative(); return; }
  ui.callDir = 'out'; ui.mute = false; ui.spk = false;
  ui.call = { state: 'out', num, name: nameOf(num), since: 0, via: DB.mode };
  N.call(num, DB.mode);
  renderCall();
}

function handleCall(ev) {
  if (ev.state === 'in' && DB.hideUnknown && !isSaved(ev.num)) { N.reject(); return; }
  if (ev.state === 'idle') {
    const c = ui.call;
    const num = ev.num || (c && c.num);
    if ((c || ev.reason === 'missed') && num) {
      const dir = ev.reason === 'missed' ? 'missed' : (ui.callDir || 'out');
      DB.calls.unshift({ num, dir, ts: Date.now(), dur: ev.dur || 0, via: (c && c.via) || ev.via || DB.mode });
      DB.calls.length = Math.min(DB.calls.length, 60);
      if (ev.name) DB.names[num] = ev.name;
      save();
    }
    if (c) {
      const R = { rejected: tr('Call declined', 'کال مسترد'), busy: tr('User is busy', 'صارف مصروف ہے'), noanswer: tr('No answer', 'جواب نہیں'),
        lost: tr('Connection lost', 'رابطہ ٹوٹ گیا'), nomic: tr('Microphone not available', 'مائیکروفون دستیاب نہیں'), nokey: tr('Could not secure the call', 'کال محفوظ نہیں ہو سکی') };
      if (R[ev.reason]) toast(R[ev.reason]);
    }
    ui.call = null; ui.mute = false; ui.spk = false;
    renderCall();
    if (!ui.chat) render();
    return;
  }
  if (ev.name) DB.names[ev.num] = ev.name;
  if (!ui.call || ui.call.num !== ev.num || ui.call.state !== ev.state) {
    if (ev.state === 'in') { ui.callDir = 'in'; ui.mute = false; ui.spk = false; }
    ui.call = { state: ev.state, num: ev.num, name: ev.name || nameOf(ev.num), since: ev.state === 'active' ? Date.now() : 0, via: ev.via || DB.mode };
    renderCall();
  }
}

function renderCall() {
  const o = $('#call'), c = ui.call;
  clearInterval(ui.tm);
  if (!c) { o.classList.remove('on'); o.innerHTML = ''; return; }
  o.classList.add('on');
  const st = c.state === 'out' ? tr('Calling…', 'کال ہو رہی ہے…')
    : c.state === 'in' ? tr('Incoming call', 'آنے والی کال')
    : '🔒 <span id="ctime">' + fmtDur((Date.now() - c.since) / 1000) + '</span>';
  let btns;
  if (c.state === 'in') btns = '<button class="cb red hang" data-a="reject">' + IC.phone + '</button><button class="cb green" data-a="accept">' + IC.phone + '</button>';
  else if (c.state === 'out') btns = '<button class="cb red hang" data-a="endcall">' + IC.phone + '</button>';
  else btns = '<button class="cb' + (ui.mute ? ' on' : '') + '" data-a="mute">' + IC.mic + '</button><button class="cb red hang" data-a="endcall">' + IC.phone +
    '</button><button class="cb' + (ui.spk ? ' on' : '') + '" data-a="spk">' + IC.spk + '</button>';
  o.innerHTML = '<div class="cav" style="background:' + colorOf(c.num) + '">' + esc(initial(c.num)) + '</div><h2>' + esc(nameOf(c.num)) + '</h2><p class="cnum">' + esc(c.num) +
    '</p><p class="cst">' + st + '</p><p class="cnum" style="margin:-26px 0 26px">' + (c.via === 'wifi' ? '📶 Wi-Fi' : '🔵 Bluetooth') + '</p><div class="cbtns">' + btns + '</div>';
  if (c.state === 'active') ui.tm = setInterval(() => { const e = $('#ctime'); if (e && ui.call) e.textContent = fmtDur((Date.now() - ui.call.since) / 1000); }, 1000);
}

/* ---- SOS ---- */
function showSos(ev) {
  const o = $('#sos');
  o.classList.add('on');
  const who = ev.name || ev.from;
  o.innerHTML = '<div style="font-size:56px">🚨</div><h2>SOS</h2><p class="cst" style="margin:8px 0 6px;font-size:20px;font-weight:700">' + esc(who) + '</p>' +
    '<p class="cnum">' + esc(ev.from) + ' · ' + (ev.hp > 1 ? ev.hp + ' ' + tr('hops away', 'ہاپ دور') : tr('very close', 'بہت قریب')) + '</p>' +
    '<p class="cst" style="margin:16px 0 34px">' + esc(ev.text || tr('Needs help nearby', 'قریب مدد چاہیے')) + '</p>' +
    '<div class="cbtns"><button class="cb green" data-a="soscall" data-v="' + esc(ev.from) + '">' + IC.phone + '</button><button class="cb" data-a="sosmsg" data-v="' + esc(ev.from) + '">' + IC.chat + '</button><button class="cb red" data-a="sosx">' + IC.x + '</button></div>';
}
function sosSheet() {
  openSheet('<h3 style="color:var(--bad)">SOS</h3><p class="hint">' + tr('This alerts every NearCall phone within reach, including relays. It is NOT a replacement for emergency services (115 / 1122 / 15).', 'یہ رسائی میں موجود ہر NearCall فون کو الرٹ بھیجتا ہے۔ یہ ہنگامی خدمات (115 / 1122 / 15) کا متبادل نہیں ہے۔') + '</p>' +
    '<label class="lbl">' + tr('Message', 'پیغام') + '</label><input class="inp" id="sosT" maxlength="120" value="' + esc(tr('I need help!', 'مجھے مدد چاہیے!')) + '">' +
    '<div class="btnrow"><button class="btn bad grow" data-a="sossend">' + tr('Send SOS', 'SOS بھیجیں') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}

/* ---- sheets ---- */
function openSheet(html) { const s = $('#sheet'); s.innerHTML = '<div class="in">' + html + '</div>'; s.classList.add('on'); }
function closeSheet() { const s = $('#sheet'); s.classList.remove('on'); s.innerHTML = ''; ui.locate = null; }

/* ---- screens ---- */
function topbar(t, sub, left, right) {
  $('#top').innerHTML = (left || '') + '<h1>' + esc(t) + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</h1>' + (right || '');
}

function renderModebar() {
  const e = $('#modebar'); if (!e) return;
  if (IOS || !DB.me || ui.chat || !['chats', 'dial', 'people'].includes(ui.tab)) { e.innerHTML = ''; return; }
  const b = (m, label, ic) => '<button class="mode ' + m + (DB.mode === m ? ' on' : '') + '" data-a="mode" data-v="' + m + '">' + ic + '<span>' + label + '</span><i class="cnt">' + LINK[m] + '</i>' +
    (unreadMode(m) ? '<i class="dot2">' + unreadMode(m) + '</i>' : '') + '</button>';
  e.innerHTML = '<div class="modes">' + b('bt', 'Bluetooth', IC.bt) + b('wifi', 'Wi-Fi / Hotspot', IC.wifi) + '</div>';
}

function render() {
  applyLang(); applyTheme();
  const main = $('#main'), foot = $('#foot');
  if (!DB.me) return renderSetup();
  if (ui.chat) { renderModebar(); return renderChat(); }
  const banner = !ui.perm
    ? '<div class="banner"><span class="grow">' + tr('Bluetooth permission is needed for nearby chat and calls.', 'قریبی چیٹ اور کال کے لیے بلوٹوتھ اجازت ضروری ہے۔') + '</span><button class="btn" data-a="perm">' + tr('Allow', 'اجازت دیں') + '</button></div>'
    : '';
  const status = RUN ? ('🔵 ' + LINK.bt + ' · 📶 ' + LINK.wifi + (NEAR === 0 ? ' · ' + tr('searching…', 'تلاش جاری…') : '')) : tr('Mesh is off', 'میش بند ہے');
  const lb = LOWBATT ? '<div class="warn">' + tr('Battery is low, so this phone is not relaying for others right now.', 'بیٹری کم ہے، اس لیے یہ فون ابھی دوسروں کے لیے ریلے نہیں کر رہا۔') + '</div>' : '';
  const sec = ['chats', 'dial', 'people'].includes(ui.tab);
  const fo = (sec && RUN && LINK[DB.mode] === 0 && LINK[otherOf(DB.mode)] > 0)
    ? '<div class="warn fo">⚡ ' + tr('No ' + MV[DB.mode] + ' link right now. Messages and calls are using ' + MV[otherOf(DB.mode)] + ' automatically and will switch back by themselves.',
      MV[DB.mode] + ' لنک ابھی نہیں ہے۔ پیغام اور کالیں خود بخود ' + MV[otherOf(DB.mode)] + ' پر جا رہی ہیں اور خود ہی واپس آ جائیں گی۔') +
      '<br><button class="btn sm" data-a="reconnect">' + tr('Reconnect now', 'ابھی دوبارہ جوڑیں') + '</button></div>' : '';
  let html = '';
  if (ui.tab === 'chats') { topbar('NearCall', status); html = viewChats(); }
  else if (ui.tab === 'dial') { topbar(tr('Dial', 'ڈائل'), status); html = viewDial(); }
  else if (ui.tab === 'people') { topbar(tr('People', 'لوگ'), status, '', '<button class="ib" data-a="addc">' + IC.plus + '</button>'); html = viewPeople(); }
  else if (ui.tab === 'chan') { topbar(tr('Channels', 'چینلز'), status, '', '<button class="ib" data-a="joinch">' + IC.plus + '</button>'); html = viewChannels(); }
  else { topbar(tr('Settings', 'سیٹنگز'), status); html = viewSettings(); }
  const pill = (sec && DB.contactsOnly) ? '<div class="pill" data-a="tab" data-v="set">🛡 ' + tr('Contacts-only mode', 'صرف رابطے موڈ') + ' · ' + savedNums().length + ' ' + tr('saved', 'محفوظ') + '</div>' : '';
  main.innerHTML = '<div class="wrap">' + banner + lb + fo + pill + html + '</div>';
  const un = totalUnread();
  const unCh = Object.keys(DB.unread).filter(isCh).reduce((a, k) => a + (DB.unread[k] || 0), 0);
  const T = (id, ic, label, dot) => '<button class="tab' + (ui.tab === id ? ' on' : '') + '" data-a="tab" data-v="' + id + '">' + ic + '<span>' + label + '</span>' +
    (dot ? '<i class="dot">' + dot + '</i>' : '') + '</button>';
  foot.innerHTML = '<nav class="tabs">' + T('chats', IC.chat, tr('Chats', 'چیٹس'), unreadMode(DB.mode)) + T('dial', IC.dial, tr('Dial', 'ڈائل')) +
    T('people', IC.people, tr('People', 'لوگ')) + T('chan', IC.hash, tr('Channels', 'چینلز'), unCh) + T('set', IC.gear, tr('Settings', 'سیٹنگز')) + '</nav>';
  renderModebar();
}

const genNum = () => '09' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

function renderSetup() {
  topbar('NearCall', tr('Offline chat & calls over Bluetooth and Wi-Fi', 'بلوٹوتھ اور وائی فائی پر آف لائن چیٹ اور کال'));
  $('#foot').innerHTML = '';
  const av = Number.isInteger(ui.setupAv) ? ui.setupAv : 0;
  $('#main').innerHTML = '<div class="wrap"><div class="card"><h3>' + tr('Create your number', 'اپنا نمبر بنائیں') + '</h3>' +
    '<p class="hint">' + tr('Pick any 11-digit number and your name. Friends nearby can call or message you on it. No SIM, no internet.', 'کوئی بھی 11 ہندسوں کا نمبر اور اپنا نام چنیں۔ قریبی دوست اسی پر کال یا میسج کر سکتے ہیں۔ نہ سم، نہ انٹرنیٹ۔') + '</p>' +
    '<label class="lbl">' + tr('Your name', 'آپ کا نام') + '</label><input class="inp" id="sName" maxlength="24" autocomplete="off">' +
    '<label class="lbl">' + tr('Your number (11 digits)', 'آپ کا نمبر (11 ہندسے)') + '</label>' +
    '<div style="display:flex;gap:8px"><input class="inp" id="sNum" inputmode="numeric" maxlength="11" value="' + genNum() + '" style="direction:ltr"><button class="btn ghost sm" data-a="gen">' + tr('Random', 'رینڈم') + '</button></div>' +
    '<label class="lbl">' + tr('Your colour', 'آپ کا رنگ') + '</label>' + swatches(av, 'setav') +
    '<button class="btn block" style="margin-top:16px" data-a="setup">' + tr('Start', 'شروع کریں') + '</button>' +
    '<button class="btn ghost block" style="margin-top:8px" data-a="lang">' + (DB.lang === 'ur' ? 'English' : 'اردو') + '</button></div>' +
    '<p class="hint">' + tr('Works between phones in Bluetooth range, or on the same hotspot / Wi-Fi. Every phone with the app also relays messages for others, so the network grows with more users.', 'بلوٹوتھ رینج یا ایک ہی ہاٹ اسپاٹ / وائی فائی پر موجود فونز کے درمیان کام کرتا ہے۔ ایپ والا ہر فون دوسروں کے پیغام آگے بھی بھیجتا ہے، اس لیے زیادہ صارفین سے نیٹ ورک بڑھتا ہے۔') + '</p></div>';
}
function swatches(sel, act) {
  return '<div class="swr">' + PAL.map((c, i) => '<div class="sws' + (i === sel ? ' on' : '') + '" style="background:' + c + '" data-a="' + act + '" data-v="' + i + '"></div>').join('') + '</div>';
}

function viewChats() {
  const keys = Object.keys(DB.chats).filter(n => lastOf(n) && !DB.blocked[n] && (!DB.hideUnknown || isSaved(n))).sort((a, b) => lastOf(b).ts - lastOf(a).ts);
  if (!keys.length) return '<div class="empty">' + IC.chat + '<p>' + tr('No chats yet. Open People or Dial to start one.', 'ابھی کوئی چیٹ نہیں۔ شروع کرنے کے لیے لوگ یا ڈائل کھولیں۔') + '</p></div>';
  return '<div class="card">' + keys.map(n => chatRow(n)).join('') + '</div>';
}
function chatRow(k) {
  const m = lastOf(k), u = DB.unread[ukey(k)] || 0;
  return '<div class="row" data-a="open" data-v="' + esc(k) + '">' + avatar(k) + '<div class="grow"><div class="t1">' + esc(title(k)) + (DB.muted[isCh(k) ? 'ch:' + chName(k) : k] ? ' 🔕' : '') +
    '</div><div class="t2">' + (m ? (m.me ? '✓ ' : (isCh(k) && m.who ? esc(m.who) + ': ' : '')) + esc(snippet(m)) : '') + '</div></div><div class="meta">' + (m ? fmtT(m.ts) : '') + (u ? '<br><span class="badge">' + u + '</span>' : '') + '</div></div>';
}

function viewChannels() {
  const names = Object.keys(DB.ch).sort((a, b) => ((lastOf('#' + b) || {}).ts || 0) - ((lastOf('#' + a) || {}).ts || 0));
  return '<button class="sosbtn" data-a="sos">🚨 SOS · ' + tr('I need help', 'مجھے مدد چاہیے') + '</button>' +
    '<h2 class="sec">' + tr('Open channels', 'اوپن چینلز') + '</h2>' +
    (names.length ? '<div class="card">' + names.map(n => chatRow('#' + n)).join('') + '</div>'
      : '<div class="card hint">' + tr('Join a channel like "campus" or "library" to talk with everyone nearby. Channels are open: anyone who knows the name can read them.', 'سب قریبی لوگوں سے بات کرنے کے لیے "campus" یا "library" جیسے چینل میں شامل ہوں۔ چینل اوپن ہیں: نام جاننے والا کوئی بھی پڑھ سکتا ہے۔') + '</div>');
}

function viewDial() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', 'bs'];
  const rec = DB.calls.filter(c => (c.via || 'bt') === DB.mode).slice(0, 12).map(c => {
    const lab = c.dir === 'missed' ? tr('Missed', 'مس') : c.dir === 'in' ? tr('Incoming', 'آنے والی') : tr('Outgoing', 'جانے والی');
    return '<div class="row" data-a="fill" data-v="' + esc(c.num) + '">' + avatar(c.num, c.dir === 'missed' ? '' : 'dim') + '<div class="grow"><div class="t1" style="' + (c.dir === 'missed' ? 'color:var(--bad)' : '') + '">' + esc(nameOf(c.num)) +
      '</div><div class="t2">' + lab + (c.dur ? ' · ' + fmtDur(c.dur) : '') + ' · ' + fmtT(c.ts) + '</div></div><button class="circ ghost" data-a="call" data-v="' + esc(c.num) + '">' + IC.phone + '</button></div>';
  }).join('');
  return '<div class="card"><div class="disp" id="disp">' + esc(ui.dial) + '</div><div class="dname" id="dname">' + dialName() + '</div>' +
    '<div class="pad">' + keys.map(k => '<button class="k" data-a="' + (k === 'bs' ? 'bs' : 'key') + '" data-v="' + k + '">' + (k === 'bs' ? IC.bs.replace('<svg', '<svg style="width:26px;height:26px"') : k) + '</button>').join('') + '</div>' +
    '<div class="dact"><button class="btn ok grow" data-a="dialcall">' + tr('Call', 'کال') + '</button><button class="btn ghost grow" data-a="dialmsg">' + tr('Message', 'پیغام') + '</button></div></div>' +
    (rec ? '<h2 class="sec">' + tr('Recent calls', 'حالیہ کالیں') + '</h2><div class="card">' + rec + '</div>' : '');
}
function dialName() {
  const n = ui.dial; if (!n) return '';
  const nm = (CT()[n] && CT()[n].name) || DB.names[n];
  return esc(nm || '') + (peerFor(n) ? ' · <b>' + tr('nearby', 'قریب') + '</b>' : '');
}
function updateDial() { const d = $('#disp'); if (d) { d.textContent = ui.dial; $('#dname').innerHTML = dialName(); } }

function rowTxt(p) {
  const c = DB.mode === 'wifi' ? p.wfc : p.btc;
  if (c) return tr('Connected', 'منسلک');
  if (p.near) return tr('Direct on ', 'براہ راست ') + MV[otherOf(DB.mode)];
  if (p.hp > 1) return p.hp + ' ' + tr('hops', 'ہاپ');
  return tr('Found · connecting…', 'ملا · جڑ رہا ہے…');
}

function viewPeople() {
  const inSec = PEERS.filter(p => (DB.mode === 'wifi' ? p.wifi : p.bt) && !DB.blocked[p.num]);
  const hiddenN = DB.onlyKnown ? inSec.filter(p => !isSaved(p.num)).length : 0;
  const near = inSec.filter(p => !DB.onlyKnown || isSaved(p.num)).map(p => {
    const saved = !!CT()[p.num];
    const seen = p.age < 5 ? tr('just now', 'ابھی') : p.age + 's';
    return '<div class="row" data-a="open" data-v="' + esc(p.num) + '">' + avatar(p.num) + '<div class="grow"><div class="t1">' + esc(nameOf(p.num)) +
      '</div><div class="t2" style="direction:ltr;text-align:start">' + esc(p.num) + ' · <span class="chip ' + ((DB.mode === 'wifi' ? p.wfc : p.btc) ? 'on' : '') + '">' + rowTxt(p) + '</span> · ' + seen +
      (p.conflict ? ' · <span class="chip" style="background:var(--accent);color:#1b1500">⚠ ' + tr('new device', 'نیا ڈیوائس') + '</span>' : '') + '</div></div><div class="ra">' +
      (saved ? '' : '<button class="circ ghost" data-a="savep" data-v="' + esc(p.num) + '">' + IC.star + '</button>') +
      '<button class="circ" data-a="call" data-v="' + esc(p.num) + '">' + IC.phone + '</button></div></div>';
  }).join('');
  const saved = Object.values(CT()).sort((a, b) => a.name.localeCompare(b.name)).map(c => {
    const pp = peerFor(c.num), on = !!(pp && (DB.mode === 'wifi' ? pp.wifi : pp.bt));
    return '<div class="row" data-a="open" data-v="' + esc(c.num) + '">' + avatar(c.num, on ? '' : 'dim') + '<div class="grow"><div class="t1">' + esc(c.name) +
      '</div><div class="t2" style="direction:ltr;text-align:start">' + esc(c.num) + ' · ' + (on ? tr('nearby', 'قریب') : tr('not seen now', 'ابھی نظر نہیں')) + '</div></div><div class="ra">' +
      '<button class="circ ghost" data-a="editc" data-v="' + esc(c.num) + '">' + IC.gear + '</button><button class="circ" data-a="call" data-v="' + esc(c.num) + '">' + IC.phone + '</button></div></div>';
  }).join('');
  return '<h2 class="sec">' + tr('Nearby on ', 'اب قریب · ') + MV[DB.mode] + '</h2>' +
    (near ? '<div class="card">' + near + '</div>' : '<div class="card hint">' + (DB.onlyKnown
      ? tr('None of your saved contacts is in range right now. Only people you saved are shown here. Tap + to save a number.', 'آپ کا کوئی محفوظ رابطہ ابھی رینج میں نہیں۔ یہاں صرف وہ لوگ نظر آتے ہیں جنہیں آپ نے محفوظ کیا ہے۔ نمبر محفوظ کرنے کے لیے + دبائیں۔')
      : tr('Nobody found yet. Ask a friend to open NearCall and stand close, or join the same hotspot. Keep Bluetooth and location on.', 'ابھی کوئی نہیں ملا۔ دوست سے کہیں NearCall کھولے اور قریب آئے، یا ایک ہی ہاٹ اسپاٹ سے جڑیں۔ بلوٹوتھ اور لوکیشن آن رکھیں۔')) + '</div>') +
    (hiddenN ? '<p class="hint" style="padding:0 6px">' + hiddenN + ' ' + tr('unknown phone(s) in range are hidden.', 'نامعلوم فون رینج میں ہیں مگر چھپے ہوئے ہیں۔') + ' <a data-a="showunk" style="color:var(--pri);font-weight:700">' + tr('Show', 'دکھائیں') + '</a></p>' : '') +
    '<h2 class="sec">' + tr('Saved contacts', 'محفوظ رابطے') + ' · ' + MV[DB.mode] + '</h2>' +
    (saved ? '<div class="card">' + saved + '</div>' : '<div class="card hint">' + tr('Tap + to save a name and number.', 'نام اور نمبر محفوظ کرنے کے لیے + دبائیں۔') + '</div>');
}

function viewSettings() {
  const bat = N.batteryOk();
  let droppedN = 0; try { droppedN = JSON.parse(N.netInfo() || '{}').dropped || 0; } catch (e) {}
  const hrs = sel => Array.from({ length: 24 }, (_, h) => '<option value="' + h + '"' + (h === sel ? ' selected' : '') + '>' + String(h).padStart(2, '0') + ':00</option>').join('');
  const blockedL = Object.keys(DB.blocked).filter(n => DB.blocked[n]);
  return '<div class="card"><h3>' + tr('My number', 'میرا نمبر') + '</h3><div style="display:flex;gap:12px;align-items:center">' + avatar(DB.me.num) +
    '<div><div class="t1" style="direction:ltr;text-align:start;font-size:20px">' + esc(DB.me.num) + '</div><div class="t2">' + esc(DB.me.name) + '</div></div></div>' +
    '<button class="btn ghost sm" style="margin-top:10px" data-a="editme">' + tr('Change', 'تبدیل کریں') + '</button></div>' +

    '<div class="card"><h3>' + tr('Links', 'لنکس') + '</h3>' +
    '<label class="sw androidonly"><span><b>🔵 Bluetooth</b><br><span class="hint">' + tr('Its own chats, calls and contacts. Range about 10 to 30 m. Connected: ', 'اس کی اپنی چیٹس، کالیں اور رابطے۔ رینج تقریباً 10 سے 30 میٹر۔ منسلک: ') + LINK.bt + '</span></span><input type="checkbox" data-a="btl" ' + (DB.btl !== false ? 'checked' : '') + '></label>' +
    '<label class="sw androidonly"><span><b>' + tr('Auto-discovery (Nearby)', 'آٹو ڈسکوری (Nearby)') + '</b><br><span class="hint">' + tr('Finds new phones by itself. Google runs this part and it may use Wi-Fi underneath, so a Wi-Fi change can interrupt it. Paired phones (below) do not depend on it.', 'نئے فون خود ڈھونڈتا ہے۔ یہ حصہ گوگل چلاتا ہے اور اندر سے وائی فائی بھی استعمال کر سکتا ہے، اس لیے وائی فائی بدلنے پر رک سکتا ہے۔ نیچے والے جوڑا بنائے گئے فون اس پر منحصر نہیں۔') + '</span></span><input type="checkbox" data-a="nbl" ' + (DB.nbl !== false ? 'checked' : '') + '></label>' +
    '<p class="hint androidonly">' + tr('For the most stable Bluetooth link, pair your phones once in Android Bluetooth settings. NearCall then connects to them directly in about a second, does not use Wi-Fi at all, and reconnects by itself.', 'سب سے مستحکم بلوٹوتھ لنک کے لیے اپنے فونز کو ایک بار اینڈرائیڈ بلوٹوتھ سیٹنگز میں جوڑا بنائیں۔ پھر NearCall تقریباً ایک سیکنڈ میں سیدھا جڑ جاتا ہے، وائی فائی بالکل استعمال نہیں کرتا اور خود دوبارہ جڑتا ہے۔') + '</p>' +
    '<div class="btnrow androidonly" style="margin-bottom:8px"><button class="btn sm" data-a="btsettings">' + tr('Pair phones (Bluetooth settings)', 'فون جوڑیں (بلوٹوتھ سیٹنگز)') + '</button></div>' +
    '<label class="sw"><span><b>📶 Wi-Fi / Hotspot</b><br><span class="hint">' + tr('Its own chats, calls and contacts. Faster and reaches further when phones share a hotspot or Wi-Fi. Connected: ', 'اس کی اپنی چیٹس، کالیں اور رابطے۔ جب فونز ایک ہاٹ اسپاٹ یا وائی فائی پر ہوں تو تیز اور دور تک۔ منسلک: ') + LINK.wifi + '</span></span><input type="checkbox" data-a="lan" ' + (DB.lan ? 'checked' : '') + '></label>' +
    '<p class="hint">' + tr('If one link drops, your messages and calls move to the other one automatically and come back when it returns.', 'اگر ایک لنک ٹوٹ جائے تو آپ کے پیغام اور کالیں خود بخود دوسرے لنک پر چلی جاتی ہیں اور واپس آنے پر لوٹ آتی ہیں۔') + '</p></div>' +

    '<div class="card"><h3>' + tr('Mesh and range', 'میش اور رینج') + '</h3>' +
    '<label class="sw"><span><b>' + tr('Help the network', 'نیٹ ورک کی مدد کریں') + '</b><br><span class="hint">' + tr('Relay messages, photos and calls for others nearby. Pauses by itself below 15% battery.', 'قریبی لوگوں کے پیغام، تصویریں اور کالیں آگے بھیجیں۔ 15٪ سے کم بیٹری پر خود رک جاتا ہے۔') + '</span></span><input type="checkbox" data-a="relay" ' + (DB.relay ? 'checked' : '') + '></label>' +
    '<p class="hint">' + (RUN ? tr('Running in the background.', 'پس منظر میں چل رہا ہے۔') : tr('Not running.', 'چل نہیں رہا۔')) + '</p>' +
    '<div class="btnrow">' + (RUN ? '<button class="btn ghost sm" data-a="stopsvc">' + tr('Turn off', 'بند کریں') + '</button>' : '<button class="btn sm" data-a="startsvc">' + tr('Turn on', 'چالو کریں') + '</button>') +
    '<button class="btn ghost sm" data-a="net">' + tr('Network view', 'نیٹ ورک ویو') + '</button></div></div>' +

    '<div class="card"><h3>' + tr('Boost your range', 'رینج بڑھائیں') + '</h3><p class="hint">' + tr('Bluetooth reaches about 10 to 30 m. For more: one person turns on their phone hotspot (no mobile data needed) and others join that Wi-Fi. Everyone on it links up over Wi-Fi, and phones that also have Bluetooth links bridge the two groups together.', 'بلوٹوتھ تقریباً 10 سے 30 میٹر تک جاتا ہے۔ زیادہ رینج کے لیے ایک شخص اپنے فون کا ہاٹ اسپاٹ آن کرے (موبائل ڈیٹا ضروری نہیں) اور باقی اس وائی فائی سے جڑیں۔ اس پر سب وائی فائی سے جڑ جاتے ہیں، اور بلوٹوتھ والے فونز دونوں گروپوں کو ملا دیتے ہیں۔') + '</p>' +
    '<div class="btnrow"><button class="btn sm" data-a="hotspot">' + tr('Hotspot settings', 'ہاٹ اسپاٹ سیٹنگز') + '</button><button class="btn ghost sm" data-a="wifi">' + tr('Wi-Fi settings', 'وائی فائی سیٹنگز') + '</button></div></div>' +

    '<div class="card"><h3>' + tr('Notifications', 'نوٹیفکیشن') + '</h3>' +
    '<label class="sw"><span><b>' + tr('Quiet hours', 'خاموش اوقات') + '</b><br><span class="hint">' + tr('No message notifications during these hours. Calls and SOS still come through.', 'ان اوقات میں پیغام کی اطلاع نہیں۔ کالیں اور SOS پھر بھی آئیں گے۔') + '</span></span><input type="checkbox" data-a="qon" ' + (DB.quiet.on ? 'checked' : '') + '></label>' +
    '<div style="margin-top:6px">' + tr('From', 'سے') + ' <select class="inp" data-a="qs">' + hrs(DB.quiet.s) + '</select> ' + tr('to', 'تک') + ' <select class="inp" data-a="qe">' + hrs(DB.quiet.e) + '</select></div></div>' +

    '<div class="card"><h3>🛡 ' + tr('Contacts-only mode', 'صرف رابطے موڈ') + (DB.contactsOnly ? ' <span class="chip on">' + tr('ON', 'آن') + '</span>' : '') + '</h3>' +
    '<label class="sw"><span><b>' + tr('Only people in my contacts', 'صرف میرے رابطوں کے لوگ') + '</b><br><span class="hint">' + tr('You can only message, send photos or call numbers you have saved, and only saved numbers can reach you.', 'آپ صرف محفوظ نمبروں کو پیغام، تصویر یا کال کر سکتے ہیں، اور صرف محفوظ نمبر آپ تک پہنچ سکتے ہیں۔') + '</span></span><input type="checkbox" data-a="conly" ' + (DB.contactsOnly ? 'checked' : '') + '></label>' +
    (DB.contactsOnly ? '<div class="kv"><span>' + tr('Saved contacts', 'محفوظ رابطے') + '</span><b>' + savedNums().length + '</b></div><div class="kv"><span>' + tr('Blocked attempts from unknown numbers', 'نامعلوم نمبروں کی روکی گئی کوششیں') + '</span><b>' + droppedN + '</b></div>' : '') +
    '<div class="btnrow"><button class="btn ghost sm" data-a="managec">' + tr('Manage contacts', 'رابطے منظم کریں') + '</button></div></div>' +

    '<div class="card"><h3>' + tr('Privacy', 'پرائیویسی') + '</h3><p class="hint">' + tr('Messages, photos, voice notes and calls are end-to-end encrypted. Relay phones cannot read them.', 'پیغام، تصویریں، وائس نوٹ اور کالیں اینڈ ٹو اینڈ انکرپٹڈ ہیں۔ ریلے فون انہیں نہیں پڑھ سکتے۔') + '</p>' +
    '<label class="sw"><span><b>' + tr('Only show my saved contacts', 'صرف میرے محفوظ رابطے دکھائیں') + '</b><br><span class="hint">' + tr('People lists only the contacts you saved. Unknown phones in range stay hidden.', 'لوگ میں صرف آپ کے محفوظ رابطے آتے ہیں۔ رینج میں نامعلوم فون چھپے رہتے ہیں۔') + '</span></span><input type="checkbox" data-a="onlyk" ' + (DB.onlyKnown ? 'checked' : '') + (DB.contactsOnly ? ' disabled' : '') + '></label>' +
    '<label class="sw"><span><b>' + tr('Ignore unknown numbers', 'نامعلوم نمبر نظر انداز کریں') + '</b><br><span class="hint">' + tr('Messages from numbers you have not saved are not shown and their calls are declined.', 'جو نمبر آپ نے محفوظ نہیں کیے ان کے پیغام نہیں دکھتے اور کالیں مسترد ہو جاتی ہیں۔') + '</span></span><input type="checkbox" data-a="hideu" ' + (DB.hideUnknown ? 'checked' : '') + (DB.contactsOnly ? ' disabled' : '') + '></label>' +
    '<button class="btn ' + (DB.pin ? 'ghost' : '') + ' sm" data-a="applock">' + (DB.pin ? tr('Remove app lock', 'ایپ لاک ہٹائیں') : tr('Set app lock (PIN)', 'ایپ لاک (PIN) لگائیں')) + '</button>' +
    '<h3 style="margin-top:14px">' + tr('Blocked numbers', 'بلاک نمبر') + '</h3>' +
    (blockedL.length ? blockedL.map(n => '<div class="kv"><span style="direction:ltr">' + esc(nameOf(n)) + ' · ' + esc(n) + '</span><button class="btn ghost sm" data-a="unblock" data-v="' + esc(n) + '">' + tr('Unblock', 'ان بلاک') + '</button></div>').join('') : '<p class="hint">' + tr('None', 'کوئی نہیں') + '</p>') + '</div>' +

    '<div class="card"><h3>' + tr('Appearance', 'ظاہری شکل') + '</h3><div class="seg">' +
    ['auto', 'light', 'dark'].map(t => '<button class="' + (DB.theme === t ? 'on' : '') + '" data-a="theme" data-v="' + t + '">' + (t === 'auto' ? tr('Auto', 'آٹو') : t === 'light' ? tr('Light', 'روشن') : tr('Dark', 'گہرا')) + '</button>').join('') + '</div>' +
    '<div class="btnrow"><button class="btn ghost sm" data-a="lang">' + (DB.lang === 'ur' ? 'English' : 'اردو') + '</button></div></div>' +

    '<div class="card androidonly"><h3>' + tr('Data and sharing', 'ڈیٹا اور شیئرنگ') + '</h3><div class="btnrow">' +
    '<button class="btn ghost sm" data-a="backup">' + tr('Back up', 'بیک اپ') + '</button><button class="btn ghost sm" data-a="restore">' + tr('Restore', 'بحال کریں') + '</button>' +
    '<button class="btn sm" data-a="shareapk">' + tr('Send app to a friend', 'دوست کو ایپ بھیجیں') + '</button></div>' +
    '<p class="hint" style="margin-top:8px">' + tr('Backups hold contacts and text chats (not photos or voice notes). After restoring on a new phone, friends may need to tap "Trust new device".', 'بیک اپ میں رابطے اور ٹیکسٹ چیٹس ہیں (تصویریں اور وائس نوٹ نہیں)۔ نئے فون پر بحال کرنے کے بعد دوستوں کو "نیا ڈیوائس بھروسہ کریں" دبانا پڑ سکتا ہے۔') + '</p></div>' +

    '<div class="card androidonly"><h3>' + tr('Keep it alive in the background', 'پس منظر میں چلتا رکھیں') + '</h3><p class="hint">' + (bat ? tr('Battery optimisation is off for NearCall. Good.', 'NearCall کے لیے بیٹری آپٹیمائزیشن بند ہے۔ بہت خوب۔') : tr('Allow NearCall to run without battery limits so it can receive messages and calls with the screen off. On Xiaomi, Oppo, Vivo, Infinix and Tecno also enable Autostart.', 'اسکرین بند ہونے پر پیغام اور کال وصول کرنے کے لیے NearCall کو بیٹری کی حد کے بغیر چلنے دیں۔ شیاؤمی، اوپو، ویوو، انفنکس اور ٹیکنو پر آٹو اسٹارٹ بھی آن کریں۔')) + '</p>' +
    (bat ? '' : '<button class="btn sm" data-a="battery">' + tr('Open battery settings', 'بیٹری سیٹنگز کھولیں') + '</button>') + '</div>' +
    '<p class="hint" style="padding:0 6px">' + tr('Range is about 10 m per Bluetooth hop (more in open space and on Wi-Fi). Messages hop across phones that have the app. Not for emergencies.', 'ہر بلوٹوتھ ہاپ کی رینج تقریباً 10 میٹر ہے (کھلی جگہ اور وائی فائی پر زیادہ)۔ پیغام ایپ والے فونز کے ذریعے آگے جاتے ہیں۔ ہنگامی حالات کے لیے نہیں۔') + '</p>';
}

/* ---- chat ---- */
function leaveChat() { if (ui.rec) finishRec(false); ui.chat = null; ui.reply = null; ui.draft = ''; render(); }

function renderChat() {
  const k = ui.chat, ch = isCh(k), p = ch ? null : peerFor(k);
  if (ch && !DB.ch[chName(k)]) DB.ch[chName(k)] = [];
  DB.unread[ukey(k)] = 0; save();
  const sub = ch ? tr('Open channel · anyone who knows the name can read', 'اوپن چینل · نام جاننے والا کوئی بھی پڑھ سکتا ہے')
    : esc(k) + ' · ' + linkState(p);
  topbar(title(k), sub,
    '<button class="ib" data-a="back"><span class="flip">' + IC.back + '</span></button>',
    (ch ? '' : '<button class="ib" data-a="call" data-v="' + esc(k) + '">' + IC.phone + '</button>') + '<button class="ib" data-a="menu">' + IC.dots + '</button>');
  const conf = !ch && (ui.conf[k] || (p && p.conflict));
  const waiting = !ch && !p && viewOf(k).some(m => m.me && (m.st || 0) < 2);
  $('#main').innerHTML = '<div class="wrap">' + (conf ? '<div class="warn">⚠ ' + tr('A different phone is now using this number. Your chat stays locked to the original phone. If your friend reinstalled the app or got a new phone, you can trust the new one.', 'کوئی اور فون اب یہ نمبر استعمال کر رہا ہے۔ آپ کی چیٹ اصل فون سے ہی بندھی رہے گی۔ اگر دوست نے ایپ دوبارہ انسٹال کی یا نیا فون لیا ہے تو آپ نئے کو بھروسہ دے سکتے ہیں۔') +
    '<br><button class="btn sm" data-a="trust" data-v="' + esc(k) + '">' + tr('Trust new device', 'نئے ڈیوائس پر بھروسہ کریں') + '</button></div>' : '') + '<div id="msgs"></div></div>';
  if (waiting) $('#main').firstChild.insertAdjacentHTML('afterbegin', '<div class="warn" style="background:var(--card);color:var(--ink);box-shadow:var(--shadow)">🕓 ' +
    tr('Not in range right now. Your messages and missed calls are kept on this phone for up to 7 days and are delivered automatically when you both connect again (Bluetooth or Wi-Fi).',
       'ابھی رینج میں نہیں۔ آپ کے پیغام اور مس کالیں اس فون پر 7 دن تک محفوظ رہتی ہیں اور دونوں کے دوبارہ جڑتے ہی (بلوٹوتھ یا وائی فائی) خود بخود پہنچ جاتی ہیں۔') +
    '<br><button class="btn sm" style="margin-top:8px" data-a="reconnect">' + tr('Reconnect now', 'ابھی دوبارہ جوڑیں') + '</button></div>');
  renderCompose();
  updateMsgs(true);
}

function renderReplyBar() {
  const e = $('#replybar'); if (!e) return;
  e.innerHTML = ui.reply ? '<div class="replybar"><div class="t">' + esc(ui.reply.t) + '</div><button class="circ ghost" style="width:32px;height:32px" data-a="noreply">' + IC.x + '</button></div>' : '';
}

function renderCompose() {
  const foot = $('#foot'), ch = isCh(ui.chat);
  if (ui.rec) {
    foot.innerHTML = '<div class="compose rec"><button class="circ ghost" data-a="reccancel">' + IC.x + '</button><span class="dotr"></span><b id="rect">00:00</b><span class="grow hint">' + tr('Recording… (max 15 s)', 'ریکارڈنگ… (زیادہ سے زیادہ 15 سیکنڈ)') + '</span><button class="circ" data-a="recsend">' + IC.send + '</button></div>';
    return;
  }
  foot.innerHTML = '<div id="replybar"></div><div class="compose">' + (ch ? '' : '<button class="circ ghost" data-a="attach">' + IC.clip + '</button>') +
    '<textarea id="cin" rows="1" placeholder="' + tr('Message', 'پیغام') + '"></textarea><button class="circ" id="mainbtn" data-a="send">' + IC.send + '</button></div>';
  const t = $('#cin');
  t.value = ui.draft || '';
  t.addEventListener('input', () => { ui.draft = t.value; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 110) + 'px'; syncBtn(); });
  renderReplyBar(); syncBtn();
}
function syncBtn() {
  const b = $('#mainbtn'), t = $('#cin'); if (!b || !t) return;
  const useMic = !t.value.trim() && !isCh(ui.chat);
  b.dataset.a = useMic ? 'mic' : 'send';
  b.innerHTML = useMic ? IC.mic : IC.send;
}

function bubble(m, key) {
  const who = (isCh(key) && !m.me) ? '<b class="who">' + esc(m.who || '') + '</b>' : '';
  const q = m.rp ? '<div class="q">' + esc(m.rp.t) + '</div>' : '';
  let body;
  if (m.k === 'img') body = '<img class="pic" loading="lazy" data-a="view" data-v="' + esc(m.mid) + '" src="/media/img/' + esc(m.mid) + '.jpg" alt="">';
  else if (m.k === 'vn') body = '<div class="vn"><button class="vnb" data-a="vnplay" data-v="' + esc(m.mid) + '">' + (ui.playing === m.mid ? IC.stop : IC.play) + '</button><div class="vbar"></div><span>' + fmtDur(m.dur || 0) + '</span></div>';
  else body = esc(m.t);
  const tick = m.me ? ' ' + (m.st === 2 ? '✓✓' : m.st === 1 ? '✓' : '🕓') + ((m.u && m.u !== 'both' && m.u !== viaOf(m)) ? ' ↪ ' + (MV[m.u] || '') : '') : '';
  return '<div class="b ' + (m.me ? 'me' : 'them') + '">' + who + q + body + '<small data-a="bub" data-v="' + esc(m.mid) + '">' + fmtT(m.ts) + tick + ' ⋯</small></div>';
}
function updateMsgs(force) {
  const box = $('#msgs'); if (!box || !ui.chat) return;
  const main = $('#main'), atBottom = force || main.scrollHeight - main.scrollTop - main.clientHeight < 90;
  box.innerHTML = viewOf(ui.chat).map(m => bubble(m, ui.chat)).join('');
  if (atBottom) main.scrollTop = main.scrollHeight;
}

function findMsg(mid) { return thread(ui.chat).find(m => m.mid === mid); }

function bubSheet(mid) {
  const m = findMsg(mid); if (!m) return;
  const ch = isCh(ui.chat);
  openSheet('<h3>' + tr('Message', 'پیغام') + '</h3><div class="btnrow" style="flex-direction:column">' +
    (ch ? '' : '<button class="btn ghost" data-a="reply" data-v="' + esc(mid) + '">' + tr('Reply', 'جواب دیں') + '</button>') +
    (m.t ? '<button class="btn ghost" data-a="copymsg" data-v="' + esc(mid) + '">' + tr('Copy', 'کاپی') + '</button>' : '') +
    (m.me && (m.st || 0) < 2 && !ch ? '<button class="btn ghost" data-a="resend" data-v="' + esc(mid) + '">' + tr('Send again', 'دوبارہ بھیجیں') + '</button>' : '') +
    '<button class="btn bad" data-a="delmsg" data-v="' + esc(mid) + '">' + tr('Delete for me', 'میرے لیے حذف کریں') + '</button>' +
    '<button class="btn ghost" data-a="closesheet">' + tr('Close', 'بند') + '</button></div>');
}

function menuSheet() {
  const k = ui.chat, ch = isCh(k), mk = ch ? 'ch:' + chName(k) : k;
  openSheet('<h3>' + esc(title(k)) + '</h3><div class="btnrow" style="flex-direction:column">' +
    (ch ? '' : '<button class="btn" data-a="locate" data-v="' + esc(k) + '">📍 ' + tr('Find this person', 'اس شخص کو تلاش کریں') + '</button>') +
    '<button class="btn ghost" data-a="mutechat" data-v="' + esc(mk) + '">' + (DB.muted[mk] ? tr('Unmute notifications', 'نوٹیفکیشن آن کریں') : tr('Mute notifications', 'نوٹیفکیشن خاموش کریں')) + '</button>' +
    (!ch && !CT()[k] ? '<button class="btn ghost" data-a="savep" data-v="' + esc(k) + '">' + tr('Save contact', 'رابطہ محفوظ کریں') + '</button>' : '') +
    '<button class="btn ghost" data-a="clearchat">' + tr('Clear chat', 'چیٹ صاف کریں') + '</button>' +
    (ch ? '<button class="btn bad" data-a="leavech">' + tr('Leave channel', 'چینل چھوڑیں') + '</button>'
        : '<button class="btn bad" data-a="blockchat" data-v="' + esc(k) + '">' + tr('Block this number', 'یہ نمبر بلاک کریں') + '</button>') +
    '<button class="btn ghost" data-a="closesheet">' + tr('Close', 'بند') + '</button></div>');
}

/* ---- find a friend ---- */
function renderLocate() {
  const L = ui.locate; if (!L) return;
  const p = peerFor(L.num);
  let status, pct;
  if (!p) { status = tr('Not in range right now', 'ابھی رینج میں نہیں'); pct = 0; }
  else if (p.near) { status = tr('Direct link. Very close (about 10 m or less).', 'براہ راست لنک۔ بہت قریب (تقریباً 10 میٹر یا کم)۔'); pct = 100; }
  else { status = p.hp + ' ' + tr('hops away (roughly ' + p.hp * 10 + ' m)', 'ہاپ دور (تقریباً ' + p.hp * 10 + ' میٹر)'); pct = Math.max(15, 100 - p.hp * 22); }
  const seen = p ? (p.age < 5 ? tr('Heard just now', 'ابھی سنا') : tr('Last heard ', 'آخری بار ') + p.age + 's') : '';
  const pg = L.pong ? (L.pong.ms >= 0 ? tr('Reply in ', 'جواب ') + L.pong.ms + ' ms · ' + L.pong.hp + ' ' + tr('hop(s)', 'ہاپ') : tr('No reply. They may be out of range.', 'کوئی جواب نہیں۔ شاید رینج سے باہر ہیں۔')) : '';
  const quick = [tr('Where are you?', 'آپ کہاں ہیں؟'), tr("I'm at the entrance", 'میں گیٹ پر ہوں'), tr("I'm coming", 'میں آ رہا ہوں'), tr('Call me', 'مجھے کال کریں')];
  openSheet('<h3>📍 ' + esc(nameOf(L.num)) + '</h3><p class="t1" style="margin:4px 0">' + status + '</p><div class="meter"><i style="width:' + pct + '%"></i></div><p class="hint">' + seen + '</p>' +
    (pg ? '<p class="t1">' + pg + '</p>' : '') +
    '<div class="chips">' + quick.map(q => '<button class="chipb" data-a="quick" data-v="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div>' +
    '<div class="btnrow"><button class="btn grow" data-a="ping" data-v="' + esc(L.num) + '">' + tr('Ping', 'پنگ') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Close', 'بند') + '</button></div>');
}

/* ---- voice notes ---- */
function startRec() {
  if (IOS) { iosOnly(); return; }
  if (!canContact(ui.chat)) { unsavedSheet(ui.chat, 'voice note'); return; }
  if (!N.hasMic()) { N.requestPerms(); return; }
  if (!N.vnStart()) { toast(tr('Microphone is busy or not allowed', 'مائیکروفون مصروف ہے یا اجازت نہیں')); return; }
  ui.rec = { t0: Date.now() };
  renderCompose();
  clearInterval(ui.rt);
  ui.rt = setInterval(() => {
    if (!ui.rec) return;
    const s = Math.floor((Date.now() - ui.rec.t0) / 1000);
    const e = $('#rect'); if (e) e.textContent = fmtDur(s);
    if (s >= 15) finishRec(true);
  }, 250);
}
function finishRec(send) {
  clearInterval(ui.rt);
  if (!ui.rec) return;
  ui.rec = null;
  let r = {};
  if (send) { try { r = JSON.parse(N.vnStop()); } catch (e) {} } else { N.vnCancel(); }
  renderCompose();
  if (!send) return;
  if (!r.ok) { toast(tr('Too short', 'بہت مختصر')); return; }
  const k = ui.chat; if (!k || isCh(k)) return;
  addMsg(k, { mid: r.id, me: true, k: 'vn', dur: r.dur, t: '', ts: Date.now(), st: 0, via: DB.mode });
  save(); N.sendFile(k, r.id, 'vn', r.dur, DB.mode);
  updateMsgs(true);
}

/* ---- contacts / profile sheets ---- */
function contactSheet(num) {
  const c = CT()[num] || { name: DB.names[num] || '', num: num || '' };
  openSheet('<h3>' + (CT()[num] ? tr('Edit contact', 'رابطہ تبدیل کریں') : tr('Save contact', 'رابطہ محفوظ کریں')) + '</h3>' +
    '<label class="lbl">' + tr('Name', 'نام') + '</label><input class="inp" id="cName" maxlength="24" value="' + esc(c.name) + '">' +
    '<label class="lbl">' + tr('Number', 'نمبر') + '</label><input class="inp" id="cNum" inputmode="numeric" maxlength="15" style="direction:ltr" value="' + esc(c.num) + '" ' + (CT()[num] ? 'readonly' : '') + '>' +
    (CT()[num] ? '' : '<label class="sw"><span class="hint">' + tr('Save in both Bluetooth and Wi-Fi sections', 'بلوٹوتھ اور وائی فائی دونوں سیکشنز میں محفوظ کریں') + '</span><input type="checkbox" id="cBoth" checked></label>') +
    '<div class="btnrow"><button class="btn grow" data-a="savec">' + tr('Save', 'محفوظ') + '</button>' +
    (CT()[num] ? '<button class="btn bad" data-a="delc" data-v="' + esc(num) + '">' + tr('Delete', 'حذف') + '</button>' : '') +
    '<button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}
function meSheet() {
  const av = Number.isInteger(ui.editAv) ? ui.editAv : (Number.isInteger(DB.me.av) ? DB.me.av : 0);
  openSheet('<h3>' + tr('My number', 'میرا نمبر') + '</h3>' +
    '<label class="lbl">' + tr('Name', 'نام') + '</label><input class="inp" id="mName" maxlength="24" value="' + esc(DB.me.name) + '">' +
    '<label class="lbl">' + tr('Number (11 digits)', 'نمبر (11 ہندسے)') + '</label><input class="inp" id="mNum" inputmode="numeric" maxlength="11" style="direction:ltr" value="' + esc(DB.me.num) + '">' +
    '<label class="lbl">' + tr('Colour', 'رنگ') + '</label>' + swatches(av, 'editav') +
    '<div class="btnrow"><button class="btn grow" data-a="saveme">' + tr('Save', 'محفوظ') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}
function joinSheet() {
  const sug = ['campus', 'library', 'hostel', 'canteen', 'help', 'lost-found'];
  openSheet('<h3>' + tr('Join a channel', 'چینل میں شامل ہوں') + '</h3><p class="hint">' + tr('Letters, numbers and dashes. Everyone who types the same name joins the same open channel.', 'حروف، ہندسے اور ڈیش۔ ایک ہی نام لکھنے والے سب ایک ہی اوپن چینل میں آتے ہیں۔') + '</p>' +
    '<input class="inp" id="chN" maxlength="24" placeholder="campus" style="direction:ltr"><div class="chips">' +
    sug.map(s => '<button class="chipb" data-a="chpick" data-v="' + s + '">#' + s + '</button>').join('') + '</div>' +
    '<div class="btnrow"><button class="btn grow" data-a="chjoin">' + tr('Join', 'شامل ہوں') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}
function netSheet() {
  let n = {}; try { n = JSON.parse(N.netInfo() || '{}'); } catch (e) {}
  const nb = (n.neighbors || []).map(x => '<div class="kv"><span>' + esc(x.name || x.num || x.id) + '</span><span class="chip ' + (x.via === 'wifi' ? 'on' : '') + '">' + (x.kind === 'paired' ? tr('Bluetooth (paired)', 'بلوٹوتھ (جوڑا بنایا)') : x.kind === 'nearby' ? tr('Bluetooth (auto)', 'بلوٹوتھ (آٹو)') : 'Wi-Fi') + ' · ' + (x.age == null ? '' : x.age + 's') + '</span></div>').join('');
  openSheet('<h3>' + tr('Network view', 'نیٹ ورک ویو') + '</h3>' +
    '<div class="kv"><span>' + tr('Direct links', 'براہ راست لنک') + '</span><b>' + (n.neighbors || []).length + '</b></div>' +
    '<div class="kv"><span>' + tr('Phones seen', 'نظر آنے والے فون') + '</span><b>' + (n.peers || 0) + '</b></div>' +
    '<div class="kv"><span>' + tr('Packets relayed for others', 'دوسروں کے لیے آگے بھیجے گئے') + '</span><b>' + (n.relayed || 0) + '</b></div>' +
    '<div class="kv"><span>' + tr('Messages waiting to be delivered', 'ڈیلیوری کے منتظر پیغام') + '</span><b>' + (n.stored || 0) + '</b></div>' +
    '<div class="kv"><span>' + tr('Battery', 'بیٹری') + '</span><b>' + (n.battery == null ? '-' : n.battery + '%') + '</b></div>' +
    '<div class="kv"><span>' + tr('Relaying', 'ریلے') + '</span><b>' + (n.relayOn ? tr('On', 'آن') : (n.relay ? tr('Paused (low battery)', 'رکا ہوا (کم بیٹری)') : tr('Off', 'بند'))) + '</b></div>' +
    '<div class="kv"><span>' + tr('Wi-Fi link', 'وائی فائی لنک') + '</span><b>' + (n.lan ? tr('On', 'آن') : tr('Off', 'بند')) + '</b></div>' +
    '<div class="kv"><span>' + tr('Device ID', 'ڈیوائس آئی ڈی') + '</span><b style="direction:ltr">' + esc(n.id || '') + '</b></div>' +
    (nb ? '<h2 class="sec">' + tr('Connected to', 'منسلک') + '</h2>' + nb : '') +
    '<div class="btnrow"><button class="btn grow" data-a="net">' + tr('Refresh', 'ریفریش') + '</button><button class="btn" data-a="reconnect">' + tr('Reconnect now', 'ابھی دوبارہ جوڑیں') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Close', 'بند') + '</button></div>');
}

/* ---- app lock ---- */
async function hashPin(pin, salt) {
  try {
    const d = new TextEncoder().encode(salt + ':' + pin);
    const h = await crypto.subtle.digest('SHA-256', d);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    let x = 5381; const s = salt + ':' + pin;
    for (let r = 0; r < 2000; r++) for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
    return 'f' + x;
  }
}
function showLock() {
  if (!DB.pin) return;
  ui.locked = true; ui.lk = '';
  const o = $('#lock'); o.classList.add('on');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'bs'];
  o.innerHTML = '<div style="font-size:44px">🔒</div><h2>NearCall</h2><p class="cst" style="margin:6px 0 4px">' + tr('Enter your PIN', 'اپنا PIN لکھیں') + '</p><div class="dots" id="dots">' +
    '<i></i><i></i><i></i><i></i><i></i><i></i></div><div class="pad">' +
    keys.map(k => k === '' ? '<span></span>' : '<button class="k" data-a="' + (k === 'bs' ? 'lkbs' : 'lk') + '" data-v="' + k + '">' + (k === 'bs' ? '⌫' : k) + '</button>').join('') + '</div>';
}
function drawDots() { const d = document.querySelectorAll('#dots i'); d.forEach((e, i) => e.classList.toggle('on', i < ui.lk.length)); }
async function tryUnlock() {
  const h = await hashPin(ui.lk, DB.salt);
  if (h === DB.pin) {
    ui.locked = false; ui.lk = ''; $('#lock').classList.remove('on'); $('#lock').innerHTML = '';
    render(); try { window.onNativeResume(); } catch (e) {}
  } else if (ui.lk.length >= 6) {
    ui.lk = ''; drawDots(); toast(tr('Wrong PIN', 'غلط PIN'));
  }
}
function pinSheet() {
  openSheet('<h3>' + tr('Set app lock', 'ایپ لاک لگائیں') + '</h3><p class="hint">' + tr('4 to 6 digits. The app also hides its screen in recent apps and blocks screenshots while the lock is on.', '4 سے 6 ہندسے۔ لاک آن ہو تو ایپ حالیہ ایپس میں اپنی اسکرین چھپاتی ہے اور اسکرین شاٹ روکتی ہے۔') + '</p>' +
    '<label class="lbl">PIN</label><input class="inp" id="p1" type="password" inputmode="numeric" maxlength="6" style="direction:ltr">' +
    '<label class="lbl">' + tr('Repeat PIN', 'PIN دوبارہ لکھیں') + '</label><input class="inp" id="p2" type="password" inputmode="numeric" maxlength="6" style="direction:ltr">' +
    '<div class="btnrow"><button class="btn grow" data-a="pinsave">' + tr('Save', 'محفوظ') + '</button><button class="btn ghost" data-a="closesheet">' + tr('Cancel', 'منسوخ') + '</button></div>');
}

/* ---- actions ---- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  act(el.dataset.a, el.dataset.v, el);
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !el.dataset.a) return;
  switch (el.dataset.a) {
    case 'relay': DB.relay = el.checked; save(); N.setRelay(DB.relay); break;
    case 'lan': DB.lan = el.checked; save(); N.setLan(DB.lan); break;
    case 'conly': toggleConly(el); break;
    case 'onlyk': DB.onlyKnown = el.checked; save(); render(); break;
    case 'hideu': DB.hideUnknown = el.checked; save(); render(); break;
    case 'btl': DB.btl = el.checked; save(); N.setBt(DB.btl); break;
    case 'nbl': DB.nbl = el.checked; save(); N.setNearby(DB.nbl); break;
    case 'qon': DB.quiet.on = el.checked; save(); syncNotify(); break;
    case 'qs': DB.quiet.s = parseInt(el.value, 10); save(); syncNotify(); break;
    case 'qe': DB.quiet.e = parseInt(el.value, 10); save(); syncNotify(); break;
  }
});
document.addEventListener('keydown', e => {
  if (e.target && e.target.id === 'cin' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function act(a, v) {
  switch (a) {
    case 'tab': ui.tab = v; render(); break;
    case 'mode': DB.mode = v; save(); render(); break;
    case 'showunk': if (DB.contactsOnly) { conlySheet(); break; } DB.onlyKnown = false; save(); render(); break;
    case 'conlyyes': enableConly(); break;
    case 'savenum': closeSheet(); contactSheet(v); break;
    case 'managec': ui.tab = 'people'; render(); break;
    case 'open': ui.chat = v; DB.unread[ukey(v)] = 0; ui.draft = ''; ui.reply = null; save(); render(); break;
    case 'back': leaveChat(); break;
    case 'menu': menuSheet(); break;
    case 'key': if (ui.dial.length < 15) { ui.dial += v; updateDial(); } break;
    case 'bs': ui.dial = ui.dial.slice(0, -1); updateDial(); break;
    case 'fill': ui.dial = v; updateDial(); break;
    case 'dialcall': placeCall(ui.dial); break;
    case 'dialmsg': if (/^\d{3,15}$/.test(ui.dial)) { if (!canContact(ui.dial)) { unsavedSheet(ui.dial, 'message'); break; } ui.chat = ui.dial; ui.draft = ''; render(); } else toast(tr('Enter a valid number', 'درست نمبر لکھیں')); break;
    case 'call': placeCall(v); break;
    case 'send': sendMsg(); break;
    case 'mic': startRec(); break;
    case 'recsend': finishRec(true); break;
    case 'reccancel': finishRec(false); break;
    case 'attach': if (IOS) { iosOnly(); break; } if (!canContact(ui.chat)) { unsavedSheet(ui.chat, 'photo'); break; } ui.imgTo = ui.chat; N.pickImage(rnd()); break;
    case 'view': { const o = $('#view'); o.innerHTML = '<img src="/media/img/' + esc(v) + '.jpg" alt="" data-a="closeview">'; o.classList.add('on'); break; }
    case 'closeview': $('#view').classList.remove('on'); break;
    case 'vnplay':
      if (ui.playing === v) { N.vnStopPlay(); ui.playing = ''; } else { N.vnPlay(v); ui.playing = v; }
      updateMsgs(); break;
    case 'bub': bubSheet(v); break;
    case 'reply': {
      const m = findMsg(v); closeSheet();
      if (m) { ui.reply = { m: m.mid, t: snippet(m) }; renderReplyBar(); const t = $('#cin'); if (t) t.focus(); }
      break;
    }
    case 'noreply': ui.reply = null; renderReplyBar(); break;
    case 'copymsg': { const m = findMsg(v); if (m) { N.copy(m.t); toast(tr('Copied', 'کاپی ہو گیا')); } closeSheet(); break; }
    case 'delmsg': { const a = thread(ui.chat), i = a.findIndex(m => m.mid === v); if (i >= 0) a.splice(i, 1); save(); closeSheet(); updateMsgs(); break; }
    case 'resend': {
      const m = findMsg(v); closeSheet(); if (!m || isCh(ui.chat)) break;
      if (m.k) N.sendFile(ui.chat, m.mid, m.k, m.dur || 0, viaOf(m));
      else N.send(ui.chat, m.mid, m.t, m.rp ? JSON.stringify(m.rp) : '', viaOf(m));
      toast(tr('Sending again…', 'دوبارہ بھیج رہے ہیں…')); break;
    }
    case 'locate': closeSheet(); ui.locate = { num: v, pong: null }; renderLocate(); break;
    case 'ping': if (ui.locate) { ui.locate.pong = null; N.ping(v); toast(tr('Pinging…', 'پنگ ہو رہا ہے…')); } break;
    case 'quick': { const n = ui.locate && ui.locate.num; if (n) { if (sendDm(n, v, null)) { toast(tr('Sent', 'بھیج دیا')); if (ui.chat === n) updateMsgs(true); } } break; }
    case 'mutechat': DB.muted[v] = !DB.muted[v]; save(); syncNotify(); closeSheet(); toast(DB.muted[v] ? tr('Muted', 'خاموش') : tr('Unmuted', 'آن')); break;
    case 'clearchat': { const a = thread(ui.chat); a.length = 0; save(); closeSheet(); updateMsgs(); break; }
    case 'leavech': { const n = chName(ui.chat); N.leaveChannel(n); delete DB.ch[n]; delete DB.unread[ui.chat]; save(); closeSheet(); leaveChat(); break; }
    case 'blockchat': DB.blocked[v] = true; N.block(v, true); save(); closeSheet(); leaveChat(); toast(tr('Blocked', 'بلاک')); break;
    case 'unblock': delete DB.blocked[v]; N.block(v, false); save(); render(); break;
    case 'trust': N.trust(v); ui.conf[v] = false; toast(tr('New device trusted', 'نئے ڈیوائس پر بھروسہ کیا')); renderChat(); break;
    case 'addc': contactSheet(''); break;
    case 'editc': contactSheet(v); break;
    case 'savep': closeSheet(); contactSheet(v); break;
    case 'savec': {
      const name = $('#cName').value.trim(), num = $('#cNum').value.trim();
      if (!name || !/^\d{3,15}$/.test(num)) { toast(tr('Enter a name and a valid number', 'نام اور درست نمبر لکھیں')); break; }
      const bothEl = $('#cBoth'), had = !!CT(otherOf(DB.mode))[num];
      CT()[num] = { name, num };
      if ((bothEl && bothEl.checked) || had) CT(otherOf(DB.mode))[num] = { name, num };
      save(); syncAllowed(); closeSheet(); render(); break;
    }
    case 'delc': delete DB.cts.bt[v]; delete DB.cts.wifi[v]; save(); syncAllowed(); closeSheet(); render(); break;
    case 'closesheet': closeSheet(); break;
    case 'joinch': joinSheet(); break;
    case 'chpick': $('#chN').value = v; break;
    case 'chjoin': {
      const n = $('#chN').value.trim().toLowerCase().replace(/[^a-z0-9\-]/g, '');
      if (!n) { toast(tr('Enter a channel name', 'چینل کا نام لکھیں')); break; }
      if (!DB.ch[n]) DB.ch[n] = [];
      N.joinChannel(n); save(); closeSheet(); ui.tab = 'chan'; ui.chat = '#' + n; render(); break;
    }
    case 'sos': sosSheet(); break;
    case 'sossend': { const t = $('#sosT').value.trim(); N.sos(t); closeSheet(); toast(tr('SOS sent to everyone in reach', 'SOS رسائی میں موجود سب کو بھیج دیا')); break; }
    case 'sosx': $('#sos').classList.remove('on'); $('#sos').innerHTML = ''; break;
    case 'soscall': $('#sos').classList.remove('on'); placeCall(v); break;
    case 'sosmsg': $('#sos').classList.remove('on'); ui.chat = v; render(); break;
    case 'editme': ui.editAv = Number.isInteger(DB.me.av) ? DB.me.av : 0; meSheet(); break;
    case 'editav': ui.editAv = parseInt(v, 10); { const n = $('#mName').value, m = $('#mNum').value; meSheet(); $('#mName').value = n; $('#mNum').value = m; } break;
    case 'setav': ui.setupAv = parseInt(v, 10); { const n = $('#sName').value, m = $('#sNum').value; renderSetup(); $('#sName').value = n; $('#sNum').value = m; } break;
    case 'saveme': {
      const name = $('#mName').value.trim(), num = $('#mNum').value.trim();
      if (!name || !/^\d{11}$/.test(num)) { toast(tr('Name and an 11-digit number are required', 'نام اور 11 ہندسوں کا نمبر ضروری ہے')); break; }
      DB.me = { name, num, av: Number.isInteger(ui.editAv) ? ui.editAv : 0 }; save(); closeSheet(); startNative(); render(); break;
    }
    case 'lang': DB.lang = DB.lang === 'ur' ? 'en' : 'ur'; save(); render(); break;
    case 'theme': DB.theme = v; save(); render(); break;
    case 'gen': $('#sNum').value = genNum(); break;
    case 'setup': {
      const name = $('#sName').value.trim(), num = $('#sNum').value.trim();
      if (!name) { toast(tr('Enter your name', 'اپنا نام لکھیں')); break; }
      if (!/^\d{11}$/.test(num)) { toast(tr('Number must be exactly 11 digits', 'نمبر بالکل 11 ہندسوں کا ہونا چاہیے')); break; }
      DB.me = { name, num, av: Number.isInteger(ui.setupAv) ? ui.setupAv : 0 }; save(); ui.tab = 'chats'; render();
      if (N.hasPerms()) startNative(); else N.requestPerms();
      break;
    }
    case 'perm': N.requestPerms(); break;
    case 'battery': N.batterySettings(); break;
    case 'hotspot': N.openHotspot(); break;
    case 'btsettings': N.openBluetooth(); break;
    case 'wifi': N.openWifi(); break;
    case 'startsvc': startNative(); break;
    case 'stopsvc': N.stop(); RUN = false; PEERS = []; NEAR = 0; render(); break;
    case 'net': netSheet(); break;
    case 'reconnect': N.reconnect(); toast(tr('Reconnecting Bluetooth and Wi-Fi…', 'بلوٹوتھ اور وائی فائی دوبارہ جوڑ رہے ہیں…')); break;
    case 'shareapk': if (IOS) iosOnly(); else N.shareApk(); break;
    case 'backup': if (IOS) { iosOnly(); break; } { const o = JSON.parse(JSON.stringify(DB)); o.pin = ''; o.salt = ''; N.backup(JSON.stringify({ v: 2, db: o })); break; }
    case 'restore': if (IOS) iosOnly(); else N.restore(); break;
    case 'applock':
      if (DB.pin) { DB.pin = ''; DB.salt = ''; save(); N.secure(false); toast(tr('App lock removed', 'ایپ لاک ہٹ گیا')); render(); } else pinSheet();
      break;
    case 'pinsave': {
      const a = $('#p1').value, b = $('#p2').value;
      if (!/^\d{4,6}$/.test(a)) { toast(tr('Use 4 to 6 digits', '4 سے 6 ہندسے استعمال کریں')); break; }
      if (a !== b) { toast(tr('PINs do not match', 'PIN مختلف ہیں')); break; }
      DB.salt = rnd();
      hashPin(a, DB.salt).then(h => { DB.pin = h; save(); N.secure(true); closeSheet(); render(); toast(tr('App lock is on', 'ایپ لاک آن ہے')); });
      break;
    }
    case 'lk': if (ui.lk.length < 6) { ui.lk += v; drawDots(); if (ui.lk.length >= 4) tryUnlock(); } break;
    case 'lkbs': ui.lk = ui.lk.slice(0, -1); drawDots(); break;
    case 'accept': if (!N.hasMic()) { N.requestPerms(); } else N.accept(); break;
    case 'reject': N.reject(); break;
    case 'endcall': N.end(); break;
    case 'mute': ui.mute = !ui.mute; N.mute(ui.mute); renderCall(); break;
    case 'spk': ui.spk = !ui.spk; N.speaker(ui.spk); renderCall(); break;
  }
}

/* ---- boot ---- */
applyLang(); applyTheme();
render();
if (DB.pin) { N.secure(true); showLock(); }
if (DB.me) {
  if (N.hasPerms()) startNative(); else { ui.perm = false; render(); }
  try { window.onNativeResume(); } catch (e) {}
}
