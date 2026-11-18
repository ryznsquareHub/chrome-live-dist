// 프로필 기억 (owner request 2026-11-09): which Chrome profile (and, cheaply, which account inside it) did SUCCESSFUL
// work on a site, so a new tab for that site lands in the logged-in profile instead of Chrome's CDP default.
//   - learns only from ok:true `run` / `fill` (recipe run = run). Never from failures, snapshots/shots (reading a
//     logged-out page proves nothing), login/account hosts (accounts.google.com, nid.naver.com ...), login-looking
//     pages (URL path / tab title), local hosts (127.0.0.1, localhost, about:, extensions).
//   - profile identity: profile folder (Local State, e.g. "Profile 14") > profile name > CDP browserContextId (only
//     valid while this Chrome run lasts). Letters (A, B ...) are NOT identities: they reset on every connection.
//   - per host: every profile seen, with count + last success + an account hint from the URL (YouTube channel id,
//     Google authuser index). The most recent success is the default ("open" uses it).
//   - file STATE_DIR\profile-memory.json (no titles, no URLs, no page content). First start without the file seeds it
//     from events.jsonl (+ .old). Survives the trace cleanup (it is its own summary).
//   - owner choice (2026-11-09): when the memory is missing / ambiguous the agent asks the owner (AskUserQuestion in the
//     terminal, the panel's choice card in panel chat); the answer is stored as `own` (pin) on that profile and outranks
//     every count until the owner picks again or the site is forgotten.
//   - 여러 계정 (owner 2026-11-09, reddit with 3 profiles): a host in ask mode (`hosts[h].ask = {on, cand:[{name,dir}], last}`)
//     never has a default: open without --profile refuses, hints say "여러 계정 사용: 매번 주인에게 물어봄 · 후보 …", and an
//     answer / `profiles set` only records `ask.last` (recommended first next time), never a pin.
//   - 테스트용 profiles (`tags["dir:Profile 9"|"name:X"] = {test, name, dir}`): labelled "(테스트용)", never best / recommended /
//     ambiguous-maker (their successes are still counted, but never override real profiles). An explicit owner pick still wins.
//   - ambiguous (no pin, 2+ profiles): the most recent "really used" profile (default rule) is not the most-used one,
//     OR the top two are within 2x of each other (and the second has >= 2 successes). A 1-2 run check elsewhere is not.
'use strict';
const fs = require('fs');
const path = require('path');

const LEARN_CMDS = new Set(['run', 'fill']);
const LOGIN_HOST = /^(accounts?|login|logins|signin|sign-in|sso|auth|oauth|id|nid|idp|passport|appleid|myaccount)\./i;
const LOGIN_TITLE = /(로그인|log ?in|sign ?in|sign-in|signin|본인\s*확인이 필요|다시 로그인)/i;
const MAX_HOSTS = 500, MAX_PROFILES = 8;
// second-level public suffixes common for this owner (enough for "same site" fallback; exact host always wins)
const SL2 = new Set(['co.kr', 'go.kr', 'or.kr', 'ne.kr', 'ac.kr', 're.kr', 'pe.kr', 'ms.kr', 'hs.kr', 'es.kr', 'kg.kr', 'sc.kr', 'mil.kr',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.cn', 'com.tw', 'com.hk', 'com.sg', 'com.br', 'co.in', 'co.nz']);

const bareHost = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
function siteOf(host) {
  const h = bareHost(host); const p = h.split('.');
  if (p.length <= 2) return h;
  return SL2.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
// hosts worth remembering a profile for (real sites). Local / browser pages never.
function learnableHost(host) {
  const h = bareHost(host);
  if (!h || !h.includes('.') || h.startsWith('ext:') || h === 'localhost' || h.endsWith('.localhost')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return false;
  return !LOGIN_HOST.test(h);
}
// profile name as shown by Chrome: "<name> (<google name>)" (+ " (추정)" when only guessed). The bare name is enough
// and carries no person's name.
const baseName = n => n == null ? null : String(n).replace(/\s*\(추정\)\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim() || null;
const isGuess = n => /\(추정\)\s*$/.test(String(n || ''));
const short = iso => { if (!iso) return '-'; const d = new Date(iso); return isNaN(d) ? '?' : `${d.getMonth() + 1}/${d.getDate()}`; };

module.exports = function initProfileMemory({ file, log = () => {}, eventsFiles = [], localState = null }) {
  let M = { v: 1, hosts: {}, tags: {} };
  let fresh = false;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.hosts && typeof j.hosts === 'object') M = { v: 1, hosts: j.hosts, tags: j.tags && typeof j.tags === 'object' ? j.tags : {} }; }
  catch { fresh = true; }

  // profile folder for a profile name (Local State info_cache, read-only; names only). Re-read after 60 s (new profiles).
  // localState: a path, or a function returning the path
  let lsCache = null, lsAll = [], lsAt = 0, lsKey = '';
  function readLs() {
    const f = typeof localState === 'function' ? localState() : localState;
    let key = String(f); try { key += ':' + fs.statSync(f).mtimeMs; } catch {}
    if (lsCache && key === lsKey && Date.now() - lsAt < 60000) return;
    lsCache = new Map(); lsAll = []; lsAt = Date.now(); lsKey = key;
    try {
      const p = JSON.parse(fs.readFileSync(f, 'utf8')).profile || {};
      const byName = {};
      for (const [dir, v] of Object.entries(p.info_cache || {})) { const n = String(v.name || dir).trim(); (byName[n] = byName[n] || []).push(dir); lsAll.push({ dir, name: n }); }
      for (const [n, dirs] of Object.entries(byName)) if (dirs.length === 1) lsCache.set(n, dirs[0]);   // ambiguous names -> no folder
    } catch {}
  }
  function dirForName(name) { if (!name) return null; readLs(); return lsCache.get(name) || null; }
  // every profile Chrome knows (open or closed): [{dir, name}] (names only)
  function localProfiles() { readLs(); return lsAll.slice(); }

  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(flush, 1500);
  }
  function flush() {
    clearTimeout(saveT); saveT = null;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(M));
      fs.renameSync(tmp, file);
    } catch (e) { log(`profile memory save failed: ${e.message}`); }
  }

  // identity -> storage key. Merges older weaker keys (name:/ctx:) into the folder key when both are known.
  function keyOf(id) { return id.dir ? 'dir:' + id.dir : id.name ? 'name:' + id.name : id.ctx ? 'ctx:' + id.ctx : null; }
  function add(host, id, at, acct) {
    let key = keyOf(id); if (!key) return false;
    const h = M.hosts[host] = M.hosts[host] || { p: {} };
    if (key.startsWith('ctx:')) { const same = Object.keys(h.p).find(k => h.p[k].ctx === id.ctx); if (same) key = same; }   // name/folder already known for this context
    const e = h.p[key] = h.p[key] || { n: 0, last: null };
    for (const [k, v] of Object.entries(h.p)) {   // same profile seen before under a weaker key
      if (k === key) continue;
      if ((k === 'name:' + id.name && id.name) || (k === 'ctx:' + id.ctx && id.ctx && key !== 'ctx:' + id.ctx)) {
        e.n += v.n || 0; if (!e.last || (v.last && v.last > e.last)) e.last = v.last; if (!e.acct && v.acct) e.acct = v.acct; if (v.own && !e.own) e.own = v.own;
        delete h.p[k];
      }
    }
    e.n++; if (!e.last || at > e.last) { e.last = at; if (acct) e.acct = acct; } else if (acct && !e.acct) e.acct = acct;
    if (id.dir) e.dir = id.dir; if (id.name) e.name = id.name; if (id.ctx) e.ctx = id.ctx;
    if (!id.guess) delete e.guess; else if (e.n === 1) e.guess = true;   // named only by elimination (tabs shows '(추정)') until a certain sighting
    // caps: keep the most recent profiles per host / hosts overall
    const ks = Object.keys(h.p).filter(k => !h.p[k].own); if (Object.keys(h.p).length > MAX_PROFILES && ks.length) { ks.sort((a, b) => String(h.p[a].last).localeCompare(String(h.p[b].last))); delete h.p[ks[0]]; }   // the owner's pick is never dropped
    const hs = Object.keys(M.hosts).filter(x => !M.hosts[x].ask); if (Object.keys(M.hosts).length > MAX_HOSTS && hs.length) { hs.sort((a, b) => String(lastOf(a)).localeCompare(String(lastOf(b)))); delete M.hosts[hs[0]]; }
    return true;
  }
  const lastOf = host => Object.values((M.hosts[host] || {}).p || {}).reduce((m, e) => e.last > m ? e.last : m, '');

  // one finished command (server.js forward): cmd, ok, meta from the worker {host, profile, profileName, profileDir, ctx, acct, login, title}
  function learn(cmd, ok, meta) {
    if (!ok || !LEARN_CMDS.has(cmd) || !meta || !learnableHost(meta.host)) return false;
    if (meta.login || LOGIN_TITLE.test(String(meta.title || ''))) return false;
    const guess = isGuess(meta.profileName);
    const name = baseName(meta.profileName);
    const certainDir = typeof meta.profileDir === 'string' && meta.profileDir ? meta.profileDir.slice(0, 60) : null;
    const dir = certainDir || (name ? dirForName(name) : null);
    const ctx = typeof meta.ctx === 'string' && /^[0-9A-Fa-f]{8,64}$/.test(meta.ctx) ? meta.ctx : null;
    const acct = typeof meta.acct === 'string' && /^(channel:UC[\w-]{22}|authuser:\d{1,2})$/.test(meta.acct) ? meta.acct : null;
    const done = add(String(meta.host).toLowerCase().slice(0, 120), { dir, name, ctx, guess: guess && !certainDir }, new Date().toISOString(), acct);
    if (done) save();
    return done;
  }

  // ---- seed from the event log (first start only): letters reset per connection, so names are filled in per
  // connection (a letter named once in a connection = that profile for the whole connection); unnamed skipped,
  // names Chrome-live only guessed by elimination are kept but flagged guess (shown "(추정)")
  function seed(lines) {
    let seg = 0; const segNames = new Map(); const evs = [];
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.cmd === 'connect' && e.ok) { seg++; continue; }
      if (e.profile && e.profileName) { const k = seg + ':' + e.profile; const cur = segNames.get(k); if (!cur || (cur.guess && !isGuess(e.profileName))) segNames.set(k, { name: baseName(e.profileName), guess: isGuess(e.profileName) }); }
      evs.push({ e, seg });
    }
    let n = 0;
    for (const { e, seg: s } of evs) {
      if (!e.ok || !LEARN_CMDS.has(e.cmd) || !learnableHost(e.host) || LOGIN_TITLE.test(String(e.title || ''))) continue;
      const nm = e.profile ? segNames.get(s + ':' + e.profile) : null;
      if (!nm || !nm.name) continue;
      if (add(String(e.host).toLowerCase(), { dir: dirForName(nm.name), name: nm.name, guess: nm.guess }, e.t || new Date().toISOString(), null)) n++;
    }
    return n;
  }
  if (fresh) {
    const lines = [];
    for (const f of eventsFiles) { try { lines.push(...fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)); } catch {} }
    const n = lines.length ? seed(lines) : 0;
    log(`profile memory: new file, seeded ${n} successful actions from the event log (${Object.keys(M.hosts).length} sites)`);
    flush();
  }

  // ---- lookup: exact host first, then the same site (studio.youtube.com <-> www.youtube.com). Best = most recent success.
  function entriesFor(host) {
    const h = String(host || '').toLowerCase();
    if (M.hosts[h]) return { via: 'exact', host: h, p: M.hosts[h].p };
    const site = siteOf(h); if (!site) return null;
    const agg = {};
    for (const [hh, v] of Object.entries(M.hosts)) {
      if (siteOf(hh) !== site) continue;
      for (const [k, e] of Object.entries(v.p)) {
        const a = agg[k] = agg[k] || { n: 0, last: '' };
        a.n += e.n || 0; if (e.last > a.last) { a.last = e.last; if (e.acct) a.acct = e.acct; a.from = hh; }
        for (const f of ['dir', 'name', 'ctx']) if (e[f]) a[f] = e[f];
        if (e.own && (!a.own || e.own > a.own)) a.own = e.own;
        a.guess = (a.guess === undefined ? true : a.guess) && !!e.guess;
      }
    }
    return Object.keys(agg).length ? { via: 'site', host: site, p: agg } : null;
  }
  // ---- 테스트용 tag (per profile, every site)
  function isTest(e) {
    if (!e) return false;
    for (const t of Object.values(M.tags || {})) if (t && t.test && ((t.dir && e.dir && t.dir === e.dir) || (t.name && e.name && t.name === e.name))) return true;
    return false;
  }
  function tag(id, what) {
    const name = baseName(id && id.name), dir = id && typeof id.dir === 'string' && id.dir ? id.dir.slice(0, 60) : (name ? dirForName(name) : null);
    const k = dir ? 'dir:' + dir : name ? 'name:' + name : null;
    if (!k) throw new Error('프로필을 알 수 없어요 (이름 또는 폴더)');
    M.tags = M.tags || {};
    for (const [kk, t] of Object.entries(M.tags)) if ((dir && t.dir === dir) || (name && t.name === name)) delete M.tags[kk];
    if (what === 'test') M.tags[k] = { test: new Date().toISOString(), ...(name ? { name } : {}), ...(dir ? { dir } : {}) };
    flush();
    return { profile: label({ name, dir, test: false }), tag: what === 'test' ? 'test' : null };
  }
  // ---- 여러 계정 (ask mode): exact host first, else any host of the same site that has it
  const normH = host => String(host || '').toLowerCase().trim().replace(/^[a-z]+:\/\//i, '').split('/')[0];
  function askOf(host) {
    const h = normH(host);
    if (M.hosts[h] && M.hosts[h].ask) return { host: h, ...M.hosts[h].ask };
    const site = siteOf(h);
    for (const [hh, v] of Object.entries(M.hosts)) if (v.ask && siteOf(hh) === site) return { host: hh, ...v.ask };
    return null;
  }
  function setAsk(host, cands = []) {
    const hst = normH(host);
    if (!learnableHost(hst)) throw new Error(`기억할 수 없는 호스트예요: ${host || '(없음)'}`);
    const h = M.hosts[hst] = M.hosts[hst] || { p: {} };
    for (const v of Object.values(h.p)) delete v.own;   // the owner's single pick is replaced by "ask every time"
    const cand = [];
    for (const c of cands.slice(0, 6)) {
      const name = baseName(c && c.name), dir = c && c.dir ? String(c.dir).slice(0, 60) : (name ? dirForName(name) : null);
      if ((name || dir) && !cand.some(x => (dir && x.dir === dir) || (name && x.name === name))) cand.push({ ...(name ? { name } : {}), ...(dir ? { dir } : {}) });
    }
    h.ask = { on: new Date().toISOString(), cand, ...(h.ask && h.ask.last ? { last: h.ask.last } : {}) };
    flush();
    return { host: hst, ask: true, candidates: cand.map(c => label(c)) };
  }
  function clearAsk(host) {
    const a = askOf(host);
    if (!a) return { host: normH(host), ask: false, changed: false };
    delete M.hosts[a.host].ask; flush();
    return { host: a.host, ask: false, changed: true };
  }

  function lookup(host) {
    const r = entriesFor(host); const ask = askOf(host);
    if (!r && !ask) return null;
    const list = Object.entries((r && r.p) || {}).map(([key, e]) => ({ key, dir: e.dir || null, name: e.name || null, ctx: e.ctx || null, n: e.n || 0, last: e.last || null, acct: e.acct || null, from: e.from || null,
      ...(e.guess ? { guess: true } : {}), ...(e.own ? { own: e.own } : {}) }))
      .sort((a, b) => String(b.last).localeCompare(String(a.last)) || b.n - a.n);
    for (const e of list) e.test = isTest(e);
    const real = list.filter(e => !e.test);   // 테스트용 profiles never become the default nor make the memory "ambiguous"
    const byN = arr => [...arr].sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)));
    if (ask) {
      // 여러 계정: no default. Candidates = the owner's list (or every remembered profile), last used first, 테스트용 last
      const src = ask.cand && ask.cand.length ? ask.cand : list.map(e => ({ name: e.name, dir: e.dir }));
      const cands = src.map(c => {
        const m = list.find(e => (c.dir && e.dir === c.dir) || (c.name && e.name === c.name));
        return m ? { ...m, name: m.name || c.name || null, dir: m.dir || c.dir || null } : { key: null, dir: c.dir || null, name: c.name || null, ctx: null, n: 0, last: null, acct: null, test: isTest(c) };
      });
      const lastAt = e => { const l = ask.last; const hit = l && ((l.dir && e.dir === l.dir) || (l.name && e.name === l.name)); return [String(e.last || ''), hit ? String(l.at || '') : ''].sort().pop(); };
      cands.sort((a, b) => (a.test ? 1 : 0) - (b.test ? 1 : 0) || lastAt(b).localeCompare(lastAt(a)) || b.n - a.n);
      const lp = ask.last; for (const c of cands) if (lp && ((lp.dir && c.dir === lp.dir) || (lp.name && c.name === lp.name))) c.lastPick = true;
      const best = cands.find(e => !e.test) || null;   // only the recommendation (shown first); never used as a default
      return { host: r ? r.host : ask.host, via: r ? r.via : 'exact', best, others: list.filter(e => !best || !((best.dir && e.dir === best.dir) || (best.name && e.name === best.name))),
        pinned: false, ambiguous: false, why: null, askMode: true, ask: { host: ask.host, since: ask.on || null, last: ask.last || null }, candidates: cands.slice(0, 4) };
    }
    // owner's pick wins outright (the most recent pick if the site view merges several hosts)
    const owned = list.filter(e => e.own).sort((a, b) => String(b.own).localeCompare(String(a.own)))[0];
    // best = the most recent profile among the ones really used here (>= 3 successes and >= 10% of the busiest one):
    // a quick check in the wrong profile (1-2 runs) does not take over from the profile with the real work
    let best = null;
    if (owned) best = owned;
    else if (real.length) { const thr = Math.max(3, Math.ceil(Math.max(...real.map(e => e.n)) * 0.1)); best = real.find(e => e.n >= thr) || real[0]; }
    const others = list.filter(e => e !== best);
    // ambiguity (see header): no owner pick, and the counts do not clearly point at one (real) profile
    let ambiguous = false, why = null;
    if (!owned && best && real.length > 1) {
      const [top, second] = byN(real);
      if (top !== best) { ambiguous = true; why = 'recent-not-most-used'; }
      else if (second && second.n >= 2 && second.n * 2 >= top.n) { ambiguous = true; why = 'close-counts'; }
    }
    // choices for the owner (recommended = best first, then by count, 테스트용 last), at most 4
    const candidates = [...(best ? [best] : []), ...byN(others.filter(e => !e.test)), ...byN(others.filter(e => e.test))].slice(0, 4);
    return { host: r.host, via: r.via, best, others, pinned: !!owned, ambiguous, why, candidates };
  }
  const label = e => (e.name ? `'${e.name}'` : e.dir ? `'${e.dir}'` : '이름 모르는 프로필(이번 크롬 실행 중에만 구분)') + (e.guess ? ' (추정)' : '') + ((e.test === undefined ? isTest(e) : e.test) ? ' (테스트용)' : '');
  const acctText = a => !a ? '' : a.startsWith('channel:') ? ` · 채널 ${a.slice(8, 16)}…` : a.startsWith('authuser:') ? ` · 구글 계정 ${a.slice(9)}번째(authuser=${a.slice(9)})` : '';
  // "애매함: 후보 'A' 5회(11/8, 추천), 'B' 4회(11/7)" (resolve -> " = 지금 B" per candidate when the caller knows the live letters)
  const candText = (l, resolve = null) => l.candidates.map((c, k) => `${label(c)} ${c.n}회(${c.last ? short(c.last) : '-'}${k === 0 ? ', 추천' : ''})${resolve ? (s => s ? ' ' + s : '')(resolve(c)) : ''}`).join(', ');
  // "여러 계정 사용: 매번 주인에게 물어봄 · 후보 '01. 기본' 12회(11/8, 최근), '04. 테스트' (테스트용) 0회"
  const askText = (l, resolve = null) => `여러 계정 사용: 매번 주인에게 물어봄 · 후보 ${l.candidates.map((c, k) => `${label(c)} ${c.n}회${c.last ? `(${short(c.last)}${k === 0 && !c.test ? ', 최근' : ''})` : ''}${c.lastPick ? ' (지난번 선택)' : ''}${resolve ? (s => s ? ' ' + s : '')(resolve(c)) : ''}`).join(', ') || '(없음)'}`;
  const line = (host, l, resolve = null) => {
    if (l.askMode) return `${host} → ${askText(l, resolve)} → 주인 메시지에 프로필/계정이 없으면 물어보고 open <url> --profile "<이름>"`;
    if (!l.best) return `${host} → 기본 없음 (테스트용 프로필만 기록됨: ${l.others.map(o => `${label(o)} ${o.n}회`).join(', ')}) → 계정이 중요하면 주인에게 물어보기`;
    if (l.ambiguous) return `${host} → 애매함: 후보 ${candText(l, resolve)} → 프로필을 골라야 하면 주인에게 물어보고 profiles set ${host} <프로필>`;
    const now = resolve ? resolve(l.best) : '';
    return `${host} → ${label(l.best)} (${l.pinned ? '주인 선택 · ' : ''}최근 ${short(l.best.last)} · ${l.best.n}회${acctText(l.best.acct)})${now ? ' ' + now : ''}${l.others.length ? ' · 다른 프로필: ' + l.others.slice(0, 2).map(o => `${label(o)} ${o.n}회`).join(', ') : ''}`;
  };

  function list({ json = false, host = null } = {}) {
    const hosts = Object.keys(M.hosts).filter(h => !host || h === String(host).toLowerCase() || siteOf(h) === siteOf(host))
      .sort((a, b) => String(lastOf(b)).localeCompare(String(lastOf(a))));
    if (json) return { hosts: hosts.map(h => ({ host: h, ...lookup(h) })) };
    if (!hosts.length) return host ? `기억된 프로필 없음: ${host}` : '기억된 프로필 없음 (성공한 run/fill이 쌓이면 생김)';
    return ['[기억된 프로필 · 성공한 작업 기준 · open <url>은 기본으로 여기로 열림]', ...hosts.map(h => '  ' + line(h, lookup(h))),
      '(기준: 주인 선택(profiles set) > 실제로 많이 쓴 프로필(3회 이상·최다의 10% 이상) 중 가장 최근 · 애매함 = 가장 최근 ≠ 가장 많이 씀, 또는 상위 두 개가 2배 안 → 주인에게 물어보기 · 여러 계정 사용(profiles set <host> --ask) = 기본 없음, 매번 물어봄 · (테스트용) = 추천·기본으로 안 씀 · 잊기: profiles forget <host> · (추정) = 크롬-live가 이름을 소거법으로만 붙인 프로필)'].join('\n');
  }
  // owner's pick (choice card / AskUserQuestion answer, or `profiles set`): id = {dir, name, ctx} of one profile.
  // Stored as `own` on that profile (created with n 0 if it never worked here); every other pick on the host is cleared.
  function pin(host, id) {
    const h0 = bareHost(String(host || '').trim().replace(/^[a-z]+:\/\//i, '').split('/')[0]);
    const hst = String(host || '').toLowerCase().trim().replace(/^[a-z]+:\/\//i, '').split('/')[0];
    if (!learnableHost(h0)) throw new Error(`기억할 수 없는 호스트예요: ${host || '(없음)'}`);
    const name = baseName(id && id.name), dir = id && typeof id.dir === 'string' && id.dir ? id.dir.slice(0, 60) : (name ? dirForName(name) : null);
    const ctx = id && typeof id.ctx === 'string' && /^[0-9A-Fa-f]{8,64}$/.test(id.ctx) ? id.ctx : null;
    if (!dir && !name && !ctx) throw new Error('프로필을 알 수 없어요 (이름·폴더·지금 프로필 문자 중 하나)');
    const am = askOf(hst);
    if (am) {   // 여러 계정: never pinned; kept as "last used" (recommended first next time)
      M.hosts[am.host].ask.last = { ...(name ? { name } : {}), ...(dir ? { dir } : {}), at: new Date().toISOString() };
      flush();
      return { host: am.host, profile: label({ name, dir }), key: null, askMode: true, name, dir };
    }
    const h = M.hosts[hst] = M.hosts[hst] || { p: {} };
    let key = Object.keys(h.p).find(k => (dir && h.p[k].dir === dir) || (name && h.p[k].name === name && !(dir && h.p[k].dir && h.p[k].dir !== dir)) || (ctx && h.p[k].ctx === ctx));
    if (!key) { key = keyOf({ dir, name, ctx }); h.p[key] = { n: 0, last: null }; }
    const e = h.p[key];
    if (dir) e.dir = dir; if (name) e.name = name; if (ctx) e.ctx = ctx;
    for (const v of Object.values(h.p)) delete v.own;
    e.own = new Date().toISOString();
    // the same owner choice for the other hosts of this site view is implied by lookup (pinned entries win there too)
    const ks = Object.keys(h.p); if (ks.length > MAX_PROFILES) { const victim = ks.filter(k => k !== key).sort((a, b) => String(h.p[a].last).localeCompare(String(h.p[b].last)))[0]; delete h.p[victim]; }
    flush();
    return { host: hst, profile: label({ ...e, guess: false }), key };
  }
  function forget({ host, all = false } = {}) {
    if (all) { const n = Object.keys(M.hosts).length; M.hosts = {}; flush(); return { forgot: n, all: true }; }
    const h = String(host || '').toLowerCase().trim();
    if (!h) throw new Error('usage: profiles forget <host> | --all');
    const hit = Object.keys(M.hosts).filter(x => x === h || bareHost(x) === h);
    for (const x of hit) delete M.hosts[x];
    flush();
    return { forgot: hit.length, hosts: hit };
  }
  // tabs text / prompt lines: most recent N sites (optionally a resolver -> " = 지금 프로필 B")
  function recentLines(n = 8, resolve = null, prefer = null) {   // prefer: Set of sites open right now (listed first)
    const pre = h => prefer && prefer.has(siteOf(h)) ? 1 : 0;
    const hosts = Object.keys(M.hosts).sort((a, b) => pre(b) - pre(a) || String(lastOf(b)).localeCompare(String(lastOf(a)))).slice(0, n);
    return hosts.map(h => line(h, lookup(h), resolve));
  }
  return { learn, lookup, list, forget, pin, recentLines, label, acctText, candText, askText, flush, siteOf, learnableHost, baseName, dirForName, localProfiles, seed,
    setAsk, clearAsk, askOf, tag, isTest, _state: () => M };
};
module.exports.siteOf = siteOf;
module.exports.learnableHost = learnableHost;
module.exports.baseName = baseName;
