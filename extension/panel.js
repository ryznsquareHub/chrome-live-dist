// chrome-live side panel. Talks ONLY to the daemon's /panel/* endpoints with the scoped panel token
// (status/log/tabs/pause/resume/auto + per-tab chat + 내 정보). v9: tabs 채팅 · 내 정보 · 기록 (open tabs live in the chat's tab picker). Never touches pages itself. All daemon text is put in
// the DOM with textContent (no innerHTML from the daemon or from Claude's answers).
'use strict';
const POLL_MS = 1500, TABS_MS = 5000;
const ACT = { open: ['새 탭', '＋'], run: ['실행', '▸'], shot: ['스크린샷', '◩'], snapshot: ['구조 읽기', '≡'], close: ['탭 닫기', '×'],
  front: ['앞으로', '⇡'], tabs: ['탭 목록', '☰'], diag: ['진단', '⚙'], connect: ['연결', '●'], disconnect: ['끊김', '○'],
  pause: ['일시정지', '‖'], resume: ['다시 연결', '●'], setting: ['설정', '⚙'], chat: ['채팅', '✦'],
  formscan: ['입력칸 찾기', '⌕'], fill: ['내 정보 입력', '✎'], vault: ['내 정보', '◆'],
  recipe: ['레시피', '❖'], 'recipe-write': ['레시피 정리', '❖'] };
const SYS_CMDS = new Set(['connect', 'disconnect', 'pause', 'resume', 'setting']);
const isSys = e => SYS_CMDS.has(e.cmd) || (e.cmd === 'vault' && !e.id);
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let base = null, token = null, seq = 0, events = [], status = null, busy = false, failCount = 0;
let view = 'chat', tabsData = { attached: false, tabs: [], known: {} }, threads = [], chatTab = '', chatRun = null;
const openErr = new Set();
const store = { get(k, d) { try { const v = localStorage.getItem('cl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cl.' + k, JSON.stringify(v)); } catch {} } };

// ---------- daemon ----------
async function loadToken() {
  try {
    const r = await fetch(chrome.runtime.getURL('panel-token.json'), { cache: 'no-store' });
    const j = await r.json(); token = j.token; base = `http://127.0.0.1:${j.port || 18932}/panel`;
    return true;
  } catch { return false; }
}
function req(method, path, body) {
  return fetch(base + path, { method, cache: 'no-store',
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function call(method, path, body) {
  const r = await req(method, path, body);
  if (!r.ok) {
    let m = 'HTTP ' + r.status; try { m = (await r.json()).error || m; } catch {}
    throw new Error(r.status === 401 ? '인증 실패 — 확장 프로그램을 새로고침하세요' : m);
  }
  return r.json();
}

// ---------- helpers ----------
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 45) return '방금';
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return s < 172800 ? `어제 ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
const secAgo = s => s == null ? '' : s < 45 ? '방금' : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
const dur = ms => ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms / 60000)}분`;
function profShort(name, letter) {
  if (name) { const n = name.replace(/\s*\(추정\)$/, '').replace(/^\d+\.\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim(); if (n) return n; }
  return letter ? '프로필 ' + letter : '';
}
function tabMeta(id) {   // best-known info for a tab id: open tab list > known (daemon memory) > events
  const t = tabsData.tabs.find(x => x.id === id);
  if (t) return { ...t, open: true };
  const k = (tabsData.known || {})[id];
  const ev = [...events].reverse().find(e => e.id === id && (e.title || e.host));
  const m = { id, title: (k && k.title) || (ev && ev.title) || null, host: (k && k.host) || (ev && ev.host) || null,
    profile: (k && k.profile) || (ev && ev.profile) || null, profileName: (k && k.profileName) || (ev && ev.profileName) || null,
    owned: !!((k && k.owned) || (ev && ev.owned)), open: false };
  const th = threads.find(x => x.tab === id);
  if (th) { m.title = m.title || th.title; m.host = m.host || th.host; }
  return m;
}
function tabLabel(id) {
  const m = tabMeta(id); const p = profShort(m.profileName, m.profile);
  return `${m.title || m.host || '탭 ' + id}${m.title && m.host ? ' · ' + m.host : ''}${p ? ` (${p})` : ''}${m.open ? '' : ' · 닫힘'}`;
}
let toastT;
function toast(msg, action) {   // action: { label, fn } -> a button in the toast (e.g. 되돌리기)
  const t = $('toast'), a = $('toastAct');
  $('toastMsg').textContent = msg || ''; t.hidden = !msg; clearTimeout(toastT);
  a.hidden = !action; a.onclick = null;
  if (action) { a.textContent = action.label; a.onclick = () => { t.hidden = true; clearTimeout(toastT); action.fn(); }; }
  if (msg) toastT = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3500);
}

// ---------- status bar ----------
function stateView(s) {
  if (!s) return { dot: 'bad', text: '데몬 꺼짐', btn: null, info: 'chrome-live 데몬에 연결할 수 없어요. <b>start-hidden.vbs</b>를 실행하세요.' };
  switch (s.state) {
    case 'connected': return { dot: 'on', text: '연결됨', ago: s.idleForSec != null ? secAgo(s.idleForSec) : '', btn: 'pause' };
    case 'connecting': return { dot: 'wait', text: '허용 대기', btn: 'pause', info: "크롬에 뜬 <b>원격 디버깅 허용</b> 창에서 허용을 눌러 주세요." };
    case 'paused': return { dot: '', text: '일시정지', btn: 'resume' };
    case 'no-debug-port': return { dot: 'bad', text: '디버깅 꺼짐', btn: null, info: 'chrome://inspect/#remote-debugging 토글이 꺼져 있거나 크롬이 닫혀 있어요.' };
    case 'failed': case 'chrome-not-running': return { dot: 'bad', text: '연결 실패', btn: 'resume', info: esc(s.lastError || '') };
    default: return { dot: '', text: '끊김', btn: 'resume' };
  }
}
function infoHtml(s, v) {
  const idle = s && s.autoDisconnectSec ? `${Math.round(s.autoDisconnectSec / 60)}분` : `${s ? s.idleMinutes : 180}분`;
  return [v.info ? `<p>${v.info}</p>` : '',
    '<p><b>연결됨</b> = 크롬 위에 노란 "자동화된 소프트웨어" 줄이 보이는 상태.</p>',
    `<p>작업 없이 <b>${idle}</b>이 지나면 자동으로 끊겨요. 다음 작업 때 다시 연결하며 허용 창이 1번 떠요.</p>`,
    '<p><b>연결 끊기</b> = 일시정지. 다시 연결할 때까지 Claude의 크롬 작업이 거부돼요.</p>',
    '<p><b>자동 끊기</b>는 설정 탭에서 바꿔요.</p>'].join('');
}
function renderStatus() {
  const s = status, v = stateView(s);
  $('dot').className = 'dot ' + (v.dot || '');
  $('stText').textContent = v.text; $('stAgo').textContent = v.ago || '';
  const b = $('toggle');
  b.hidden = !v.btn; b.dataset.act = v.btn || '';
  b.textContent = v.btn === 'pause' ? '연결 끊기' : '연결';
  b.classList.toggle('primary', v.btn === 'resume');
  b.disabled = busy;
  if (!$('pop').hidden) $('pop').innerHTML = infoHtml(s, v);   // static strings; daemon text (lastError) is escaped in stateView
}
$('infoBtn').onclick = () => {
  const p = $('pop'); p.hidden = !p.hidden; $('infoBtn').setAttribute('aria-expanded', String(!p.hidden));
  if (!p.hidden) p.innerHTML = infoHtml(status, stateView(status));
};
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function act(path, body, msg) {
  busy = true; renderStatus();
  try { status = await call('POST', path, body); if (msg) toast(msg); } catch (e) { toast('실패: ' + e.message); }
  busy = false; renderStatus(); poll(); if (view !== 'log') pollTabs();
}
$('toggle').onclick = () => $('toggle').dataset.act === 'pause'
  ? act('/pause', null, '연결을 끊었어요. 노란 줄이 곧 사라져요.')
  : act('/resume', null, '크롬에 허용 창이 뜨면 허용을 눌러 주세요.');

// ---------- views: 채팅 · 내 정보 · 기록 ----------
function setView(v) {
  if (!['chat', 'vault', 'log', 'set'].includes(v)) v = 'chat';
  view = v; store.set('view', v);
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.v === v);
  $('vLog').hidden = v !== 'log'; $('vChat').hidden = v !== 'chat'; $('vVault').hidden = v !== 'vault'; $('vSet').hidden = v !== 'set';
  closePicker();
  if (v === 'chat') { pollTabs(); renderPicker(); loadThread(); }
  if (v === 'vault') loadVault();
  if (v === 'log') renderList();
  if (v === 'set') loadSettings();
}
for (const b of document.querySelectorAll('.seg button')) b.onclick = () => setView(b.dataset.v);

// ---------- log ----------
function fillSelect(sel, items, allLabel) {   // items: [value, text]
  const cur = sel.value; const want = [['', allLabel], ...items];
  const sig = want.map(x => x.join('\u0002')).join('\u0001');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig; sel.textContent = '';
    for (const [v, t] of want) { const o = el('option', null, t); o.value = v; sel.appendChild(o); }
  }
  sel.value = want.some(x => x[0] === cur) ? cur : '';
}
const profOf = e => profShort(e.profileName, e.profile);
function sysText(e) {
  const l = e.label || '';
  if (e.cmd === 'connect') return e.ok === false ? '연결 실패' : '연결됨';
  if (e.cmd === 'pause') return '일시정지' + (l ? ` · ${l}` : '');
  if (e.cmd === 'resume') return '다시 연결' + (l ? ` · ${l}` : '');
  if (e.cmd === 'setting' || e.cmd === 'vault') return l || '설정 변경';
  if (/^idle \d+ s/.test(l)) return '자동 끊김';
  if (/^idle (\d+) min/.test(l)) return `끊김 · ${l.match(/\d+/)[0]}분 동안 작업 없음`;
  if (/^done/.test(l)) return '끊김 · 작업 끝';
  if (/^Chrome restarted/.test(l)) return '끊김 · 크롬 재시작';
  if (/^Chrome closed/.test(l)) return '끊김 · 크롬 닫힘';
  if (/^manual reconnect/.test(l)) return '재연결';
  return '끊김' + (l ? ` · ${l}` : '');
}
function renderList() {
  const ids = [...new Set([...events].reverse().map(e => e.id).filter(Boolean))];
  fillSelect($('fTab'), ids.map(id => [id, tabLabel(id)]), '모든 탭');
  fillSelect($('fProfile'), [...new Set(events.map(profOf).filter(Boolean))].sort().map(p => [p, p]), '모든 프로필');
  const fp = $('fProfile').value, ft = $('fTab').value, fe = $('fErr').getAttribute('aria-pressed') === 'true';
  const shown = events.filter(e => (!fp || profOf(e) === fp) && (!ft || e.id === ft) && (!fe || e.ok === false) && !(ft && !e.id)).slice(-400);
  // group consecutive actions on the same tab (gap < 20 min); system events stand alone
  const groups = [];
  for (const e of shown) {
    const g = groups[groups.length - 1];
    if (e.id && !isSys(e) && g && g.id === e.id && new Date(e.t) - new Date(g.last) < 20 * 60000) { g.items.push(e); g.last = e.t; }
    else groups.push({ id: isSys(e) ? null : e.id || null, items: [e], last: e.t });
  }
  const list = $('list'); list.textContent = '';
  for (const g of groups.reverse()) {
    if (!g.id) {
      for (const e of g.items) {
        if (!isSys(e)) { list.appendChild(rowOf(e)); continue; }
        const s = el('div', 'sys', `${sysText(e)} · ${ago(e.t)}`); if (e.ok === false) s.style.color = 'var(--err)'; s.title = new Date(e.t).toLocaleString();
        list.appendChild(s);
      }
      continue;
    }
    const box = el('div', 'group');
    const m = tabMeta(g.id), last = g.items[g.items.length - 1];
    const title = last.title || m.title;
    const gh = el('div', 'gh');
    gh.append(el('span', 'gt', title || last.host || m.host || '탭'));
    if (title && (last.host || m.host)) gh.append(el('span', 'gd', last.host || m.host));
    if (last.owned || m.owned) { const b = el('span', 'badge', '🆕'); b.title = 'Claude가 연 탭'; gh.append(b); }
    const p = profOf(last) || profShort(m.profileName, m.profile); if (p) gh.append(el('span', 'badge', p));
    gh.append(el('span', 'id', g.id));
    const ga = el('span', 'ga', ago(last.t)); ga.title = new Date(last.t).toLocaleString(); gh.append(ga);
    box.append(gh);
    for (const e of [...g.items].reverse()) box.append(rowOf(e));
    list.append(box);
  }
  $('empty').hidden = shown.length > 0;
}
// 넣은 값 (v19): what a run typed / switched / chose and what fill entered (내 정보 = key only). Collapsed; click the row.
const openIn = new Set(), moreIn = new Set();
const IN_SHOW = 8;
const isVaultTag = v => /^\[내 정보: [^\]]+\]$/.test(v || '');
function inputsSummary(list, more) {
  const c = { 입력: 0, '내 정보': 0, 선택: 0, 켜기: 0, 끄기: 0 };
  for (const x of list) {
    if (x.k === 'vault' || (x.k === 'text' && isVaultTag(x.v))) c['내 정보']++;
    else if (x.k === 'text') c.입력++;
    else if (x.k === 'select' || x.k === 'radio') c.선택++;
    else if (x.k === 'check') c[x.on ? '켜기' : '끄기']++;
  }
  const parts = Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
  if (more) parts.push(`+${more}`);
  return parts.join(' · ');
}
function inputLine(x) {
  const li = el('div', 'inl');
  li.append(el('span', 'int', x.t || '입력칸'));
  if (x.k === 'check' || (x.k === 'radio')) {
    const on = x.k === 'radio' ? (x.on ? '선택' : '해제') : (x.on ? '켬' : '끔');
    li.append(el('span', 'inv st' + (x.on ? ' on' : ''), on));
  } else {
    const v = x.v == null ? '' : String(x.v);
    const s = el('span', 'inv' + (isVaultTag(v) ? ' vk' : v ? '' : ' empty'), v || '(비움)'); s.title = v; li.append(s);
  }
  return li;
}
function inputsBox(e, box = el('div', 'ind')) {
  const key = e.seq; box.textContent = '';
  const all = e.inputs, open = moreIn.has(key), show = open ? all : all.slice(0, IN_SHOW);
  for (const x of show) box.append(inputLine(x));
  const hidden = all.length - show.length;
  if (hidden > 0) { const b = el('button', 'inmore', `더 보기 (${hidden})`); b.onclick = ev => { ev.stopPropagation(); moreIn.add(key); inputsBox(e, box); }; box.append(b); }
  if (e.inputsMore) box.append(el('div', 'inx', `그 밖에 ${e.inputsMore}개는 기록하지 않았어요 (한 번에 30개까지)`));
  return box;
}
function rowOf(e) {
  const frag = document.createDocumentFragment();
  const [name, icon] = ACT[e.cmd] || [e.cmd, '•'];
  const hasIn = Array.isArray(e.inputs) && e.inputs.length > 0;
  const r = el('div', 'row' + (e.ok === false ? ' err' : '') + (hasIn ? ' hasin' : ''));
  r.title = new Date(e.t).toLocaleString();
  r.append(el('span', 'ic', e.ok === false ? '!' : icon), el('span', 'lb', e.label || name));
  if (e.label && !hasIn) r.append(el('span', 'ac', name));   // room for the summary chip
  if (hasIn) r.append(el('span', 'insum', inputsSummary(e.inputs, e.inputsMore)));
  r.append(el('span', 'du', e.ok === false ? '오류' : dur(e.ms)));
  frag.append(r);
  const key = e.seq, parts = [];
  if (e.ok === false && e.err) { const d = el('div', 'errd', e.err); d.hidden = !openErr.has(key); parts.push([d, openErr]); }
  if (hasIn) { const d = inputsBox(e); d.hidden = !openIn.has(key); parts.push([d, openIn]); }
  if (parts.length) {
    const sync = () => r.setAttribute('aria-expanded', String(parts.some(([d]) => !d.hidden)));
    const toggle = () => { const show = parts.every(([d]) => d.hidden); for (const [d, set] of parts) { d.hidden = !show; show ? set.add(key) : set.delete(key); } sync(); };
    r.tabIndex = 0; r.setAttribute('role', 'button'); sync();
    r.onclick = toggle; r.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
    for (const [d] of parts) frag.append(d);
  }
  return frag;
}
$('fTab').onchange = $('fProfile').onchange = renderList;
$('fErr').onclick = () => { const b = $('fErr'); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); renderList(); };

async function poll() {
  try {
    if (!token && !(await loadToken())) throw new Error('panel-token.json 없음 — 데몬 재시작 필요');
    const j = await call('POST', `/log?since=${seq}`);
    if (j.seq < seq) { events = []; seq = 0; }
    if (j.events.length) { events.push(...j.events); if (events.length > 1000) events = events.slice(-1000); seq = j.events[j.events.length - 1].seq; renderList(); }
    status = j.status; failCount = 0;
    renderConfirms(j.vaultPending || []);
  } catch (e) {
    if (++failCount >= 2) status = null;
    if (String(e.message).includes('인증')) { token = null; toast(e.message); }
  }
  renderStatus();
  if (view === 'set') renderDaemonInfo();
  if (status && status.daemon) maybeReloadExt(status.daemon.ext);
}
setInterval(() => { if (view === 'log' && events.length) renderList(); }, 30000);   // refresh relative times

// ---------- open tabs (for the chat's tab picker) ----------
async function pollTabs() {
  if (!token) return;
  const was = tabsData.attached;
  try { tabsData = await call('POST', '/tabs'); } catch { tabsData = { attached: false, tabs: [], known: tabsData.known || {} }; }
  if (!was && tabsData.attached && FOLLOW.pending != null) followTab(FOLLOW.pending);   // just connected: resolve the tab being looked at
  try { threads = (await call('POST', '/chat/threads')).threads; } catch {}
  if (view === 'chat') { renderPicker(); if (!$('cMenu').hidden) buildPicker(); }
  if (view === 'log') renderList();
}
function showLogFor(id) { setView('log'); const s = $('fTab'); if (![...s.options].some(o => o.value === id)) { const o = el('option', null, tabLabel(id)); o.value = id; s.appendChild(o); } s.value = id; renderList(); }

// tab picker: open tabs grouped by profile + chats of closed tabs; "연결하고 보기" when not connected
function renderPicker() {
  const t = $('cPickT'); t.textContent = '';
  if (!chatTab) { t.append(el('span', 'ph2', '탭 고르기…')); }
  else {
    const m = tabMeta(chatTab);
    t.append(document.createTextNode(m.title || m.host || '탭 ' + chatTab));
    if (m.title && m.host) t.append(el('span', 'ph2', ' · ' + m.host));
    if (!m.open && tabsData.attached) t.append(el('span', 'ph2', ' · 닫힘'));
  }
  $('cPick').title = chatTab ? tabLabel(chatTab) : '대화할 탭 고르기';
  renderChatControls();
}
function pickOption(id, title, host, extra) {
  const b = el('button', 'po' + (id === chatTab ? ' sel' : '')); b.type = 'button'; b.setAttribute('role', 'option');
  b.append(threads.some(th => th.tab === id) ? Object.assign(el('span', 'hasthread'), { title: '대화 있음' }) : el('span', 'nothread'));
  b.append(el('span', 'tt', title || id));
  if (extra && extra.owned) { const x = el('span', 'badge', '🆕'); x.title = 'Claude가 연 탭'; b.append(x); }
  if (extra && extra.visible) b.append(el('span', 'badge', '보는 중'));
  if (extra && extra.audio) b.append(el('span', 'badge', '🔊'));
  if (host && host !== title) b.append(el('span', 'td', host));
  b.onclick = () => { FOLLOW.pending = null; FOLLOW.seq++; selectTab(id); closePicker(); $('cText').focus(); };   // a manual pick sticks until the next tab activation
  return b;
}
// switch the chat to another tab's thread. An answer still running for the previous tab keeps running in the daemon:
// only this panel's stream of it is closed (switching back re-attaches with /chat/watch)
function selectTab(id) {
  if (chatRun && chatRun.tab !== id) chatRun.ctl.abort();
  chatTab = id; store.set('chatTab', id);
  renderPicker(); if (!$('cMenu').hidden) buildPicker();
  if (view === 'chat') loadThread();
}

// ---------- 보는 탭 따라가기: the chat follows the tab the owner is looking at (owner decision 2026-11-01) ----------
// The panel belongs to ONE window (side panels are per window, so each profile's panel follows only its own window).
// Without the "tabs" permission the extension sees tab ids / index / window ids but no url/title: on activation it sends
// {windowId, index} to POST /panel/active-tab and the daemon maps that to its own tab id with browser-level CDP reads
// (never attaches to a tab). This only changes which thread is shown / sent to; it never acts on a tab.
const FOLLOW = { on: store.get('follow', true), win: null, last: null, pending: null, seq: 0 };
function renderFollow() {
  const b = $('cFollow');
  b.setAttribute('aria-pressed', String(FOLLOW.on));
  b.title = FOLLOW.on ? '보는 탭 따라가기: 켬 — 크롬에서 탭을 바꾸면 그 탭의 대화로 바뀌어요' : '보는 탭 따라가기: 꺼짐 — ▾로 고른 탭에 머물러요';
}
async function followTab(extId, index) {
  if (!FOLLOW.on || FOLLOW.win == null || !token) return;
  FOLLOW.last = extId; const my = ++FOLLOW.seq;
  if (index == null) { try { index = (await chrome.tabs.get(extId)).index; } catch { return; } }
  let r; try { r = await call('POST', '/active-tab', { windowId: FOLLOW.win, index }); } catch { r = null; }
  if (my !== FOLLOW.seq || !FOLLOW.on) return;   // a newer activation or a manual pick won
  if (!r || !r.tab) { FOLLOW.pending = extId; return; }   // not connected / chrome:// or extension page: keep the current selection
  FOLLOW.pending = null;
  tabsData.known = tabsData.known || {};
  tabsData.known[r.tab.id] = { ...(tabsData.known[r.tab.id] || {}), title: r.tab.title, host: r.tab.host, owned: r.tab.owned };
  if (r.tab.id !== chatTab) selectTab(r.tab.id);
}
async function followActive(why) {
  if (!FOLLOW.on || FOLLOW.win == null) return;
  let t; try { [t] = await chrome.tabs.query({ active: true, windowId: FOLLOW.win }); } catch { return; }
  if (!t) return;
  if (why === 'focus' && t.id === FOLLOW.last && FOLLOW.pending == null) return;   // same tab as before: keep a manual pick
  followTab(t.id, t.index);
}
function initFollow() {
  renderFollow();
  if (!(self.chrome && chrome.tabs && chrome.windows && chrome.tabs.onActivated)) return;
  chrome.tabs.onActivated.addListener(i => { if (i.windowId === FOLLOW.win) followTab(i.tabId); });
  chrome.windows.onFocusChanged.addListener(w => { if (w === FOLLOW.win) followActive('focus'); });
  chrome.tabs.onUpdated.addListener((id, ch) => { if (id === FOLLOW.pending && ch.status === 'complete') followTab(id); });   // e.g. new tab -> a website
  chrome.windows.getCurrent().then(w => { FOLLOW.win = w.id; followActive('start'); }).catch(() => {});
}
function setFollow(on, save) {
  FOLLOW.on = !!on; store.set('follow', FOLLOW.on); FOLLOW.seq++;
  renderFollow();
  if (save) call('POST', '/settings', { chatFollowActiveTab: FOLLOW.on }).then(s => { if (sdata) { sdata = s; renderSettings(); } }, e => toast('저장 실패: ' + e.message));
  if (FOLLOW.on) { FOLLOW.last = null; followActive('toggle'); }
}
$('cFollow').onclick = () => { setFollow(!FOLLOW.on, true); toast(FOLLOW.on ? '보는 탭을 따라가요' : '보는 탭 따라가기를 껐어요 — ▾로 고른 탭에 머물러요'); };
function buildPicker() {
  const box = $('cMenu'); box.textContent = '';
  if (!tabsData.attached) {
    const e = el('div', 'pe'); e.append(el('span', null, '연결돼 있지 않아 열린 탭이 안 보여요'));
    const b = el('button', 'btn small primary', '연결하고 보기'); b.type = 'button';
    b.onclick = async () => { b.disabled = true; await act('/resume', null, '크롬에 허용 창이 뜨면 허용을 눌러 주세요.'); setTimeout(pollTabs, 1500); };
    e.append(b); box.append(e);
  }
  const byProf = new Map();
  for (const t of tabsData.tabs) { const k = profShort(t.profileName, t.profile) || '열린 탭'; if (!byProf.has(k)) byProf.set(k, []); byProf.get(k).push(t); }
  for (const [p, ts] of byProf) { box.append(el('div', 'pg', p)); for (const t of ts) box.append(pickOption(t.id, t.title || t.host, t.host, t)); }
  const closed = threads.filter(th => !tabsData.tabs.some(t => t.id === th.tab));
  if (closed.length) { box.append(el('div', 'pg', tabsData.attached ? '대화 기록 (닫힌 탭)' : '대화 기록')); for (const th of closed) box.append(pickOption(th.tab, th.title || th.host || th.tab, th.host, null)); }
  if (tabsData.attached && !tabsData.tabs.length && !closed.length) box.append(el('div', 'pe', '열린 탭이 없어요'));
}
function openPicker() { buildPicker(); $('cMenu').hidden = false; $('cPick').setAttribute('aria-expanded', 'true'); pollTabs(); const s = $('cMenu').querySelector('.po.sel') || $('cMenu').querySelector('.po'); if (s) s.focus(); }
function closePicker() { $('cMenu').hidden = true; $('cPick').setAttribute('aria-expanded', 'false'); }
$('cPick').onclick = ev => { ev.stopPropagation(); $('cMenu').hidden ? openPicker() : closePicker(); };
document.addEventListener('click', ev => { if (!$('cMenu').hidden && !$('cMenu').contains(ev.target)) closePicker(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('cMenu').hidden) { closePicker(); $('cPick').focus(); } });
$('cLog').onclick = () => { if (chatTab) showLogFor(chatTab); else setView('log'); };

// ---------- chat ----------
// tiny safe formatter, DOM nodes only (never innerHTML): ```fenced``` blocks, `code`, **bold**, [text](http url), bare http(s) URLs.
// Links (owner request 2026-11-15 "링크 길이 제한 + 컨트롤 클릭 이동"): only http:/https: become <a class="lnk">; the shown text is the
// markdown text (capped) or a short host+path (capped), the full URL is in the tooltip. Nothing inside code is linkified.
// opts.plain (user bubbles): bare URLs only, no other formatting.
const LINK_TEXT_MAX = 80, LINK_URL_MAX = 50;
const MD_LINK = String.raw`\[([^\]\n]{1,2000})\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)`;
const BARE_URL = String.raw`https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+`;
const INLINE_RE = new RegExp(String.raw`(\x60[^\x60\n]+\x60)|(\*\*[^*\n]+\*\*)|${MD_LINK}|(${BARE_URL})`, 'gi');
const BARE_RE = new RegExp(BARE_URL, 'gi');
function safeUrl(u) {   // -> normalised href, or null unless it is a real http(s) URL
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && x.hostname ? x.href : null; } catch { return null; }
}
function cap(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shortUrl(href) {   // "cr.shopping.naver.com/adcr?x=…" (≤ LINK_URL_MAX chars)
  const x = new URL(href);
  let s = x.host.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname) + x.search + x.hash;
  try { s = decodeURI(s); } catch {}
  return cap(s, LINK_URL_MAX);
}
function trimBare(u) {   // drop trailing punctuation and an unbalanced ")" / "]" that belong to the sentence
  for (;;) {
    const c = u.slice(-1);
    if (/[.,;:!?'*]/.test(c)) { u = u.slice(0, -1); continue; }
    if (c === ')' && (u.split('(').length < u.split(')').length)) { u = u.slice(0, -1); continue; }
    if (c === ']' && (u.split('[').length < u.split(']').length)) { u = u.slice(0, -1); continue; }
    return u;
  }
}
function linkNode(href, text) {
  const a = el('a', 'lnk', text);
  a.href = href; a.rel = 'noopener noreferrer';
  a.title = (text !== href ? text + '\n' : '') + href + '\nCtrl+클릭(가운데 클릭)으로 새 탭에서 열기';
  return a;
}
function appendBare(box, s) {   // text with bare URLs linkified
  let last = 0; BARE_RE.lastIndex = 0;
  for (let m; (m = BARE_RE.exec(s));) {
    const raw = trimBare(m[0]), href = safeUrl(raw);
    if (!href) continue;
    if (m.index > last) box.append(document.createTextNode(s.slice(last, m.index)));
    box.append(linkNode(href, shortUrl(href)));
    last = m.index + raw.length; BARE_RE.lastIndex = last;
  }
  if (last < s.length) box.append(document.createTextNode(s.slice(last)));
}
function appendInline(box, s, inBold) {
  let last = 0; const re = new RegExp(INLINE_RE.source, 'gi');
  for (let m; (m = re.exec(s));) {
    let node = null, end = m.index + m[0].length;
    if (m[1]) node = el('code', null, m[1].slice(1, -1));
    else if (m[2] && !inBold) { node = el('strong'); appendInline(node, m[2].slice(2, -2), true); }
    else if (m[3] != null) { const href = safeUrl(m[4]); if (href) node = linkNode(href, cap(m[3].trim() || shortUrl(href), LINK_TEXT_MAX)); }
    else if (m[5]) { const raw = trimBare(m[5]), href = safeUrl(raw); if (href) { node = linkNode(href, shortUrl(href)); end = m.index + raw.length; re.lastIndex = end; } }
    if (!node) continue;   // e.g. [x](javascript:…) never matches; a bad URL stays text
    if (m.index > last) box.append(document.createTextNode(s.slice(last, m.index)));
    box.append(node); last = end;
  }
  if (last < s.length) box.append(document.createTextNode(s.slice(last)));
}
function renderText(container, text, opts) {
  container.textContent = '';
  const s = String(text || '');
  if (opts && opts.plain) return appendBare(container, s);
  const fence = /```(?:[\w+.#-]*\n)?([\s\S]*?)(?:```|$)/g;   // an unclosed fence (still streaming) runs to the end
  let last = 0;
  for (let m; (m = fence.exec(s));) {
    if (m.index > last) appendInline(container, s.slice(last, m.index).replace(/\n$/, ''));   // the block itself breaks the line
    const pre = el('pre', 'cb'); pre.append(el('code', null, m[1].replace(/\n$/, ''))); container.append(pre);
    last = m.index + m[0].length; if (s[last] === '\n') last++;
    if (!m[0].length) break;
  }
  if (last < s.length) appendInline(container, s.slice(last));
}
// opening: Ctrl/⌘+click or Ctrl/⌘+Enter -> new tab right after the active tab, switched to; middle click / Ctrl+Shift -> in the background.
// Plain click only shows a hint (the panel itself never navigates). The panel lives in its profile's window -> same profile.
async function openLink(href, active) {
  if (!safeUrl(href)) return;
  if (!(self.chrome && chrome.tabs && chrome.tabs.create)) { window.open(href, '_blank', 'noopener'); return; }
  const o = { url: safeUrl(href), active: !!active };
  if (FOLLOW.win != null) o.windowId = FOLLOW.win;
  try { const [t] = await chrome.tabs.query({ active: true, windowId: FOLLOW.win != null ? FOLLOW.win : chrome.windows.WINDOW_ID_CURRENT }); if (t) { o.index = t.index + 1; o.openerTabId = t.id; } } catch {}
  try { await chrome.tabs.create(o); } catch (e) { try { delete o.openerTabId; delete o.index; await chrome.tabs.create(o); } catch (e2) { toast('링크를 못 열었어요: ' + e2.message); } }
}
document.addEventListener('click', ev => {
  const a = ev.target.closest && ev.target.closest('a.lnk'); if (!a) return;
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) openLink(a.href, !ev.shiftKey);
  else toast('Ctrl+클릭(Mac은 ⌘+클릭)으로 새 탭에서 열려요');
});
document.addEventListener('auxclick', ev => {
  const a = ev.target.closest && ev.target.closest('a.lnk'); if (!a || ev.button !== 1) return;
  ev.preventDefault(); openLink(a.href, false);
});
document.addEventListener('keydown', ev => {
  const a = ev.target.closest && ev.target.closest('a.lnk'); if (!a || ev.key !== 'Enter') return;
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) openLink(a.href, !ev.shiftKey); else toast('Ctrl+Enter로 새 탭에서 열려요');
});
// chat engine (owner decision 2026-11-01): Claude | Codex per thread; the toggle sits next to 보내기
const ENG_NAME = { claude: 'Claude', codex: 'Codex' };
const engOf = m => (m && m.engine === 'codex' ? 'codex' : 'claude');   // old messages (no engine field) = Claude
let engineSel = null;   // engine the next message goes to (this thread's engine until the owner flips the toggle)
// engine badge: "Claude · Sonnet", "Codex · medium", "Claude · Opus · low" (model / effort recorded per message; old messages: engine only)
const badgeText = m => [ENG_NAME[engOf(m)], m.model, m.effort].filter(x => typeof x === 'string' && x).join(' · ');

// ---------- model · 추론 강도 (owner request 2026-11-01): config chatModel/chatEffort (Claude), codexModel/codexEffort (Codex) ----------
// '' = 기본 (the owner's normal Claude Code / Codex settings, no flag). Applies from the next message; also in 설정.
let PREFS = null;   // settings view subset: {chatModel, chatEffort, codexModel, codexEffort, models:{claude:{models,efforts}, codex:{...}}}
const MKEY = { claude: ['chatModel', 'chatEffort'], codex: ['codexModel', 'codexEffort'] };
function prefsFrom(s) { if (s && s.models) PREFS = { chatModel: s.chatModel || '', chatEffort: s.chatEffort || '', codexModel: s.codexModel || '', codexEffort: s.codexEffort || '', models: s.models }; }
function modelLabel(eng) {
  if (!PREFS) return '기본';
  const [mk, ek] = MKEY[eng], o = PREFS.models[eng] || { models: [], efforts: [] };
  const mv = PREFS[mk], ev = PREFS[ek];
  const ml = mv ? ((o.models.find(x => x.value === mv) || {}).label || mv).replace(/ \(현재 설정\)$/, '') : '기본';
  return ev ? `${ml} · ${ev}` : ml;
}
function renderModel(running) {
  const b = $('cModel'), eng = engineSel || 'claude';
  $('cModelT').textContent = modelLabel(eng);
  b.disabled = running || !PREFS;
  b.title = !PREFS ? '데몬이 모델 선택을 모르는 버전이에요 (데몬 재시작 필요)' : running ? '답변 중에는 바꿀 수 없어요' : `${ENG_NAME[eng]} 모델 · 추론 강도: ${modelLabel(eng)} (다음 질문부터)`;
  if (b.disabled) closeModelMenu();
  else if (!$('cModelMenu').hidden) buildModelMenu();
}
function buildModelMenu() {
  const box = $('cModelMenu'); box.textContent = '';
  if (!PREFS) return;
  const eng = engineSel || 'claude', [mk, ek] = MKEY[eng], o = PREFS.models[eng] || { models: [], efforts: [] };
  const group = (title, key, list) => {
    box.append(el('div', 'pg', title));
    for (const x of list) {
      const b = el('button', null, x.label); b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.dataset.k = key; b.dataset.v = x.value;
      b.setAttribute('aria-checked', String((PREFS[key] || '') === x.value));
      b.onclick = () => saveModelPref(key, x.value);
      box.append(b);
    }
  };
  group(`${ENG_NAME[eng]} 모델`, mk, o.models);
  group('추론 강도', ek, o.efforts);
}
async function saveModelPref(key, value) {
  try { const s = await call('POST', '/settings', { [key]: value }); prefsFrom(s); if (sdata) { sdata = s; renderSettings(); } }
  catch (e) { toast('저장 실패: ' + e.message); }
  closeModelMenu(); renderChatControls();
}
function openModelMenu() { buildModelMenu(); $('cModelMenu').hidden = false; $('cModel').setAttribute('aria-expanded', 'true'); const s = $('cModelMenu').querySelector('[aria-checked="true"]'); if (s) s.focus(); }
function closeModelMenu() { $('cModelMenu').hidden = true; $('cModel').setAttribute('aria-expanded', 'false'); }
$('cModel').onclick = ev => { ev.stopPropagation(); if ($('cModel').disabled) return; $('cModelMenu').hidden ? openModelMenu() : closeModelMenu(); };
document.addEventListener('click', ev => { if (!$('cModelMenu').hidden && !$('cModelMenu').contains(ev.target)) closeModelMenu(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('cModelMenu').hidden) { closeModelMenu(); $('cModel').focus(); } });
function msgNode(m) {
  if (m.role === 'user') { const u = el('div', 'msg user'); renderText(u, m.text, { plain: true }); return u; }   // bare URLs become short links
  if (m.role === 'notice') return el('div', 'msg notice', m.text);
  const d = el('div', 'msg bot');
  if (m.tools && m.tools.length) { const ts = el('div', 'tools'); for (const t of m.tools.slice(-12)) { const c = el('span', 'tool', t); c.title = t; ts.append(c); } d.append(ts); }
  const tx = el('div', 'txt'); renderText(tx, m.text || ''); d.append(tx);
  if (m.err) d.append(el('div', 'errline', m.err === '중지됨' ? '중지됨' : '오류: ' + m.err));
  const cost = m.cost != null ? `$${m.cost}` : m.tokens != null ? `토큰 ${Number(m.tokens).toLocaleString('ko-KR')}` : '';
  const meta = [m.ms != null ? dur(m.ms) : '', cost, m.t ? ago(m.t) : ''].filter(Boolean).join(' · ');
  const md = el('div', 'meta'); const e = engOf(m);
  md.append(el('span', 'eng-b ' + e, badgeText(m)));
  if (m.recipe) {   // 레시피 badge: used (time) or failed -> manual
    const rb = el('span', 'rcp-b' + (m.recipe.ok ? '' : ' fail'), m.recipe.ok ? '레시피 사용' + (m.recipe.ms ? ' · ' + Math.max(1, Math.round(m.recipe.ms / 1000)) + '초' : '') : '레시피 실패 → ' + (m.recipe.fallback === 'manual' ? '매뉴얼' : '직접 찾기'));
    rb.title = m.recipe.action || m.recipe.id || ''; md.append(rb);
  }
  md.append(document.createTextNode(meta));
  if (m.ask) d.append(askCard(m.ask));
  d.append(md);
  return d;
}
// 선택 카드 (owner decision 2026-11-09): the model's question with 2-4 buttons (+ optional 직접 입력). Model text -> textContent
// only. A click sends the answer as the next message of this thread ("선택: …", built by the daemon from the stored options).
// Answerable only on the thread's last message while nothing runs; answered / older cards are read-only.
function askCard(a) {
  const c = el('div', 'ask'); c.dataset.id = a.id || '';
  c.append(el('div', 'askq', a.q || ''));
  const ob = el('div', 'askopts');
  (a.options || []).forEach((label, i) => {
    const b = el('button', 'btn askopt', label); b.type = 'button'; b.dataset.i = String(i);
    if (a.answer && a.answer.index === i) b.classList.add('chosen');
    b.onclick = () => answerAsk(c, a, { index: i }, label);
    ob.append(b);
  });
  c.append(ob);
  if (a.other) {
    const f = el('div', 'askother');
    const inp = el('input'); inp.type = 'text'; inp.maxLength = 300; inp.placeholder = '직접 입력'; inp.setAttribute('aria-label', '직접 입력');
    const go = el('button', 'btn small', '보내기'); go.type = 'button';
    const send = () => { const v = inp.value.trim(); if (v) answerAsk(c, a, { other: v }, v); };
    go.onclick = send; inp.onkeydown = ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send(); } };
    f.append(inp, go); c.append(f);
  }
  if (a.answer) c.append(el('div', 'askdone', a.answer.index != null ? '선택함' : '직접 입력함: ' + (a.answer.other || '')));
  setAskLive(c, false);
  return c;
}
function setAskLive(c, on) {
  c.classList.toggle('live', on);
  for (const x of c.querySelectorAll('button, input')) x.disabled = !on;
}
// only the card of the last message (no answer yet, nothing running for this tab) takes clicks
function refreshAskCards() {
  const running = !!(chatRun && chatRun.tab === chatTab);
  const msgs = thread && thread.messages ? thread.messages.filter(m => m.role !== 'notice') : [];
  const last = msgs[msgs.length - 1];
  const liveId = !running && last && last.role === 'assistant' && last.ask && !last.ask.answer ? last.ask.id : null;
  for (const c of $('msgs').querySelectorAll('.ask')) setAskLive(c, !!liveId && c.dataset.id === liveId && !c.dataset.sent);
}
function answerAsk(c, a, ans, label) {
  if (!chatTab || chatRun || !c.classList.contains('live')) return;
  c.dataset.sent = '1'; setAskLive(c, false);
  if (ans.index != null) { const b = c.querySelector(`.askopt[data-i="${ans.index}"]`); if (b) b.classList.add('chosen'); }
  c.append(el('div', 'askdone', ans.index != null ? '선택함' : '직접 입력함: ' + label));
  const text = ans.index != null ? `선택: ${label}` : `선택(직접 입력): ${label}`;
  $('msgs').append(msgNode({ role: 'user', text }));
  stream('/chat/send', { tab: chatTab, text, answer: { id: a.id, ...ans }, ...(engineSel ? { engine: engineSel } : {}) }, chatTab);
}
let thread = null;
async function loadThread() {
  const box = $('msgs'); box.textContent = ''; thread = null; engineSel = null;
  renderChatControls();
  if (!chatTab) { box.append(el('div', 'chatempty', '위에서 대화할 탭을 고르세요.')); return; }
  try { thread = await call('POST', `/chat/thread?tab=${encodeURIComponent(chatTab)}`); } catch (e) { box.append(el('div', 'chatempty', '불러오기 실패: ' + e.message)); return; }
  engineSel = thread.engine === 'codex' && thread.codexAvailable !== false ? 'codex' : 'claude';
  for (const m of thread.messages) box.append(msgNode(m));
  if (!thread.messages.length) box.append(el('div', 'chatempty', `"${tabLabel(chatTab)}"\n이 탭에 대해 무엇이든 물어보세요. ${ENG_NAME[engineSel]}가 이 탭을 기본으로 보고 작업해요.`));
  box.scrollTop = box.scrollHeight;
  if (thread.running && (!chatRun || chatRun.tab !== chatTab)) stream('/chat/watch', { tab: chatTab }, chatTab);
  renderChatControls();
  refreshAskCards();
}
function renderChatControls() {
  const running = !!(chatRun && chatRun.tab === chatTab);
  $('cStop').hidden = !running; $('cSend').disabled = running || !chatTab;
  $('cReset').disabled = running || !chatTab;
  const switching = !!(thread && engineSel && thread.engine && engineSel !== thread.engine && thread.messages.some(m => m.role !== 'notice'));
  $('cHint').textContent = running ? '' : chatTab ? (switching ? `보내면 ${ENG_NAME[engineSel]} 새 대화로 시작` : thread && thread.hasSession ? '이어서 대화' : '새 대화') : '';
  renderEngine(running);
  renderModel(running);
  refreshAskCards();
}
// Claude | Codex toggle: disabled while a run is in progress; Codex disabled (with the reason as tooltip) when not installed
function renderEngine(running) {
  const codexOk = !thread || thread.codexAvailable !== false;
  const cur = engineSel || 'claude';
  for (const b of $('cEng').querySelectorAll('button')) {
    const e = b.dataset.e, on = e === cur;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    b.disabled = running || !chatTab || !thread || (e === 'codex' && !codexOk);
    b.title = e === 'codex' && !codexOk ? 'Codex CLI를 찾지 못했어요 (설치하면 쓸 수 있어요)' : running ? '답변 중에는 바꿀 수 없어요' : `${ENG_NAME[e]}로 답하기`;
  }
}
for (const b of $('cEng').querySelectorAll('button')) b.onclick = () => { if (b.disabled) return; engineSel = b.dataset.e; renderChatControls(); };
async function stream(path, body, tab) {
  const box = $('msgs');
  for (const n of box.querySelectorAll('.chatempty')) n.remove();
  const eng = body.engine || (thread && thread.engine) || 'claude';
  const live = el('div', 'msg bot'); const tools = el('div', 'tools'); const tx = el('div', 'txt'); const th = el('div', 'thinking', eng === 'codex' ? 'Codex 생각 중' : '생각 중');
  live.append(tools, tx, th); box.append(live); box.scrollTop = box.scrollHeight;
  const ctl = new AbortController();
  chatRun = { tab, ctl }; renderChatControls();
  let text = '', done = null;
  const addTool = s => { const c = el('span', 'tool', s); c.title = s; tools.append(c); };
  const showAsk = a => { if (!a || live.querySelector('.ask')) return; live.insertBefore(askCard(a), th); };
  try {
    const r = await fetch(base + path, { method: 'POST', signal: ctl.signal, cache: 'no-store',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('event-stream')) {
      let m = 'HTTP ' + r.status; try { const j = await r.json(); if (j.running === false) { live.remove(); return; } m = j.error || m; } catch {}
      throw new Error(m);
    }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done: end } = await rd.read(); if (end) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (chatTab !== tab) continue;
        if (ev.type === 'start') { if (ev.partial) { text = ev.partial; renderText(tx, text); } for (const t of ev.tools || []) addTool(t); if (ev.ask) showAsk(ev.ask); }
        else if (ev.type === 'text') { text += ev.text; renderText(tx, text); }
        else if (ev.type === 'ask') showAsk(ev.ask);   // 선택 카드: shown at once, clickable when the turn ends
        else if (ev.type === 'tool') { addTool(ev.summary || ev.name); th.textContent = eng === 'codex' ? 'Codex 작업 중' : '작업 중'; }
        else if (ev.type === 'notice') box.insertBefore(msgNode({ role: 'notice', text: ev.text }), live);   // engine switched: fresh session
        else if (ev.type === 'done') done = ev.message;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80; if (nearBottom) box.scrollTop = box.scrollHeight;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') { th.remove(); live.append(el('div', 'errline', '오류: ' + e.message)); }
  } finally {
    if (chatRun && chatRun.ctl === ctl) chatRun = null;
    if (chatTab === tab) {
      if (done) live.replaceWith(msgNode(done)); else th.remove();
      box.scrollTop = box.scrollHeight;
      try { thread = await call('POST', `/chat/thread?tab=${encodeURIComponent(tab)}`); if (!chatRun) engineSel = thread.engine === 'codex' ? 'codex' : 'claude'; } catch {}
    }
    renderChatControls(); pollTabs(); if (chatTab === tab) refreshAskCards();
  }
}
$('cForm').onsubmit = ev => {
  ev.preventDefault();
  const text = $('cText').value.trim(); if (!text || !chatTab || chatRun) return;
  $('cText').value = '';
  for (const n of $('msgs').querySelectorAll('.chatempty')) n.remove();
  $('msgs').append(msgNode({ role: 'user', text }));
  stream('/chat/send', { tab: chatTab, text, ...(engineSel ? { engine: engineSel } : {}) }, chatTab);
};
$('cText').onkeydown = ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('cForm').requestSubmit(); } };
$('cStop').onclick = async () => { try { await call('POST', '/chat/stop', { tab: chatTab }); } catch (e) { toast('중지 실패: ' + e.message); } };
$('cReset').onclick = async () => {
  if (!chatTab || !confirm('이 탭의 대화를 지울까요? (다음 질문은 새 대화로 시작)')) return;
  try { await call('POST', '/chat/reset', { tab: chatTab }); loadThread(); pollTabs(); } catch (e) { toast(e.message); }
};

// ---------- 내 정보 (vault): one section per category, a 항목 | 내용 table edited in place ----------
// Values are shown only here (the owner's own panel). 민감 values come masked; the eye / a click fetches them on demand.
// Saves on blur / Enter (Esc cancels); delete = × with an undo toast (the daemon keeps the deleted item in memory 2 min).
const ICON = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10 10 0 0 1 12 19c-7 0-11-7-11-7a18 18 0 0 1 5-5.9M9.9 5.2A9 9 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>',
};
let vdata = null;
const revealed = new Map();    // key -> value (eye toggle, hides again after 20 s)
const sensEdit = new Map();    // key -> value while a 민감 value is being edited
const advOpen = new Set();     // keys with the ⋯ panel open
const newDraft = {};           // cat -> { t, v } (the empty row at the bottom of each section)
const noteDraft = {};          // cat -> true while a new 메모 is being written
let pendingFocus = null, flash = null, vq = Promise.resolve();

async function loadVault() {
  try { vdata = await call('POST', '/vault/list'); } catch (e) { vdata = null; $('vList').textContent = ''; $('vList').append(el('div', 'vempty', '불러오기 실패: ' + e.message)); return; }
  renderVault();
}
function iconBtn(cls, title, svgOrText, fn) {
  const b = el('button', 'icon ' + cls); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
  if (svgOrText.startsWith('<svg')) b.innerHTML = svgOrText; else b.textContent = svgOrText;   // static constants only
  b.onmousedown = ev => ev.preventDefault();   // keep focus where it is (no blur-save race)
  b.onclick = ev => { ev.stopPropagation(); fn(b); };
  return b;
}
// an always-editable text cell: commit on blur / Enter, Esc reverts
function cell(fid, value, placeholder, onCommit, opts = {}) {
  const i = el('input', 'cell'); i.value = value || ''; i.dataset.f = fid; i.dataset.orig = i.value; i.placeholder = placeholder || '';
  i.spellcheck = false; i.autocomplete = 'off'; if (opts.max) i.maxLength = opts.max; if (opts.label) i.setAttribute('aria-label', opts.label);
  i.onkeydown = ev => {
    if (ev.isComposing) return;
    if (ev.key === 'Enter') { ev.preventDefault(); if (opts.onEnter) opts.onEnter(i); else i.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); i.value = i.dataset.orig; i.dataset.cancel = '1'; if (opts.onEsc) opts.onEsc(i); i.blur(); }
  };
  i.onblur = () => { if (i.dataset.cancel) { delete i.dataset.cancel; return; } if (i.value !== i.dataset.orig) onCommit(i.value, i); };
  if (opts.onInput) i.oninput = () => opts.onInput(i.value);
  return i;
}
function renderVault() {
  if (!vdata) return;
  // keep focus (and an uncommitted value) across the re-render
  const ae = document.activeElement;
  const fid = pendingFocus || (ae && ae.dataset && ae.dataset.f) || null;
  const carry = !pendingFocus && ae && ae.dataset && ae.dataset.f && 'value' in ae ? { v: ae.value, orig: ae.dataset.orig, s: [ae.selectionStart, ae.selectionEnd] } : null;
  pendingFocus = null;
  const q = $('vSearch').value.trim().toLowerCase();
  const box = $('vList'); box.textContent = '';
  const hit = i => !q || [i.label, i.key, ...(i.aliases || []), i.sens === '민감' ? '' : i.value || ''].some(x => String(x || '').toLowerCase().includes(q));
  const hitN = m => !q || [m.title, m.body].some(x => String(x || '').toLowerCase().includes(q));
  let shown = 0;
  for (const c of vdata.categories) {
    const items = vdata.items.filter(i => i.cat === c && hit(i));
    const notes = (vdata.notes || []).filter(m => m.cat === c && hitN(m));
    if (q && !items.length && !notes.length) continue;
    shown += items.length + notes.length;
    const sec = el('section', 'vsec'); sec.dataset.cat = c;
    const h = el('h3', 'vh'); h.append(el('span', null, c));
    const nAll = vdata.items.filter(i => i.cat === c).length; if (nAll) h.append(el('span', 'n', String(nAll)));
    const addMemo = el('button', 'vadd', '+ 메모'); addMemo.type = 'button'; addMemo.title = '이 분류에 메모 추가';
    addMemo.onclick = () => { noteDraft[c] = true; pendingFocus = `nn:${c}:b`; renderVault(); };
    h.append(addMemo); sec.append(h);
    const tb = el('div', 'vtable'); tb.setAttribute('role', 'table'); tb.setAttribute('aria-label', c);
    for (const it of items) tb.append(vRow(it));
    if (!q) tb.append(newRow(c));
    sec.append(tb);
    for (const m of notes) sec.append(noteBlock(m));
    if (noteDraft[c] && !q) sec.append(noteBlock({ id: null, cat: c, title: '메모', body: '' }));
    box.append(sec);
  }
  if (q && !shown) box.append(el('div', 'vempty', '검색 결과가 없어요'));
  if (fid) {
    const t = box.querySelector(`[data-f="${CSS.escape(fid)}"]`);
    if (t) {
      if (carry && carry.v !== t.value) { t.value = carry.v; t.dataset.orig = carry.orig; }
      t.focus({ preventScroll: true });
      if (carry && t.setSelectionRange) try { t.setSelectionRange(carry.s[0], carry.s[1]); } catch {}
      if (t.tagName === 'TEXTAREA') autosize(t);
    }
  }
  if (flash) { const f = box.querySelector(`[data-saved="${CSS.escape(flash)}"]`); flash = null; if (f) { f.classList.add('show'); setTimeout(() => f.classList.remove('show'), 1200); } }
}
function vRow(it) {
  const r = el('div', 'vr'); r.dataset.key = it.key; r.setAttribute('role', 'row');
  const sens = it.sens === '민감';
  const tc = el('div', 'vc t'); tc.append(cell(`t:${it.key}`, it.label, '항목', v => {
    if (!v.trim()) { toast('항목 이름은 비울 수 없어요'); renderVault(); return; }
    saveItem(it.key, { label: v.trim() });
  }, { max: 40, label: '항목' }));
  const vc = el('div', 'vc v');
  if (sens && !sensEdit.has(it.key)) {
    const rev = revealed.has(it.key);
    const s = el('span', 'mask' + (rev ? ' rev' : '') + (it.hasValue ? '' : ' none'), it.hasValue ? (rev ? revealed.get(it.key) : '•'.repeat(8)) : '비어 있음');
    s.tabIndex = 0; s.dataset.f = `v:${it.key}`; s.title = '눌러서 편집';
    const edit = async () => {
      let v = '';
      if (it.hasValue) { try { v = revealed.get(it.key) ?? (await call('POST', '/vault/reveal', { key: it.key })).value; } catch (e) { toast(e.message); return; } }
      sensEdit.set(it.key, v); pendingFocus = `v:${it.key}`; renderVault();
    };
    s.onclick = edit; s.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); edit(); } };
    vc.append(s);
  } else {
    const val = sens ? sensEdit.get(it.key) : (it.value || '');
    vc.append(cell(`v:${it.key}`, val, '내용', v => { sensEdit.delete(it.key); saveItem(it.key, { value: v }); },
      { max: 500, label: '내용', onEsc: () => { if (sens) { sensEdit.delete(it.key); setTimeout(renderVault, 0); } } }));
    if (sens) { const inp = vc.firstChild; inp.addEventListener('blur', () => { if (sensEdit.has(it.key) && inp.value === inp.dataset.orig) { sensEdit.delete(it.key); setTimeout(renderVault, 0); } }); }
  }
  if (it.nofill) { const t = el('span', 'vtag', '기입 안 함'); t.title = '자동 기입에 쓰지 않는 항목'; vc.append(t); }
  const va = el('div', 'va');
  if (sens && it.hasValue) va.append(iconBtn('eye' + (revealed.has(it.key) ? ' keep' : ''), revealed.has(it.key) ? '가리기' : '보기', revealed.has(it.key) ? ICON.eyeOff : ICON.eye, async () => {
    if (revealed.has(it.key)) revealed.delete(it.key);
    else { try { revealed.set(it.key, (await call('POST', '/vault/reveal', { key: it.key })).value); setTimeout(() => { if (revealed.delete(it.key)) renderVault(); }, 20000); } catch (e) { toast(e.message); } }
    renderVault();
  }));
  va.append(iconBtn('lock' + (sens ? ' on keep' : ''), sens ? '민감 (입력 전 확인) · 눌러서 해제' : '민감으로 표시', sens ? ICON.lock : ICON.unlock, async () => {
    const ok = await saveItem(it.key, { sens: sens ? '일반' : '민감' });
    if (ok && sens) { const now = vdata.items.find(i => i.key === it.key); if (now && now.sens === '민감') toast('이 항목은 항상 민감으로 둬요'); }
  }));
  va.append(iconBtn('more', '더보기 (키 · 다른 이름 · 분류)', '⋯', () => { advOpen.has(it.key) ? advOpen.delete(it.key) : advOpen.add(it.key); renderVault(); }));
  va.append(iconBtn('del', '삭제', '×', () => vDelete(it)));
  const sv = el('span', 'saved', '✓ 저장됨'); sv.dataset.saved = it.key;
  r.append(tc, vc, va, sv);
  if (advOpen.has(it.key)) r.append(advPanel(it));
  return r;
}
function advPanel(it) {
  const p = el('div', 'vadv');
  const key = cell(`k:${it.key}`, it.key, '키', v => { v = v.trim().toLowerCase(); if (!v) return renderVault(); saveItem(it.key, { key: v }).then(ok => { if (ok) { advOpen.delete(it.key); advOpen.add(v); renderVault(); } }); }, { max: 40, label: '키' });
  key.classList.add('mono'); key.classList.remove('cell');
  const al = cell(`a:${it.key}`, (it.aliases || []).join(', '), '쉼표로 · 입력칸 찾기에 씀', v => saveItem(it.key, { aliases: v.split(',').map(x => x.trim()).filter(Boolean) }), { label: '다른 이름' });
  al.classList.remove('cell');
  const cs = el('select'); cs.setAttribute('aria-label', '분류'); fillCats(cs, it.cat); cs.onchange = () => saveItem(it.key, { cat: cs.value });
  const nl = el('label', 'chkl'); const nc = el('input'); nc.type = 'checkbox'; nc.checked = !!it.nofill; nc.onchange = () => saveItem(it.key, { nofill: nc.checked });
  nl.append(nc, document.createTextNode('자동 기입 안 함'));
  const acts = el('div', 'acts');
  const b = (t, title, fn) => { const x = el('button', 'btn small ghost', t); x.type = 'button'; x.title = title; x.onclick = fn; acts.append(x); };
  if (it.hasValue) b('복사', '값 복사', () => copyValue(it));
  b('↑', '위로', () => vMove(it.key, -1)); b('↓', '아래로', () => vMove(it.key, 1));
  p.append(el('span', null, '키'), key, el('span', null, '다른 이름'), al, el('span', null, '분류'), cs, el('span', null, ''), nl, acts);
  return p;
}
function newRow(c) {
  const d = newDraft[c] || (newDraft[c] = { t: '', v: '' });
  const r = el('div', 'vr new' + (d.t || d.v ? ' draft' : '')); r.setAttribute('role', 'row');
  const commit = async () => {
    if (!d.t.trim() || d.busy) return;
    d.busy = true;
    const item = { cat: c, label: d.t.trim(), value: d.v };
    try {
      vdata = await call('POST', '/vault/save', { item });
      newDraft[c] = { t: '', v: '' }; flash = vdata.saved; pendingFocus = `n:${c}:t`;
      const s = vdata.items.find(i => i.key === vdata.saved);
      if (s && s.sens === '민감') toast(`"${s.label}"은(는) 민감 항목으로 저장했어요`);
      renderVault();
    } catch (e) { toast(e.message); }
    d.busy = false;
  };
  const ti = cell(`n:${c}:t`, d.t, '+ 항목 추가', () => {}, { max: 40, label: '새 항목 이름', onInput: v => { d.t = v; },
    onEnter: () => { r.querySelector('.vc.v .cell').focus(); }, onEsc: () => { d.t = ''; d.v = ''; setTimeout(renderVault, 0); } });
  const vi = cell(`n:${c}:v`, d.v, '내용', () => {}, { max: 500, label: '새 항목 내용', onInput: v => { d.v = v; }, onEnter: i => { i.blur(); commit(); }, onEsc: () => { d.t = ''; d.v = ''; setTimeout(renderVault, 0); } });
  r.addEventListener('focusout', ev => { r.classList.toggle('draft', !!(d.t || d.v)); if (!r.contains(ev.relatedTarget)) { if (d.t.trim()) commit(); else if (d.v) toast('항목 이름을 먼저 적어 주세요'); } });
  const tc = el('div', 'vc t'); tc.append(ti); const vc = el('div', 'vc v'); vc.append(vi);
  r.append(tc, vc, el('div', 'va'));
  return r;
}
function saveItem(key, patch) {   // queued so quick successive edits apply on top of each other
  const job = vq.then(async () => {
    const it = vdata.items.find(i => i.key === key);
    if (!it) return false;
    const item = { key: it.key, label: it.label, cat: it.cat, aliases: it.aliases || [], ac: it.ac || [], sens: it.sens, nofill: !!it.nofill,
      value: it.sens === '민감' ? null : (it.value == null ? '' : it.value), ...patch };
    try {
      vdata = await call('POST', '/vault/save', { item, origKey: it.key, keepValue: true });
      flash = vdata.saved; renderVault(); return true;
    } catch (e) { toast(e.message); renderVault(); return false; }
  });
  vq = job.catch(() => {});
  return job;
}
async function copyText(val) {
  try { await navigator.clipboard.writeText(val); }
  catch { const t = el('textarea'); t.value = val; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
}
async function copyValue(it) {
  try {
    const val = it.sens === '민감' ? (await call('POST', '/vault/reveal', { key: it.key })).value : it.value;
    await copyText(val); toast(`"${it.label}" 복사했어요`);
  } catch (e) { toast('복사 실패: ' + e.message); }
}
async function vMove(key, dir) { try { vdata = await call('POST', '/vault/move', { key, dir }); renderVault(); } catch (e) { toast(e.message); } }
async function vDelete(it) {
  try {
    vdata = await call('POST', '/vault/delete', { key: it.key }); advOpen.delete(it.key); revealed.delete(it.key); renderVault();
    const undo = vdata.undo;
    toast(`"${it.label}" 지웠어요`, undo ? { label: '되돌리기', fn: () => restore(undo) } : null);
  } catch (e) { toast(e.message); }
}
async function restore(id) {
  try { vdata = await call('POST', '/vault/restore', { id }); flash = vdata.restored; renderVault(); toast('되돌렸어요'); } catch (e) { toast(e.message); }
}
function fillCats(sel, cur) {
  sel.textContent = '';
  for (const c of vdata.categories) { const o = el('option', null, c); o.value = c; sel.append(o); }
  sel.value = cur || vdata.categories[0];
}
// ---------- 메모: a plain block at the end of its section, edited in place ----------
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 600) + 'px'; }
function noteBlock(m) {
  const isNew = !m.id, fk = isNew ? `nn:${m.cat}` : `m:${m.id}`;
  const box = el('div', 'vnote'); if (m.id) box.dataset.id = m.id;
  const cur = { title: m.title, body: m.body };
  const save = async () => {
    if (isNew && !cur.body.trim()) { delete noteDraft[m.cat]; setTimeout(renderVault, 0); return; }
    if (!isNew && cur.title === m.title && cur.body === m.body) return;
    try {
      vdata = await call('POST', '/vault/note-save', { id: m.id, note: { cat: m.cat, title: cur.title.trim() || '메모', body: cur.body } });
      if (isNew) delete noteDraft[m.cat];
      flash = 'm:' + vdata.savedNote; renderVault();
    } catch (e) { toast(e.message); }
  };
  const nt = el('div', 'nt');
  const ti = cell(`${fk}:t`, m.title, '메모 제목', v => { cur.title = v; save(); }, { max: 60, label: '메모 제목' });
  nt.append(ti);
  if (!isNew) nt.append(iconBtn('del', '메모 삭제', '×', () => noteDelete(m)));
  const ta = el('textarea'); ta.value = m.body || ''; ta.dataset.f = `${fk}:b`; ta.dataset.orig = ta.value; ta.spellcheck = false; ta.rows = 1;
  ta.placeholder = '메모 (줄바꿈 그대로 저장)'; ta.setAttribute('aria-label', '메모 내용');
  ta.oninput = () => { autosize(ta); };
  ta.onkeydown = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ta.value = ta.dataset.orig; ta.dataset.cancel = '1'; ta.blur(); if (isNew) { delete noteDraft[m.cat]; setTimeout(renderVault, 0); } } };
  ta.onblur = () => { if (ta.dataset.cancel) { delete ta.dataset.cancel; return; } cur.body = ta.value; if (ta.value !== ta.dataset.orig || isNew) save(); };
  requestAnimationFrame(() => autosize(ta));
  const sv = el('span', 'saved', '✓ 저장됨'); sv.dataset.saved = 'm:' + (m.id || '');
  box.append(nt, ta, sv);
  return box;
}
async function noteDelete(m) {
  try {
    vdata = await call('POST', '/vault/note-delete', { id: m.id }); renderVault();
    const undo = vdata.undo;
    toast(`메모 "${m.title}" 지웠어요`, undo ? { label: '되돌리기', fn: () => restore(undo) } : null);
  } catch (e) { toast(e.message); }
}

// ---------- 한꺼번에 추가 (paste -> preview -> 저장) ----------
let bPreview = null, bTimer = null, bSeq = 0;
const B_ST = { new: '새 항목', fill: '빈 값 채움', same: '같은 값 (그대로)', conflict: '이미 있음 · 기존 값 유지', skip: '저장 안 함' };
function openBulk() {
  if (!vdata) return;
  fillCats($('bCat'), $('bCat').value || vdata.categories[0]);
  $('bText').value = ''; $('bNoteTitle').value = ''; delete $('bNoteTitle').dataset.touched; $('bNote').checked = true;
  bPreview = null; renderBulk();
  $('vBulk').hidden = false; $('vMenu').hidden = true;
  $('bText').focus();
  $('vBulk').scrollIntoView({ block: 'nearest' });
}
function closeBulk() { $('vBulk').hidden = true; bPreview = null; $('bText').value = ''; $('bRows').textContent = ''; }
function rowStatus(r) {
  if (r.status === 'skip') return 'skip';
  const ex = vdata.items.find(i => i.key === r.key);
  if (!ex) return 'new';
  if (!ex.hasValue) return 'fill';
  return ex.value != null && ex.value === r.value ? 'same' : 'conflict';
}
async function bParse() {
  const text = $('bText').value, my = ++bSeq;
  if (!text.trim()) { bPreview = null; renderBulk(); return; }
  try {
    const p = await call('POST', '/vault/bulk-parse', { text, cat: $('bCat').value });
    if (my !== bSeq) return;
    p.text = text;
    for (const r of p.rows) r.include = r.status !== 'skip';
    bPreview = p;
    if (!$('bNoteTitle').dataset.touched) $('bNoteTitle').value = p.heading || '';
    $('bErr').hidden = true;
  } catch (e) { bPreview = null; $('bErr').textContent = e.message; $('bErr').hidden = false; }
  renderBulk();
}
function renderBulk() {
  const box = $('bRows'); box.textContent = '';
  const info = $('bInfo');
  $('bNoteTitleL').hidden = !$('bNote').checked;
  if (!bPreview) { info.textContent = ''; $('bSave').disabled = true; return; }
  const p = bPreview, rows = p.rows;
  const parts = [`${rows.length}줄 읽음`];
  if (p.heading) parts.push(`제목 "${p.heading}"`);
  if (p.headerSkipped) parts.push('머리 행(항목 정보) 건너뜀');
  if (p.unparsed.length) parts.push(`읽지 못한 줄 ${p.unparsed.length}개 (메모에는 들어감)`);
  if (p.noteDropped) parts.push(`저장 안 하는 줄 ${p.noteDropped}개는 메모에서도 뺌`);
  info.textContent = parts.join(' · ');
  for (const r of rows) {
    const st = rowStatus(r);
    const w = el('div', 'brow' + (r.include ? '' : ' off'));
    const r1 = el('div', 'r1');
    const inc = el('input'); inc.type = 'checkbox'; inc.checked = !!r.include; inc.disabled = st === 'skip'; inc.title = '이 줄을 항목으로 저장';
    inc.onchange = () => { r.include = inc.checked; renderBulk(); };
    const lab = el('input', 'bl'); lab.value = r.label; lab.maxLength = 40; lab.setAttribute('aria-label', '이름'); lab.oninput = () => { r.label = lab.value; };
    const key = el('input', 'bk'); key.value = r.key; key.maxLength = 40; key.placeholder = '키(자동)'; key.spellcheck = false; key.setAttribute('aria-label', '키');
    key.onchange = () => { r.key = key.value.trim().toLowerCase(); renderBulk(); };
    const badge = el('span', 'bst ' + st, B_ST[st]);
    r1.append(inc, lab, key, badge); w.append(r1);
    if (st === 'skip') { w.append(el('div', 'why', r.reason || '저장할 수 없는 줄')); box.append(w); continue; }
    const val = el('input'); val.value = r.value; val.maxLength = 500; val.spellcheck = false; val.setAttribute('aria-label', '값');
    val.oninput = () => { r.value = val.value; };
    const al = el('input'); al.value = (r.aliases || []).join(', '); al.placeholder = r.nofill ? '자동 기입 안 함' : '다른 이름 (쉼표로)'; al.setAttribute('aria-label', '다른 이름');
    al.oninput = () => { r.aliases = al.value.split(',').map(x => x.trim()).filter(Boolean); };
    w.append(val, al);
    const r3 = el('div', 'r3');
    const cs = el('select'); fillCats(cs, r.cat); cs.setAttribute('aria-label', '분류'); cs.onchange = () => { r.cat = cs.value; };
    const sl = el('label'); const sc = el('input'); sc.type = 'checkbox'; sc.checked = r.sens === '민감'; sc.onchange = () => { r.sens = sc.checked ? '민감' : '일반'; }; sl.append(sc, document.createTextNode('민감'));
    const nl = el('label'); const nc = el('input'); nc.type = 'checkbox'; nc.checked = !!r.nofill; nc.onchange = () => { r.nofill = nc.checked; }; nl.append(nc, document.createTextNode('자동 기입 안 함'));
    nl.title = '나이처럼 계산된 정보: 저장은 하지만 입력칸 자동 매칭에는 쓰지 않아요';
    r3.append(cs, sl, nl); w.append(r3);
    box.append(w);
  }
  const n = rows.filter(r => r.include && rowStatus(r) !== 'skip').length;
  $('bSave').disabled = !n && !($('bNote').checked && rows.length);
  $('bSave').textContent = `저장${n ? ` (${n}개${$('bNote').checked ? ' + 메모' : ''})` : $('bNote').checked ? ' (메모만)' : ''}`;
}
$('vBulkBtn').onclick = () => { if ($('vBulk').hidden) openBulk(); else closeBulk(); };
$('bCancel').onclick = closeBulk;
$('bText').oninput = () => { clearTimeout(bTimer); bTimer = setTimeout(bParse, 300); };
$('bText').onpaste = () => { clearTimeout(bTimer); bTimer = setTimeout(bParse, 50); };
$('bCat').onchange = () => { if (bPreview) bParse(); };
$('bNote').onchange = renderBulk;
$('bNoteTitle').oninput = () => { $('bNoteTitle').dataset.touched = '1'; };
$('vBulk').onsubmit = async ev => {
  ev.preventDefault();
  if (!bPreview) return;
  const rows = bPreview.rows.map(r => ({ label: r.label, value: r.value, key: r.key, aliases: r.aliases, ac: r.ac, cat: r.cat, sens: r.sens, nofill: !!r.nofill,
    include: !!r.include && rowStatus(r) !== 'skip' }));
  const nRefused = bPreview.rows.filter(r => r.status === 'skip').length;
  $('bSave').disabled = true;
  try {
    vdata = await call('POST', '/vault/bulk-save', { text: bPreview.text, cat: $('bCat').value, rows, note: { on: $('bNote').checked, title: $('bNoteTitle').value.trim() } });
    const r = vdata.bulk || { added: [], filled: [], same: [], conflicts: [], skipped: [] };
    closeBulk(); renderVault();
    const msg = [`추가 ${r.added.length}`];
    if (r.filled.length) msg.push(`빈 값 채움 ${r.filled.length}`);
    if (r.conflicts.length) msg.push(`이미 있어 유지 ${r.conflicts.length} (${r.conflicts.join(', ')})`);
    const sk = r.skipped.filter(x => x.reason !== '선택 안 함').length + nRefused;
    if (sk) msg.push(`건너뜀 ${sk} (저장 안 하는 정보)`);
    if (r.note) msg.push(r.note.status === 'added' ? '메모 저장' : r.note.status === 'same' ? '같은 메모가 이미 있음' : `메모 안 됨: ${r.note.reason || ''}`);
    toast('저장했어요: ' + msg.join(' · '));
  } catch (e) { $('bErr').textContent = e.message; $('bErr').hidden = false; renderBulk(); }
};

$('vSearch').oninput = renderVault;
$('vMore').onclick = () => { const m = $('vMenu'); m.hidden = !m.hidden; $('vMore').setAttribute('aria-expanded', String(!m.hidden)); };
$('vExport').onclick = async () => {
  $('vMenu').hidden = true;
  if (!confirm('내보낸 파일에는 모든 값(민감 항목 포함)이 암호화되지 않은 채로 들어가요.\n백업 후에는 안전한 곳에 두거나 지우세요. 계속할까요?')) return;
  try {
    const j = await call('POST', '/vault/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }));
    const a = el('a'); a.href = url; a.download = `chrome-live-내정보-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('내보냈어요 (다운로드 폴더). 다 쓰면 파일을 지우세요.');
  } catch (e) { toast('내보내기 실패: ' + e.message); }
};
$('vImport').onclick = () => { $('vMenu').hidden = true; $('vFile').value = ''; $('vFile').click(); };
$('vFile').onchange = async () => {
  const f = $('vFile').files[0]; if (!f) return;
  let data; try { data = JSON.parse(await f.text()); } catch { toast('JSON 파일이 아니에요'); return; }
  const replace = vdata && vdata.items.length ? confirm('기존 항목을 모두 지우고 바꿀까요?\n[확인] 전부 바꾸기 · [취소] 합치기(같은 키는 덮어씀)') : false;
  try {
    vdata = await call('POST', '/vault/import', { data, mode: replace ? 'replace' : 'merge' });
    renderVault();
    const r = vdata.imported || { added: 0, updated: 0, skipped: [] };
    toast(`가져왔어요: 추가 ${r.added} · 수정 ${r.updated}${r.skipped.length ? ' · 건너뜀 ' + r.skipped.length + ' (' + r.skipped.map(x => x.label + ': ' + x.reason).join(' / ').slice(0, 160) + ')' : ''}`);
  } catch (e) { toast('가져오기 실패: ' + e.message); }
};

// ---------- 민감 입력 확인 카드 (shown above every view) ----------
let confirmSig = '';
const confirmBusy = new Set();
function renderConfirms(list) {
  const sig = list.map(p => p.id).join(',') + '|' + [...confirmBusy].join(',');
  const box = $('confirms');
  if (sig === confirmSig) { for (const c of box.querySelectorAll('[data-exp]')) c.textContent = Math.max(0, Math.round((new Date(c.dataset.exp) - Date.now()) / 1000)) + '초 남음'; return; }
  confirmSig = sig; box.textContent = '';
  for (const p of list) {
    const c = el('div', 'ccard');
    c.append(el('div', 'ct', (p.test ? '[테스트] ' : '') + '이 항목들을 입력할까요?'));
    const m = tabMeta(p.tabId);
    c.append(el('div', 'cs', `탭: ${p.title || m.title || p.tabId}${p.host || m.host ? ' · ' + (p.host || m.host) : ''}`));
    const ul = el('ul'); for (const it of p.items) ul.append(el('li', null, it.label)); c.append(ul);
    if (p.always) c.append(el('div', 'cs calways', '주민번호 뒷자리는 채팅에서 부탁했어도 매번 여기서 확인해요'));
    const cb = el('div', 'cb');
    const left = el('span', 'muted', ''); left.dataset.exp = p.expiresAt; left.textContent = Math.max(0, Math.round((new Date(p.expiresAt) - Date.now()) / 1000)) + '초 남음';
    const no = el('button', 'btn small', '취소'), yes = el('button', 'btn small primary', '입력');
    const answer = async ok => { confirmBusy.add(p.id); no.disabled = yes.disabled = true;
      try { await call('POST', '/vault/confirm', { id: p.id, ok }); toast(ok ? '입력을 허용했어요' : '취소했어요'); } catch (e) { toast(e.message); }
      poll(); };
    no.onclick = () => answer(false); yes.onclick = () => answer(true);
    if (confirmBusy.has(p.id)) no.disabled = yes.disabled = true;
    cb.append(left, no, yes); c.append(cb); box.append(c);
  }
}

// ---------- 설정 (daemon GET/POST /panel/settings) ----------
let sdata = null;
async function loadSettings() {
  let r;
  // POST with an empty body = read (extension GETs carry no Origin header, which /panel/* requires)
  try { r = await req('POST', '/settings', {}); } catch (e) { return settingsOff('데몬에 연결할 수 없어요'); }
  if (r.status === 404) return settingsOff('데몬 업데이트 필요 — 데몬을 다시 시작하면 설정을 바꿀 수 있어요');
  if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error || m; } catch {} return settingsOff(m); }
  try { sdata = await r.json(); } catch { return settingsOff('설정을 읽지 못했어요'); }
  $('sErr').hidden = true; $('sBody').classList.remove('off');
  renderSettings();
  loadUpdate(false);
}
function settingsOff(msg) { sdata = null; $('sErr').textContent = msg; $('sErr').hidden = false; $('sBody').classList.add('off'); }
function renderSettings() {
  if (!sdata) return;
  for (const r of document.querySelectorAll('input[name=attachMode]')) r.checked = r.value === (sdata.attachMode || 'on-demand');
  const sec = Number(sdata.disconnectAfterIdleSec) || 0;
  $('sAuto').checked = sec > 0; $('sAutoMin').disabled = sec <= 0;
  if (document.activeElement !== $('sAutoMin')) $('sAutoMin').value = sec > 0 ? Math.max(1, Math.round(sec / 60)) : ($('sAutoMin').value || 5);
  if (document.activeElement !== $('sIdleMin')) $('sIdleMin').value = sdata.idleMinutes != null ? sdata.idleMinutes : '';
  if (document.activeElement !== $('sTabIdle')) $('sTabIdle').value = sdata.tabIdleDetachSec != null ? sdata.tabIdleDetachSec : '';
  const cwd = sdata.chatCwd || sdata.chatWorkDir || null, hasFollow = typeof sdata.chatFollowActiveTab === 'boolean';
  $('sInfoSec').hidden = !cwd && !hasFollow; $('sCwdRow').hidden = !cwd; if (cwd) { $('sCwd').textContent = cwd; $('sCwd').title = cwd; }
  $('sFollowRow').hidden = $('sFollowHint').hidden = !hasFollow;
  if (hasFollow) { $('sFollow').checked = sdata.chatFollowActiveTab; if (sdata.chatFollowActiveTab !== FOLLOW.on) setFollow(sdata.chatFollowActiveTab, false); }
  renderEngineSetting();
  renderModelSetting();
  renderMcp();
  renderRecipeSetting();
  renderDaemonInfo();
}
// 레시피: 작업 후 자동 정리 + thresholds (docs/recipes/PRD.md); hidden for an older daemon without these keys
function renderRecipeSetting() {
  const has = !!sdata && typeof sdata.recipeAutoWrite === 'boolean';
  $('sRecipeSec').hidden = !has; if (!has) return;
  $('sRecipeAuto').checked = sdata.recipeAutoWrite;
  for (const [id, k] of [['sRecipeSec2', 'recipeMinTurnSec'], ['sRecipeTools', 'recipeMinTools'], ['sRecipeDaily', 'recipeDailyMax'], ['sTraceDays', 'traceKeepDays']]) {
    if (document.activeElement !== $(id)) $(id).value = sdata[k] != null ? sdata[k] : '';
    $(id).disabled = k !== 'traceKeepDays' && !sdata.recipeAutoWrite;
  }
  const codexOk = !sdata.codex || sdata.codex.available !== false;
  $('sRecipeModel').querySelector('option[value="codex"]').disabled = !codexOk;
  $('sRecipeModel').value = sdata.recipeWriterModel || 'sonnet'; $('sRecipeModel').disabled = !sdata.recipeAutoWrite;
}
const recipeSaved = () => { const t = $('sv-recipe'); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1300); };
$('sRecipeAuto').onchange = async () => { await saveSetting('recipeAutoWrite', $('sRecipeAuto').checked); recipeSaved(); };
$('sRecipeModel').onchange = async () => { await saveSetting('recipeWriterModel', $('sRecipeModel').value); recipeSaved(); };
// 채팅 엔진: default engine for NEW threads (chatEngine); Codex disabled with the daemon's hint when the CLI is not found
function renderEngineSetting() {
  const has = !!sdata && (sdata.chatEngine === 'claude' || sdata.chatEngine === 'codex');
  $('sEngSec').hidden = !has; if (!has) return;
  const ok = !sdata.codex || sdata.codex.available !== false;
  for (const r of document.querySelectorAll('input[name=chatEngine]')) { r.checked = r.value === sdata.chatEngine; if (r.value === 'codex') r.disabled = !ok; }
  $('sEngCodex').classList.toggle('off', !ok);
  $('sEngHint').hidden = ok; $('sEngHint').textContent = ok ? '' : (sdata.codex && sdata.codex.hint) || 'Codex CLI를 찾지 못했어요';
}
for (const r of document.querySelectorAll('input[name=chatEngine]')) r.onchange = () => { if (r.checked) saveSetting('chatEngine', r.value); };
$('sFollow').onchange = () => saveSetting('chatFollowActiveTab', $('sFollow').checked);
// 채팅 모델: 4 selects (Claude/Codex × 모델/추론 강도), the same values as the ▾ menu next to the engine toggle
const SMODEL = { sChatModel: ['chatModel', 'claude', 'models'], sChatEffort: ['chatEffort', 'claude', 'efforts'], sCodexModel: ['codexModel', 'codex', 'models'], sCodexEffort: ['codexEffort', 'codex', 'efforts'] };
function renderModelSetting() {
  const has = !!(sdata && sdata.models);
  $('sModelSec').hidden = !has; if (!has) return;
  prefsFrom(sdata); renderChatControls();
  const codexOk = !sdata.codex || sdata.codex.available !== false;
  for (const [id, [key, eng, kind]] of Object.entries(SMODEL)) {
    const sel = $(id), list = (sdata.models[eng] || {})[kind] || [];
    fillSelectOpts(sel, list.map(x => [x.value, x.label]));
    sel.value = sdata[key] || '';
    if (eng === 'codex') sel.disabled = !codexOk;
  }
}
function fillSelectOpts(sel, items) {
  const sig = items.map(x => x.join('\u0002')).join('\u0001');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig; sel.textContent = '';
  for (const [v, t] of items) { const o = el('option', null, t); o.value = v; sel.append(o); }
}
for (const [id, [key]] of Object.entries(SMODEL)) $(id).onchange = async () => {
  await saveSetting(key, $(id).value);
  const t = $('sv-models'); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1300);
};
// 채팅에서 쓸 도구(MCP): one switch per server from the owner's Claude config (names only; chrome-live always on)
function renderMcp() {
  const m = sdata && sdata.chatMcp;
  $('sMcpSec').hidden = !m; if (!m) return;
  const always = m.always || 'chrome-live', on = new Set(Array.isArray(m.enabled) ? m.enabled : [always]);
  const list = $('sMcpList'); list.textContent = '';
  for (const s of Array.isArray(m.available) ? m.available : []) {
    const row = document.createElement('div'); row.className = 'srow smcp';
    const lab = document.createElement('label'); lab.className = 'switch';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.dataset.name = s.name;
    const fixed = s.name === always;
    inp.checked = fixed || on.has(s.name); inp.disabled = fixed;
    const tr = document.createElement('span'); tr.className = 'track';
    const nm = document.createElement('span'); nm.className = 'swl2 smcpn'; nm.textContent = s.name; nm.title = s.name;
    lab.append(inp, tr, nm);
    const sp = document.createElement('span'); sp.className = 'spacer';
    const meta = document.createElement('span'); meta.className = 'meta-t'; meta.textContent = fixed ? '항상 사용' : (s.type || '');
    row.append(lab, sp, meta); list.append(row);
    if (!fixed) inp.onchange = () => {
      const names = [...list.querySelectorAll('input[data-name]')].filter(x => x.checked).map(x => x.dataset.name);
      saveSetting('chatMcpServers', names);
    };
  }
  $('sMcpErr').hidden = !m.error; $('sMcpErr').textContent = m.error ? m.error + ' — 채팅은 평소 MCP 서버 전부로 시작해요' : '';
}
// read-only build line at the bottom of 설정: "데몬 v2.0.0 · 코드 abc123 · 시작 21:30" (+ warning when the code on disk changed)
function renderDaemonInfo() {
  const d = status ? status.daemon || (sdata && sdata.daemon) || null : null;   // daemon unreachable -> hide (no stale info)
  $('sVer').hidden = !d; if (!d) return;
  const hm = t => { const x = new Date(t); if (isNaN(x)) return '?'; const p = n => String(n).padStart(2, '0'); const today = new Date().toDateString() === x.toDateString();
    return (today ? '' : `${x.getMonth() + 1}/${x.getDate()} `) + `${p(x.getHours())}:${p(x.getMinutes())}`; };
  const parts = [`데몬 v${d.version || '?'}`, `코드 ${String(d.code || '?').slice(0, 6)}`];
  if (d.startedAt) parts.push(`시작 ${hm(d.startedAt)}`);
  $('sVerT').textContent = parts.join(' · ');
  $('sVer').title = `코드 ${d.code || '?'}${d.workerCode ? ' · 워커 ' + d.workerCode : ''} · 시작 ${d.startedAt || '?'}`;
  $('sVerWarn').hidden = d.stale !== true;
}

// ---------- 업데이트 (v2.1, daemon POST /panel/update): installed vs latest (public dist repo version.json, cached by the daemon).
// 업데이트 = copy a ready message for Claude CLI (install.ps1 one-liner with -Dir = this install); nothing is updated from here.
let upd = null, updBusy = false;
async function loadUpdate(check) {
  if (!token || updBusy) return;
  updBusy = true; if (check) { $('sUpdState').textContent = '확인 중…'; $('sUpdCheck').disabled = true; }
  try {
    const r = await req('POST', '/update', check ? { check: true } : {});
    upd = r.status === 404 ? null : r.ok ? await r.json() : upd;   // 404 = older daemon without the endpoint -> section hidden
    if (check && upd && upd.error) toast('확인 못 했어요: ' + upd.error);
    else if (check && upd && !upd.newer) toast(`최신 버전이에요 (v${upd.current})`);
  } catch {}
  updBusy = false; $('sUpdCheck').disabled = false;
  renderUpdate();
}
function renderUpdate() {
  const u = upd, newer = !!(u && u.newer && u.latest);
  $('sUpdSec').hidden = !u || !!u.off;
  $('updBar').hidden = !newer || store.get('updDismiss', '') === u.latest.version;
  if (newer) $('updBarV').textContent = 'v' + u.latest.version;
  if (!u) return;
  $('sUpdCur').textContent = `설치된 버전 v${u.current || '?'}`;
  const hm = t => { const x = new Date(t); const p = n => String(n).padStart(2, '0'); return isNaN(x) ? '' : `${p(x.getHours())}:${p(x.getMinutes())}`; };
  $('sUpdState').textContent = updBusy ? '확인 중…' : newer ? `새 버전 v${u.latest.version}` : u.error ? '확인 못 함' : u.latest ? `최신 버전${u.checkedAt ? ' · ' + hm(u.checkedAt) + ' 확인' : ''}` : '';
  $('sUpdState').title = u.error ? '최신 버전 확인 실패: ' + u.error : '';
  $('sUpdNew').hidden = !newer;
  if (newer) {
    $('sUpdNewV').textContent = `새 버전 v${u.latest.version}`;
    $('sUpdDate').textContent = u.latest.date || '';
    const ul = $('sUpdNotes'); ul.textContent = '';
    for (const n of u.latest.notes || []) ul.append(el('li', null, n));
  }
  const have = chrome.runtime.getManifest().version, off = !!u.ext && u.ext !== have;
  $('sUpdExt').hidden = !off;
  $('sUpdExt').textContent = off ? `이 확장 프로그램(v${have})이 설치 폴더의 확장(v${u.ext})과 달라요 — chrome://extensions에서 chrome-live 새로고침(↻), 로드한 폴더가 ${u.dir}\\extension인지 확인` : '';
}
async function copyUpdateMessage() {
  if (!upd || !upd.message) { await loadUpdate(false); if (!upd || !upd.message) { toast('새 버전 정보가 없어요'); return; } }
  try { await copyText(upd.message); toast('복사했어요 — Claude CLI에 붙여 넣으세요'); } catch (e) { toast('복사 실패: ' + e.message); }
}
$('sUpdCheck').onclick = () => loadUpdate(true);
$('sUpdGo').onclick = copyUpdateMessage;
$('updBarGo').onclick = copyUpdateMessage;
$('updBarX').onclick = () => { if (upd && upd.latest) store.set('updDismiss', upd.latest.version); renderUpdate(); };
// after an update the daemon reports the extension version ON DISK; a panel still running the old copy reloads the extension
// ONCE per target version (remembered), so a copy loaded from another folder (versions never match) cannot loop.
// Not while a message is being typed or an answer streams (a later poll does it).
function maybeReloadExt(want) {
  const have = chrome.runtime.getManifest().version;
  if (!want || want === have) return false;
  const last = store.get('extReload', null);
  if (last && last.to === want) return false;
  if (chatRun || ($('cText').value || '').trim()) return false;
  store.set('extReload', { to: want, from: have, at: Date.now() });
  chrome.runtime.reload();
  return true;
}
async function saveSetting(field, value) {
  if (!sdata) return;
  try {
    const r = await req('POST', '/settings', { [field]: value });
    if (r.status === 404) return settingsOff('데몬 업데이트 필요 — 데몬을 다시 시작하면 설정을 바꿀 수 있어요');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    sdata = j && typeof j === 'object' && 'attachMode' in j ? j : { ...sdata, [field]: value };
    renderSettings();
    const t = $('sv-' + field); if (t) { t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1300); }
    poll();
  } catch (e) { toast('저장 실패: ' + e.message); renderSettings(); }
}
for (const r of document.querySelectorAll('input[name=attachMode]')) r.onchange = () => { if (r.checked) saveSetting('attachMode', r.value); };
$('sAuto').onchange = () => saveSetting('disconnectAfterIdleSec', $('sAuto').checked ? Math.max(1, Number($('sAutoMin').value) || 5) * 60 : 0);
const numSave = (inp, field, fn) => { inp.onchange = () => { const n = Number(inp.value); if (!Number.isFinite(n) || n < 0) { toast('0 이상의 숫자를 넣어 주세요'); return renderSettings(); } saveSetting(field, fn(n)); };
  inp.onkeydown = ev => { if (ev.key === 'Enter') inp.blur(); else if (ev.key === 'Escape') { inp.blur(); renderSettings(); } }; };
numSave($('sAutoMin'), 'disconnectAfterIdleSec', n => Math.max(1, Math.round(n)) * 60);
numSave($('sIdleMin'), 'idleMinutes', n => Math.round(n));
numSave($('sTabIdle'), 'tabIdleDetachSec', n => Math.round(n));
numSave($('sRecipeSec2'), 'recipeMinTurnSec', n => Math.round(n));
numSave($('sRecipeTools'), 'recipeMinTools', n => Math.round(n));
numSave($('sRecipeDaily'), 'recipeDailyMax', n => Math.round(n));
numSave($('sTraceDays'), 'traceKeepDays', n => Math.round(n));

// ---------- start ----------
chatTab = store.get('chatTab', '');
renderPicker(); renderFollow();
// chat preferences from the daemon config (보는 탭 따라가기, ...): the owner's setting wins over this panel's cached copy
async function loadChatPrefs() {
  try {
    const s = await call('POST', '/settings', {});
    if (typeof s.chatFollowActiveTab === 'boolean' && s.chatFollowActiveTab !== FOLLOW.on) setFollow(s.chatFollowActiveTab, false);
    prefsFrom(s); renderChatControls();
  } catch {}
}
(async () => { await poll(); const v = store.get('view', 'chat'); setView(v === 'tabs' ? 'chat' : v); if (token) await loadChatPrefs(); initFollow(); loadUpdate(false); })();
setInterval(() => loadUpdate(false), 30 * 60000);   // the daemon caches 6 h; this only picks up its newer result
setInterval(poll, POLL_MS);
setInterval(() => { if (view === 'chat' || !tabsData.tabs.length) pollTabs(); }, TABS_MS);
