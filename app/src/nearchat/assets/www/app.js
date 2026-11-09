'use strict';
/* NearChat: a BitChat-style mesh chat. No accounts, no phone numbers, no servers.
   Identity = a random nickname + a fingerprint made from your key. Public room "#mesh", private encrypted DMs,
   optional password channels, IRC-style commands, nothing is kept unless you ask, triple-tap the logo to wipe. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rnd = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmtT = ts => { const d = new Date(ts), p = x => String(x).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()); };

/* ---- native bridge (harmless mock in a desktop browser) ---- */
const MOCK = {
  identity: () => '{"fp":"a1b2c3d4e5f6"}', hasPerms: () => true, requestPerms() { setTimeout(() => window.onPerms && onPerms(true), 30); },
  start: () => true, isRunning: () => true, snapshot() {}, drain: () => '[]', netInfo: () => '{}', send() {}, sendChannel() {},
  joinChannelPw() {}, leaveChannel() {}, block() {}, trust() {}, setRelay() {}, setLan() {}, setBt() {}, setNearby() {}, setNotify() {},
  reconnect() {}, openBluetooth() {}, wipe() {}, getInsets: () => '0,0,0,0', batteryOk: () => true
};
const N = window.AndroidNative || MOCK;

/* ---- settings (small, kept) ---- */
const KEY = 'nearchat:v1', HKEY = 'nearchat:hist';
const DEF = () => ({ nick: '', theme: 'green', relay: true, lan: true, bt: true, nb: true, keep: false, chans: { mesh: '' }, fav: {}, blocked: {}, welcomed: false });
let ST = Object.assign(DEF(), (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } })());
if (!ST.chans || typeof ST.chans.mesh !== 'string') ST.chans = Object.assign({ mesh: '' }, ST.chans || {});
const saveST = () => { try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) {} };

let MY = { fp: '' };
try { MY.fp = JSON.parse(N.identity()).fp || ''; } catch (e) {}
if (!ST.nick) { ST.nick = 'anon' + Math.floor(1000 + Math.random() * 9000); saveST(); }

/* ---- memory-only state (gone when the app closes, unless "keep history" is on) ---- */
let ROOMS = { '#mesh': [] };
if (ST.keep) { try { Object.assign(ROOMS, JSON.parse(localStorage.getItem(HKEY) || '{}')); } catch (e) {} }
const UNREAD = {};
const NAMES = {};
let CUR = '#mesh', PEERS = [], LINK = { bt: 0, wifi: 0 }, RUN = false, first = true;
const ONLINE = new Set();
let tapN = 0, tapT = 0;

const tag = fp => (fp || '').slice(0, 4);
const nameOf = fp => NAMES[fp] || (ST.fav[fp] && ST.fav[fp].name) || 'anon';
const lab = fp => nameOf(fp) + '#' + tag(fp);
const isCh = k => k.charAt(0) === '#';
const roomTitle = k => isCh(k) ? k : '@' + nameOf(k.slice(1));
const saveHist = () => { if (ST.keep) { try { localStorage.setItem(HKEY, JSON.stringify(ROOMS)); } catch (e) {} } };
function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2400); }
const cleanNick = s => String(s || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 16);
function applyTheme() { if (ST.theme === 'green') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', ST.theme); }

/* ---- rooms and lines ---- */
function addLine(room, m) {
  const a = ROOMS[room] || (ROOMS[room] = []);
  a.push(m);
  if (a.length > 300) a.splice(0, a.length - 300);
  saveHist();
  if (room === CUR) renderLog(); else if (!m.sys && !m.me) UNREAD[room] = (UNREAD[room] || 0) + 1;
  renderRooms();
}
const sys = (text, room) => addLine(room || CUR, { sys: true, text, ts: Date.now() });

function openRoom(k) {
  if (!ROOMS[k]) ROOMS[k] = [];
  CUR = k; UNREAD[k] = 0;
  closePanel(); closeSheet();
  renderRooms(); renderLog();
  $('#inp').focus();
}

function renderRooms() {
  const keys = Object.keys(ROOMS);
  $('#rooms').innerHTML = keys.map(k => '<button class="rm' + (k === CUR ? ' on' : '') + '" data-a="room" data-v="' + esc(k) + '">' + esc(roomTitle(k)) +
    (UNREAD[k] ? '<i>' + UNREAD[k] + '</i>' : '') + '</button>').join('');
  $('#me').textContent = ST.nick + '#' + tag(MY.fp) + ' · ' + (RUN ? 'bt ' + LINK.bt + ' wifi ' + LINK.wifi : 'offline');
  $('#pc').textContent = PEERS.length;
}

const mentionRe = () => new RegExp('@' + ST.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

function renderLog() {
  const box = $('#log');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const re = mentionRe();
  const dm = !isCh(CUR);
  box.innerHTML = (ROOMS[CUR] || []).map(m => {
    if (m.sys) return '<div class="ln sys">' + esc(m.text) + '</div>';
    const who = m.me ? ST.nick : (m.name || nameOf(m.fp));
    const at = !m.me && re.test(m.text);
    let meta = '';
    if (m.me) meta = dm ? (m.st === 2 ? ' ✓✓' : m.st === 1 ? ' ✓' : ' …') : (m.st >= 1 ? ' ✓' : '');
    else if (m.hp > 1) meta = ' · ' + m.hp + ' hops';
    const bad = (!m.me && !dm && m.ok === false) ? ' <span class="bad" title="not signed">?</span>' : '';
    return '<div class="ln' + (m.me ? ' me' : '') + (at ? ' at' : '') + '"><span class="t">' + fmtT(m.ts) + '</span> <span class="who">&lt;' + esc(who) +
      '<i>#' + esc(tag(m.me ? MY.fp : m.fp)) + '</i>&gt;</span> <span class="tx">' + esc(m.text) + '</span><span class="meta">' + meta + '</span>' + bad + '</div>';
  }).join('');
  if (near || box.dataset.first !== '1') { box.scrollTop = box.scrollHeight; box.dataset.first = '1'; }
}

/* ---- people / channels panel ---- */
function renderPanel() {
  const peers = PEERS.filter(p => !ST.blocked[p.num]);
  const nearTxt = p => (p.near ? 'direct' : p.hp + ' hops') + (p.btc && p.wfc ? ' · bt+wifi' : p.btc ? ' · bt' : p.wfc ? ' · wifi' : '');
  const offFav = Object.keys(ST.fav).filter(fp => !PEERS.some(p => p.num === fp));
  $('#panel').innerHTML =
    '<h3>channels</h3>' + Object.keys(ST.chans).map(c => '<div class="pr" data-a="room" data-v="#' + esc(c) + '"><span class="n">#' + esc(c) + (ST.chans[c] ? ' 🔒' : '') +
      '</span><span class="s">' + (c === 'mesh' ? 'public' : '') + '</span></div>').join('') +
    '<div style="margin-top:8px"><input type="text" id="jn" placeholder="#channel  (password)" autocapitalize="off" style="width:100%;background:none;border:1px solid var(--line);border-radius:6px;padding:8px;color:var(--fg)"></div>' +
    '<button class="btn" data-a="join">join</button>' +
    '<h3>nearby · ' + peers.length + '</h3>' +
    (peers.length ? peers.map(p => '<div class="pr" data-a="dm" data-v="' + esc(p.num) + '"><span class="n">' + esc(p.name || 'anon') + '<i>#' + esc(tag(p.num)) + '</i>' +
      (p.conflict ? ' ⚠' : '') + '</span><span class="s">' + nearTxt(p) + '</span><span class="st" data-a="fav" data-v="' + esc(p.num) + '">' + (ST.fav[p.num] ? '★' : '☆') + '</span></div>').join('')
      : '<div class="hint">nobody in range yet. messages hop through phones that run the app.</div>') +
    (offFav.length ? '<h3>favorites (offline)</h3>' + offFav.map(fp => '<div class="pr" data-a="dm" data-v="' + esc(fp) + '"><span class="n">' + esc(ST.fav[fp].name || 'anon') +
      '<i>#' + esc(tag(fp)) + '</i></span><span class="s">away</span><span class="st" data-a="fav" data-v="' + esc(fp) + '">★</span></div>').join('') : '');
}
function openPanel() { renderPanel(); $('#panel').classList.add('on'); $('#shade').classList.add('on'); }
function closePanel() { $('#panel').classList.remove('on'); $('#shade').classList.remove('on'); }

/* ---- sheets ---- */
function openSheet(html) { const s = $('#sheet'); s.innerHTML = '<div class="in">' + html + '</div>'; s.classList.add('on'); }
function closeSheet() { const s = $('#sheet'); s.classList.remove('on'); s.innerHTML = ''; }
const sw = (a, on) => '<input type="checkbox" class="sw" data-a="' + a + '"' + (on ? ' checked' : '') + '>';

function settingsSheet() {
  openSheet('<h2>settings</h2>' +
    '<div class="row"><span>nickname</span></div><input type="text" id="nk" maxlength="16" value="' + esc(ST.nick) + '" autocapitalize="off"><button class="btn f" data-a="savenick">save nickname</button>' +
    '<div class="row"><span>bluetooth (paired phones)</span>' + sw('t_bt', ST.bt) + '</div>' +
    '<div class="row"><span>bluetooth auto-discovery</span>' + sw('t_nb', ST.nb) + '</div>' +
    '<div class="row"><span>wi-fi / hotspot</span>' + sw('t_lan', ST.lan) + '</div>' +
    '<div class="row"><span>relay messages for others</span>' + sw('t_relay', ST.relay) + '</div>' +
    '<div class="row"><span>keep history on this phone</span>' + sw('t_keep', ST.keep) + '</div>' +
    '<div class="row"><span>theme</span><span><button class="btn" data-a="theme" data-v="green">green</button><button class="btn" data-a="theme" data-v="amber">amber</button><button class="btn" data-a="theme" data-v="light">light</button></span></div>' +
    '<p class="hint">links: pair phones once in Android Bluetooth settings for the steadiest Bluetooth link. Wi-Fi works when phones share a hotspot.</p>' +
    '<button class="btn" data-a="pair">pair phones</button><button class="btn" data-a="reconnect">reconnect now</button><button class="btn" data-a="net">network</button>' +
    '<h2 style="margin-top:14px">danger</h2><button class="btn bad" data-a="panic">wipe everything now</button> <span class="hint">(or triple-tap the logo)</span>' +
    '<div><button class="btn" data-a="closesheet">close</button></div>');
}

function netSheet() {
  let n = {}; try { n = JSON.parse(N.netInfo() || '{}'); } catch (e) {}
  const nb = (n.neighbors || []).map(x => '<div class="row"><span>' + esc(x.name || x.num || x.id) + '</span><span class="hint">' +
    (x.kind === 'paired' ? 'bluetooth (paired)' : x.kind === 'nearby' ? 'bluetooth (auto)' : 'wi-fi') + ' · ' + (x.age == null ? '' : x.age + 's') + '</span></div>').join('');
  openSheet('<h2>network</h2><div class="row"><span>direct links</span><b>' + (n.neighbors || []).length + '</b></div>' +
    '<div class="row"><span>phones seen</span><b>' + (n.peers || 0) + '</b></div>' +
    '<div class="row"><span>relayed for others</span><b>' + (n.relayed || 0) + '</b></div>' +
    '<div class="row"><span>waiting to deliver</span><b>' + (n.stored || 0) + '</b></div>' +
    '<div class="row"><span>battery</span><b>' + (n.battery == null ? '-' : n.battery + '%') + '</b></div>' +
    '<div class="row"><span>your id</span><b>' + esc(MY.fp) + '</b></div>' + nb +
    '<button class="btn f" data-a="net">refresh</button><button class="btn" data-a="closesheet">close</button>');
}

function welcomeSheet() {
  openSheet('<h2>welcome to nearchat</h2><p>no accounts. no phone numbers. no servers.</p>' +
    '<p>you are <b>' + esc(ST.nick) + '#' + esc(tag(MY.fp)) + '</b>. the part after # is made from your key, so nobody can pretend to be you.</p>' +
    '<p>#mesh is a public room for everyone in range. messages hop from phone to phone (up to 200 hops). tap <b>people</b> to open a private encrypted chat. type <b>/help</b> for commands.</p>' +
    '<p class="hint">nothing is saved unless you turn on "keep history". triple-tap the logo to wipe everything.</p>' +
    '<button class="btn f" data-a="closesheet">got it</button>');
  ST.welcomed = true; saveST();
}

/* ---- people lookup ---- */
function findPeer(q) {
  q = String(q || '').trim().replace(/^@/, '').toLowerCase();
  if (!q) return null;
  const list = PEERS.filter(p => !ST.blocked[p.num]);
  let hit = list.filter(p => (p.name + '#' + tag(p.num)).toLowerCase() === q || p.num.toLowerCase().indexOf(q) === 0);
  if (!hit.length) hit = list.filter(p => (p.name || '').toLowerCase() === q);
  if (hit.length > 1) { sys('more than one match, use nick#' + 'abcd'); return null; }
  return hit[0] || null;
}

/* ---- sending ---- */
function sendPub(chan, text) {
  const mid = rnd();
  addLine('#' + chan, { me: true, fp: MY.fp, name: ST.nick, text, ts: Date.now(), mid, st: 0 });
  N.sendChannel(chan, mid, text);
}
function sendDm(fp, text) {
  if (ST.blocked[fp]) { sys('unblock them first (/unblock)'); return; }
  const mid = rnd();
  addLine('@' + fp, { me: true, fp: MY.fp, name: ST.nick, text, ts: Date.now(), mid, st: 0 });
  N.send(fp, mid, text, '', 'bt');
}
function sendHere(text) { if (isCh(CUR)) sendPub(CUR.slice(1), text); else sendDm(CUR.slice(1), text); }

function joinChan(raw) {
  const m = String(raw || '').trim().match(/^#?([A-Za-z0-9_\-]{1,24})(?:\s+(\S.*))?$/);
  if (!m) { sys('usage: /j #channel [password]'); return; }
  const c = m[1].toLowerCase(), pw = m[2] || '';
  ST.chans[c] = pw; saveST();
  N.joinChannelPw(c, pw);
  openRoom('#' + c);
  sys('joined #' + c + (pw ? ' (password channel: only people with the password can read it)' : ''));
}

function runCmd(line) {
  const parts = line.slice(1).split(/\s+/);
  const c = (parts.shift() || '').toLowerCase(), rest = parts.join(' ').trim();
  switch (c) {
    case 'help': case 'h':
      ['/who  who is in range', '/msg nick text  private encrypted message', '/j #channel [password]  join or create a channel', '/leave  leave this channel',
        '/me action  /hug nick  /slap nick', '/nick name  change nickname', '/fav nick  star someone', '/block nick  /unblock nick', '/clear  clear this screen',
        '/links  link status', '/panic  wipe everything'].forEach(t => sys(t));
      break;
    case 'who': case 'w': {
      const l = PEERS.filter(p => !ST.blocked[p.num]);
      sys(l.length ? 'in range: ' + l.map(p => lab(p.num) + (p.near ? '' : ' (' + p.hp + 'h)')).join(', ') : 'nobody in range yet');
      break;
    }
    case 'msg': case 'm': {
      const sp = rest.indexOf(' ');
      if (sp < 1) { sys('usage: /msg nick text'); break; }
      const p = findPeer(rest.slice(0, sp));
      if (!p) { sys('no such nearby person'); break; }
      openRoom('@' + p.num);
      sendDm(p.num, rest.slice(sp + 1));
      break;
    }
    case 'j': case 'join': joinChan(rest); break;
    case 'leave':
      if (!isCh(CUR) || CUR === '#mesh') { sys('you can only leave channels other than #mesh'); break; }
      { const ch = CUR.slice(1); N.leaveChannel(ch); delete ST.chans[ch]; saveST(); delete ROOMS[CUR]; openRoom('#mesh'); }
      break;
    case 'me': if (rest) sendHere('* ' + ST.nick + ' ' + rest); break;
    case 'hug': case 'slap': {
      const p = findPeer(rest);
      sendHere('* ' + ST.nick + (c === 'hug' ? ' hugs ' : ' slaps ') + (p ? '@' + p.name : (rest || 'everyone')) + (c === 'slap' ? ' with a large trout' : '') + ' *');
      break;
    }
    case 'nick': {
      const n = cleanNick(rest);
      if (!n) { sys('usage: /nick name  (letters, numbers, _ and -)'); break; }
      ST.nick = n; saveST(); N.start(MY.fp, ST.nick, 0); renderRooms(); sys('you are now ' + n + '#' + tag(MY.fp));
      break;
    }
    case 'fav': {
      const p = findPeer(rest);
      if (!p) { sys('no such nearby person'); break; }
      ST.fav[p.num] = { name: p.name }; saveST(); sys('starred ' + lab(p.num));
      break;
    }
    case 'block': {
      const p = findPeer(rest);
      if (!p) { sys('no such nearby person'); break; }
      ST.blocked[p.num] = true; saveST(); N.block(p.num, true); sys('blocked ' + lab(p.num));
      break;
    }
    case 'unblock': {
      const fp = Object.keys(ST.blocked).find(f => (nameOf(f) + '#' + tag(f)).toLowerCase().indexOf(rest.toLowerCase().replace(/^@/, '')) === 0 || f.indexOf(rest) === 0);
      if (!fp) { sys('nobody blocked by that name'); break; }
      delete ST.blocked[fp]; saveST(); N.block(fp, false); sys('unblocked ' + lab(fp));
      break;
    }
    case 'clear': ROOMS[CUR] = []; saveHist(); renderLog(); break;
    case 'links': sys('bluetooth links: ' + LINK.bt + ' · wi-fi links: ' + LINK.wifi + ' · relaying: ' + (ST.relay ? 'on' : 'off')); break;
    case 'panic': panic(); break;
    default: sys('unknown command. try /help');
  }
}

function send() {
  const inp = $('#inp'), t = inp.value.trim();
  inp.value = '';
  if (!t) return;
  if (t.charAt(0) === '/') runCmd(t); else sendHere(t);
}

/* ---- panic ---- */
function panic() {
  try { N.wipe(); } catch (e) {}
  try { localStorage.clear(); } catch (e) {}
  ST = DEF(); ROOMS = { '#mesh': [] }; PEERS = [];
  $('#log').innerHTML = '<div class="ln sys">everything wiped. starting fresh…</div>';
  setTimeout(() => location.reload(), 700);
}

/* ---- native events ---- */
window.onMesh = function (ev) {
  if (!ev || !ev.k) return;
  switch (ev.k) {
    case 'peers': {
      RUN = true; LINK = { bt: ev.nbt || 0, wifi: ev.nwf || 0 };
      PEERS = (ev.list || []).filter(p => p.num && p.num !== MY.fp);
      const now = new Set();
      PEERS.forEach(p => { NAMES[p.num] = p.name || NAMES[p.num] || 'anon'; now.add(p.num); if (ST.fav[p.num] && p.name) ST.fav[p.num].name = p.name; });
      if (!first) {
        now.forEach(fp => { if (!ONLINE.has(fp) && !ST.blocked[fp]) { const p = PEERS.find(x => x.num === fp); sys('* ' + lab(fp) + ' joined (' + (p && p.near ? 'direct' : (p ? p.hp : '?') + ' hops') + ')', '#mesh'); } });
        ONLINE.forEach(fp => { if (!now.has(fp)) sys('* ' + lab(fp) + ' left', '#mesh'); });
      }
      first = false; ONLINE.clear(); now.forEach(f => ONLINE.add(f));
      renderRooms();
      if ($('#panel').classList.contains('on')) renderPanel();
      break;
    }
    case 'status': RUN = !!ev.running; renderRooms(); break;
    case 'chmsg':
      if (ev.from === MY.fp || ST.blocked[ev.from]) break;
      if (ev.name) NAMES[ev.from] = ev.name;
      addLine('#' + ev.ch, { fp: ev.from, name: ev.name, text: ev.text, ts: ev.ts || Date.now(), mid: ev.mid, hp: ev.hp || 1, ok: ev.ok });
      break;
    case 'msg':
      if (ST.blocked[ev.from]) break;
      if (ev.name) NAMES[ev.from] = ev.name;
      addLine('@' + ev.from, { fp: ev.from, name: ev.name, text: ev.text, ts: ev.ts || Date.now(), mid: ev.mid });
      break;
    case 'ack': case 'relayed': {
      const st = ev.k === 'ack' ? 2 : 1;
      for (const r in ROOMS) for (const m of ROOMS[r]) if (m.me && m.mid === ev.mid && (m.st || 0) < st) m.st = st;
      renderLog();
      break;
    }
    case 'conflict': sys('! another phone is using the id ' + ev.num + ' (not trusted)'); break;
    default: break;
  }
};

window.onNativeResume = function () {
  try { JSON.parse(N.drain() || '[]').forEach(window.onMesh); } catch (e) {}
  try { N.snapshot(); } catch (e) {}
};
window.onOpenPeer = function (num) { if (num) openRoom('@' + num); };
window.onPerms = function () { if (N.hasPerms()) startNative(); else toast('bluetooth permission is needed to find phones'); };
window.onBack = function () {
  if ($('#sheet').classList.contains('on')) { closeSheet(); return true; }
  if ($('#panel').classList.contains('on')) { closePanel(); return true; }
  if (CUR !== '#mesh') { openRoom('#mesh'); return true; }
  return false;
};

function startNative() {
  if (!N.hasPerms()) { N.requestPerms(); return; }
  N.start(MY.fp, ST.nick, 0);
  N.setRelay(!!ST.relay); N.setLan(!!ST.lan); N.setBt(!!ST.bt); N.setNearby(!!ST.nb);
  N.setNotify(JSON.stringify({ muted: [], qon: false, qs: 22, qe: 7 }));
  Object.keys(ST.chans).forEach(c => N.joinChannelPw(c, ST.chans[c] || ''));
  Object.keys(ST.blocked).forEach(f => { if (ST.blocked[f]) N.block(f, true); });
  setTimeout(() => { try { N.snapshot(); } catch (e) {} renderRooms(); }, 800);
}

/* ---- clicks ---- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'INPUT') return;
  act(el.dataset.a, el.dataset.v);
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !el.dataset.a) return;
  switch (el.dataset.a) {
    case 't_bt': ST.bt = el.checked; saveST(); N.setBt(ST.bt); break;
    case 't_nb': ST.nb = el.checked; saveST(); N.setNearby(ST.nb); break;
    case 't_lan': ST.lan = el.checked; saveST(); N.setLan(ST.lan); break;
    case 't_relay': ST.relay = el.checked; saveST(); N.setRelay(ST.relay); break;
    case 't_keep': ST.keep = el.checked; saveST(); if (ST.keep) saveHist(); else { try { localStorage.removeItem(HKEY); } catch (x) {} } break;
  }
});
$('#inp').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
$('#go').addEventListener('click', send);
$('#peersBtn').addEventListener('click', openPanel);
$('#menuBtn').addEventListener('click', settingsSheet);
$('#shade').addEventListener('click', closePanel);
$('#logo').addEventListener('click', () => {
  const now = Date.now();
  tapN = now - tapT < 1200 ? tapN + 1 : 1; tapT = now;
  if (tapN >= 3) { tapN = 0; panic(); }
});

function act(a, v) {
  switch (a) {
    case 'room': openRoom(v); break;
    case 'dm': openRoom('@' + v); break;
    case 'fav': {
      if (ST.fav[v]) delete ST.fav[v]; else ST.fav[v] = { name: nameOf(v) };
      saveST(); renderPanel(); break;
    }
    case 'join': { const i = $('#jn'); if (i && i.value.trim()) joinChan(i.value); break; }
    case 'savenick': { const n = cleanNick($('#nk').value); if (!n) { toast('letters, numbers, _ and - only'); break; } ST.nick = n; saveST(); N.start(MY.fp, ST.nick, 0); closeSheet(); renderRooms(); toast('you are ' + n + '#' + tag(MY.fp)); break; }
    case 'theme': ST.theme = v; saveST(); applyTheme(); break;
    case 'pair': N.openBluetooth(); break;
    case 'reconnect': N.reconnect(); toast('reconnecting…'); break;
    case 'net': netSheet(); break;
    case 'panic': panic(); break;
    case 'closesheet': closeSheet(); break;
  }
}

/* ---- boot ---- */
applyTheme();
renderRooms(); renderLog();
sys('nearchat · no accounts, no servers · type /help');
if (!ST.welcomed) welcomeSheet();
startNative();
try { window.onNativeResume(); } catch (e) {}
