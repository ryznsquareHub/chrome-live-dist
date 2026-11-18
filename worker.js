// chrome-live worker: the ONLY process that holds a CDP connection to the owner's Chrome.
// Spawned by server.js; killed by server.js on pause / idle / Chrome restart. Killing the process
// drops the websocket at the OS level, so we never need browser.close() (which could touch pages).
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { AsyncLocalStorage } = require('async_hooks');
const { ws: WebSocket } = require('playwright-core/lib/utilsBundle');

const endpoint = process.argv[2];
// attachMode 'on-demand' (default): CDP sessions exist ONLY on tabs a command operates on, detached after
// tabIdleDetachSec idle. 'all': old behaviour (browser-level auto-attach to every tab). Changeable live via IPC.
const SET = { attachMode: 'on-demand', tabIdleDetachSec: 60 };
try { Object.assign(SET, JSON.parse(process.argv[3] || '{}')); } catch {}
const CONNECT_TIMEOUT = 180000;   // waits for the owner to click "allow"
const DEFAULT_TIMEOUT = 15000;
const send = m => { try { process.send(m); } catch {} };
const log = msg => send({ type: 'log', msg });

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms); })])
    .finally(() => clearTimeout(t));
}
const shortId = id => id.slice(0, 6).toLowerCase();
function hostOf(url) {
  try { const u = new URL(url); return u.protocol === 'chrome-extension:' ? 'ext:' + u.host.slice(0, 8) : (u.host || u.protocol.replace(':', '')); }
  catch { return ''; }
}

// tabs chrome-live opened (full targetIds). v11: every change is reported to server.js, which hands the set to the
// next worker, so own tabs stay 'own' across done / reconnect / idle disconnect (same Chrome session).
class OwnedSet extends Set {
  add(v) { if (!this.has(v)) send({ type: 'owned', targetId: v, on: true }); return super.add(v); }
  delete(v) { if (this.has(v)) send({ type: 'owned', targetId: v, on: false }); return super.delete(v); }
}
const S = { browser: null, bcdp: null, pages: new Map(), owned: new OwnedSet(Array.isArray(SET.owned) ? SET.owned.filter(x => typeof x === 'string') : []), lastHost: new Map(), waiters: new Map(), letters: new Map(),
  idMap: new Map(), ctxOf: new Map(), profName: new Map(), lastTitle: new Map(),   // for the side-panel event log (id -> targetId -> profile)
  profDir: new Map(),   // letter -> profile folder ("Profile 14"), only when certain (프로필 기억)
  ctxDir: new Map(),    // browserContextId -> profile folder, from the Windows window app ids (winScan)
  attaching: new Map() };
const CMD = new AsyncLocalStorage();   // per command: Set of targetIds it used (kept attached until it ends)

// ---------- gate: our ONE websocket to Chrome; Playwright talks through it ----------
// Playwright's connectOverCDP sends a browser-level Target.setAutoAttach, which attaches to EVERY tab and enables
// Page/Runtime/Network/... in all of them. In on-demand mode the gate answers that call itself (Chrome never sees
// it) and hands Playwright a tab only when we attach to it explicitly (root Target.attachToTarget -> Chrome emits
// Target.attachedToTarget -> Playwright builds the Page). Detach = Target.detachFromTarget -> Playwright sees the
// page "close" (the tab stays open). Still one websocket = one allow prompt. Message content is never logged.
const MY_ID0 = 1e9;   // ids of our own root calls (Playwright counts up from 1)
const G = { sock: null, nextId: MY_ID0, pending: new Map(), pwCreate: new Set(), roots: new Map(), autoAttach: null };
function rawSend(method, params = {}) {
  const id = G.nextId++;
  return new Promise((resolve, reject) => {
    G.pending.set(id, { resolve, reject, method });
    try { G.sock.send(JSON.stringify({ id, method, params })); } catch (e) { G.pending.delete(id); reject(e); }
  });
}
function openGate(url, timeout) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, [], { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: timeout, followRedirects: true });
    G.sock = sock;
    const t = { onmessage: undefined, onclose: undefined,
      send(msg) {
        if (!msg.sessionId && msg.method === 'Target.setAutoAttach') {
          G.autoAttach = msg.params;   // kept for attachMode 'all'
          if (SET.attachMode === 'all') { sock.send(JSON.stringify(msg)); return; }
          setImmediate(() => t.onmessage && t.onmessage({ id: msg.id, result: {} }));
          return;
        }
        if (!msg.sessionId && msg.method === 'Target.createTarget') G.pwCreate.add(msg.id);   // context.newPage() in a run script
        sock.send(JSON.stringify(msg));
      },
      close() { try { sock.close(); } catch {} } };
    sock.on('message', data => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id >= MY_ID0) {
        const p = G.pending.get(m.id); if (!p) return; G.pending.delete(m.id);
        return m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      }
      // root sessions on tabs/workers (never the browser target: that is our own browser-level session)
      if (!m.sessionId && m.method === 'Target.attachedToTarget' && m.params.targetInfo.type !== 'browser') G.roots.set(m.params.sessionId, m.params.targetInfo.targetId);
      if (!m.sessionId && m.method === 'Target.detachedFromTarget') G.roots.delete(m.params.sessionId);
      if (m.id && G.pwCreate.delete(m.id) && m.result && m.result.targetId && SET.attachMode !== 'all') {
        // Playwright expects the new page to be attached BEFORE createTarget answers (auto-attach does that):
        // attach first (its attachedToTarget event reaches Playwright), then hand over the held answer.
        const tid = m.result.targetId;
        S.owned.add(tid);
        const wait = waitTracked(tid, 8000);
        rawSend('Target.attachToTarget', { targetId: tid, flatten: true })
          .then(r => { wait.then(e => { if (e) { e.pwSessionId = r.sessionId; scheduleDetach(tid, e); } }); },
            e => log(`attach new page failed: ${e.message}`))
          .finally(() => { if (t.onmessage) t.onmessage(m); });
        return;
      }
      if (t.onmessage) t.onmessage(m);
    });
    sock.on('close', () => { for (const p of G.pending.values()) p.reject(new Error('connection closed')); G.pending.clear(); if (t.onclose) t.onclose(); });
    sock.on('open', () => resolve(t));
    sock.on('error', e => reject(e));
  });
}

// ---------- on-demand attach / idle detach ----------
async function attach(targetId) {
  const have = S.pages.get(targetId);
  if (have) return have;
  if (S.attaching.has(targetId)) return S.attaching.get(targetId);
  const p = (async () => {
    const wait = waitTracked(targetId, 8000);
    let sessionId = null;
    if (SET.attachMode !== 'all') ({ sessionId } = await withTimeout(rawSend('Target.attachToTarget', { targetId, flatten: true }), 5000, 'attach'));
    const entry = await wait;
    if (!entry) {
      if (sessionId) rawSend('Target.detachFromTarget', { sessionId }).catch(() => {});
      throw new Error(`tab ${shortId(targetId)} did not attach in 8 s (asleep/discarded? ask the owner to click it once)`);
    }
    if (sessionId) entry.pwSessionId = sessionId;
    // our own tab only: emulate focus so a BACKGROUND tab still runs requestAnimationFrame. Without it
    // Playwright clicks and screenshots hang in background tabs (measured: click 100% timeout, shot ~50%).
    // Never applied to owner tabs (it would change document.hasFocus() for their pages).
    if (S.owned.has(targetId) && !entry.focusEmulated) {
      try { await withTimeout(entry.session.send('Emulation.setFocusEmulationEnabled', { enabled: true }), 2000, 'focus emulation'); entry.focusEmulated = true; }
      catch (e) { log(`focus emulation failed: ${e.message}`); }
    }
    return entry;
  })().finally(() => S.attaching.delete(targetId));
  S.attaching.set(targetId, p);
  return p;
}
function use(targetId, entry) {   // keep attached while the current command runs
  const used = CMD.getStore();
  if (used && !used.has(targetId)) { used.add(targetId); entry.busy = (entry.busy || 0) + 1; }
  clearTimeout(entry.idleT);
}
function release(targetIds) {
  for (const tid of targetIds) {
    const e = S.pages.get(tid); if (!e) continue;
    e.busy = Math.max(0, (e.busy || 1) - 1);
    scheduleDetach(tid, e);
  }
}
function scheduleDetach(tid, e) {
  clearTimeout(e.idleT);
  if (SET.attachMode === 'all' || e.busy) return;
  e.idleT = setTimeout(() => detach(tid, 'idle').catch(() => {}), Math.max(1, Number(SET.tabIdleDetachSec) || 60) * 1000);
}
async function detach(tid, why) {
  const e = S.pages.get(tid);
  if (!e || e.busy) return false;
  clearTimeout(e.idleT);
  e.detaching = true; S.pages.delete(tid);
  try { await withTimeout(e.session.detach(), 2000, 'detach cdp'); } catch {}
  const root = [...G.roots].find(([, t]) => t === tid);
  const sid = e.pwSessionId || (root && root[0]);
  if (sid) await withTimeout(rawSend('Target.detachFromTarget', { sessionId: sid }), 2000, 'detach').catch(() => {});
  log(`detached ${shortId(tid)} (${why})`);
  return true;
}
// switch attachMode live (same websocket -> no allow prompt)
async function setMode(mode) {
  if (mode === SET.attachMode) return;
  SET.attachMode = mode;
  if (mode === 'all') {
    // drop our explicit sessions first: auto-attach would re-attach those tabs (Playwright refuses duplicates)
    for (const [tid, e] of [...S.pages]) { e.busy = 0; await detach(tid, 'attachMode all'); }
    await rawSend('Target.setAutoAttach', G.autoAttach || { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } else {
    // detach our entries first (marked as detach, so owned tabs stay owned), then stop auto-attach
    for (const [tid, e] of [...S.pages]) { e.busy = 0; await detach(tid, 'attachMode on-demand'); }
    await rawSend('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    for (const [sid] of [...G.roots]) await rawSend('Target.detachFromTarget', { sessionId: sid }).catch(() => {});   // service workers etc.
  }
  log(`attachMode -> ${mode}`);
}

// ---------- profiles ----------
// Each Chrome profile = one CDP browser context (targetInfo.browserContextId). CDP does not say which profile
// directory a context is. Read-only signal used: the chrome-extension:// ids of targets RUNNING in a context
// must all be installed in that profile's "Extensions" folder (folder NAMES only). Candidates = Local State
// profile.last_active_profiles (the profiles open now). Never reads cookies, history, or page contents.
const USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
// tests may point at a fake Local State (only when that file exists); the owner's daemon never sets it
const LOCAL_STATE = () => { const f = process.env.CHROME_LIVE_LOCAL_STATE; return f && fs.existsSync(f) ? f : path.join(USER_DATA, 'Local State'); };
let profCache = { at: 0, data: null };
function profileInfo(force = false) {
  let mt = 0; try { mt = fs.statSync(LOCAL_STATE()).mtimeMs; } catch {}
  if (!force && profCache.data && profCache.mt === mt && Date.now() - profCache.at < 60000) return profCache.data;
  let info = {}, open = [];
  try {
    const p = JSON.parse(fs.readFileSync(LOCAL_STATE(), 'utf8')).profile || {};
    for (const [dir, v] of Object.entries(p.info_cache || {})) info[dir] = { dir, name: v.name || dir, gaia: v.gaia_name || '' };
    open = (p.last_active_profiles || []).filter(d => info[d]);
  } catch (e) { log(`Local State unreadable: ${e.message}`); }
  for (const d of Object.keys(info)) {
    try { info[d].ext = new Set(fs.readdirSync(path.join(USER_DATA, d, 'Extensions'))); } catch { info[d].ext = new Set(); }
  }
  profCache = { at: Date.now(), mt, data: { info, open: open.length ? open : Object.keys(info), lastActive: open } };
  return profCache.data;
}
const profName = v => v.gaia && v.gaia !== v.name ? `${v.name} (${v.gaia})` : v.name;

// ctxIds: contexts that own tabs; targetInfos: all targets (for extension ids). Returns Map ctx -> {dir?, candidates[]}
function mapProfiles(ctxIds, targetInfos) {
  const { info, open } = profileInfo();
  const ext = new Map(ctxIds.map(c => [c, new Set()]));
  for (const ti of targetInfos) {
    const m = ti.url.match(/^chrome-extension:\/\/([a-p]{32})/);
    if (m && ti.browserContextId) { if (!ext.has(ti.browserContextId)) ext.set(ti.browserContextId, new Set()); ext.get(ti.browserContextId).add(m[1]); }
  }
  const res = new Map();
  // unpacked extensions (e.g. the chrome-live side panel) live outside every profile's Extensions folder: no signal
  const known = id => Object.values(info).some(v => v.ext.has(id));
  const taken = new Set();
  for (const c of ctxIds) {
    const ids = [...ext.get(c)].filter(known);
    const win = S.ctxDir.get(c);   // Windows told us this context's folder (winScan): certain
    if (win && info[win]) { res.set(c, { cand: [win], hasSignal: true, dir: win }); taken.add(win); continue; }
    res.set(c, { cand: open.filter(d => ids.every(id => info[d].ext.has(id))), hasSignal: ids.length > 0 });
  }
  // contexts WITH running extensions can only be profiles that have them; repeat: unique candidate -> assigned
  for (let changed = true; changed;) {
    changed = false;
    for (const [c, r] of res) {
      if (r.dir) continue;
      r.cand = r.cand.filter(d => !taken.has(d));
      if (r.cand.length === 1) { r.dir = r.cand[0]; r.guess = !r.hasSignal; taken.add(r.dir); changed = true; }
    }
  }
  // no-signal contexts: if as many such contexts as remaining open profiles, they're among those, but which is which is unknown
  const out = new Map();
  for (const [c, r] of res) out.set(c, { dir: r.dir || null, name: r.dir ? profName(info[r.dir]) : null, guess: !!r.guess,
    candidates: r.dir ? [] : r.cand.map(d => profName(info[d])) });
  return out;
}

// 프로필 기억: contexts the extension signal cannot tell apart ("X 또는 Y 중 하나"). Windows gives every Chrome window an
// app id "Chrome.UserData.<profile folder without spaces>" (taskbar grouping). Read-only: top-level window class/title/app
// id via user32/shell32 (titles = the active tab's title, which `tabs` lists anyway). A window is matched to a CDP window by
// its active tab title; a context gets a folder only when all its matched windows agree and no other context claims it.
// Runs in the background (powershell ~1-2 s), at most every 45 s, only while some context is unresolved.
const WINSCAN_PS = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
[StructLayout(LayoutKind.Sequential)] public struct CLPK { public Guid f; public uint p; }
[StructLayout(LayoutKind.Sequential)] public class CLPV { public ushort vt; public ushort a,b,c; public IntPtr p; public IntPtr q; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface CLPS { int GetCount(out uint c); int GetAt(uint i, out CLPK k); int GetValue(ref CLPK k, [Out] CLPV v); int SetValue(ref CLPK k, CLPV v); int Commit(); }
public class CLWin {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [Out, MarshalAs(UnmanagedType.Interface)] out CLPS ps);
  public static List<string[]> All() {
    var r = new List<string[]>();
    EnumWindows((h, l) => {
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "Chrome_WidgetWin_1" || !IsWindowVisible(h)) return true;
      Guid g = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); CLPS ps;
      if (SHGetPropertyStoreForWindow(h, ref g, out ps) != 0) return true;
      var k = new CLPK { f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p = 5 }; var v = new CLPV();
      if (ps.GetValue(ref k, v) != 0 || v.vt != 31) return true;
      var t = new StringBuilder(1024); GetWindowText(h, t, 1024);
      r.Add(new string[] { Marshal.PtrToStringUni(v.p), t.ToString() });
      return true; }, IntPtr.Zero);
    return r; } }
'@
foreach ($w in [CLWin]::All()) { [Console]::WriteLine((ConvertTo-Json -Compress @($w[0], $w[1]))) }`;
const WIN = { at: 0, running: null };
function winScan(force = false) {
  if (process.platform !== 'win32' || process.env.CHROME_LIVE_WIN_PROFILES === '0') return Promise.resolve();
  if (WIN.running) return WIN.running;
  if (!force && Date.now() - WIN.at < 45000) return Promise.resolve();
  const { info } = profileInfo();
  const want = new Map(Object.keys(info).map(d => ['chrome.userdata.' + d.replace(/\s+/g, '').toLowerCase(), d]));
  if (!want.size || !S.bcdp) return Promise.resolve();
  WIN.at = Date.now();
  WIN.running = (async () => {
    // CDP side: each window's active tab title + context (browser-level reads only, no session on any tab)
    const { targetInfos: tabT } = await withTimeout(S.bcdp.send('Target.getTargets', { filter: [{ type: 'tab' }] }), 3000, 'tab targets');
    const act = [];
    for (const t of tabT.filter(t => t.type === 'tab' && t.embedderData && t.embedderData.tabActive && t.browserContextId)) {
      try { const w = await withTimeout(S.bcdp.send('Browser.getWindowForTarget', { targetId: t.targetId }), 1000, 'window'); act.push({ win: w.windowId, ctx: t.browserContextId, title: String(t.title || '') }); } catch {}
    }
    if (!act.length) return;
    const out = await new Promise(resolve => {
      const { execFile } = require('child_process');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINSCAN_PS, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
    });
    const votes = new Map();   // ctx -> Set(dir)
    for (const l of out.split(/\r?\n/)) {
      let a; try { a = JSON.parse(l); } catch { continue; }
      const dir = Array.isArray(a) && want.get(String(a[0]).toLowerCase()); if (!dir) continue;
      const title = String(a[1] || '');
      const hits = act.filter(x => x.title && (title === x.title || title.startsWith(x.title + ' - ')));
      const ctxs = new Set(hits.map(x => x.ctx));
      if (ctxs.size !== 1) continue;   // no match, or two contexts show the same title
      const c = [...ctxs][0]; if (!votes.has(c)) votes.set(c, new Set()); votes.get(c).add(dir);
    }
    const claim = new Map();
    for (const [c, ds] of votes) if (ds.size === 1) { const d = [...ds][0]; claim.set(d, claim.has(d) ? null : c); }
    for (const [d, c] of claim) if (c && !S.ctxDir.has(c)) { S.ctxDir.set(c, d); log(`profile folder from window app id: ${S.letters.get(c) || '?'} = ${d}`); }
  })().catch(e => log(`winScan: ${e.message}`)).finally(() => { WIN.running = null; });
  return WIN.running;
}

// resolves as soon as trackPage() registers the target (no polling)
function waitTracked(targetId, ms) {
  if (S.pages.has(targetId)) return Promise.resolve(S.pages.get(targetId));
  return new Promise(resolve => {
    const t = setTimeout(() => { S.waiters.delete(targetId); resolve(null); }, ms);
    S.waiters.set(targetId, e => { clearTimeout(t); S.waiters.delete(targetId); resolve(e); });
  });
}

async function trackPage(page) {
  try {
    const session = await withTimeout(page.context().newCDPSession(page), 3000, 'attach');
    const { targetInfo } = await withTimeout(session.send('Target.getTargetInfo'), 3000, 'targetInfo');
    const entry = { page, session };
    S.pages.set(targetInfo.targetId, entry);
    const w = S.waiters.get(targetInfo.targetId); if (w) w(entry);
    page.once('close', () => {   // a detach also looks like 'close' to Playwright, but the tab still exists
      clearTimeout(entry.idleT);
      if (!entry.detaching) session.detach().catch(() => {});   // our helper session must not outlive the page
      if (S.pages.get(targetInfo.targetId) === entry) S.pages.delete(targetInfo.targetId);
      if (!entry.detaching) S.owned.delete(targetInfo.targetId);
    });
    if (!w) scheduleDetach(targetInfo.targetId, entry);   // e.g. a popup our run script opened
    return targetInfo.targetId;
  } catch (e) { if (!/has been closed/.test(e.message)) log(`trackPage failed: ${e.message}`); return null; }   // closed right away: normal
}

// OUR OWN tabs only: Chrome renders background tabs at ~1 frame/s, so Playwright clicks (rAF stability
// checks) take ~1 s and screenshots 0.2-15 s. A tiny screencast (64px, q10) makes Chrome produce frames
// at full rate while a command runs (measured: rAF 1/s -> ~50/s, shot ~120 ms, click ~110 ms).
// Started per command, stopped right after; never on owner tabs (unchanged: they still need --front).
async function wake(r) {
  const e = S.pages.get(r.ti.targetId);
  if (!e || !S.owned.has(r.ti.targetId)) return () => {};
  e.wake = (e.wake || 0) + 1;
  if (e.wake === 1) {
    if (!e.ackBound) { e.ackBound = true; e.session.on('Page.screencastFrame', f => { e.session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); }); }
    try { await withTimeout(e.session.send('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 64, maxHeight: 64 }), 2000, 'startScreencast'); }
    catch (err) { log(`wake failed: ${err.message}`); }
  }
  return () => { if (--e.wake === 0) e.session.send('Page.stopScreencast').catch(() => {}); };
}

async function pageFlags(entry) {
  if (!entry) return { probe: 'untracked' };
  try {
    const r = await withTimeout(entry.session.send('Runtime.evaluate', {
      expression: `({d: !!document.wasDiscarded, v: document.visibilityState, a: [...document.querySelectorAll('video,audio')].some(m => !m.paused && !m.muted && m.currentTime > 0)})`,
      returnByValue: true,
    }), 800, 'probe');
    const v = (r.result && r.result.value) || {};
    // own tabs run with focus emulation, which makes visibilityState read 'visible' even in the background
    const own = entry.focusEmulated;
    return { visible: own ? false : v.v === 'visible', audio: !!v.a, wasDiscarded: !!v.d, probe: 'ok', pwOk: !!entry.page.url() };
  } catch { return { probe: 'frozen', pwOk: !!entry.page.url() }; }
}

async function listTabs() {
  const t0 = Date.now();
  const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
  const tabs = [], hidden = [], others = {};
  await Promise.all(targetInfos.map(async ti => {
    if (ti.type !== 'page' || ti.subtype || ti.url.startsWith('devtools://')) {
      const k = ti.subtype ? `page/${ti.subtype}` : ti.url.startsWith('devtools://') ? 'devtools' : ti.type;
      others[k] = (others[k] || 0) + 1; return;
    }
    let win = null;
    try {
      const w = await withTimeout(S.bcdp.send('Browser.getWindowForTarget', { targetId: ti.targetId }), 1000, 'window');
      win = { id: w.windowId, state: w.bounds && w.bounds.windowState };
    } catch {}
    const flags = await pageFlags(S.pages.get(ti.targetId));
    const t = { id: shortId(ti.targetId), targetId: ti.targetId, title: ti.title, url: ti.url, host: hostOf(ti.url), ctx: ti.browserContextId,
      windowId: win && win.id, windowState: win && win.state, ...flags, owned: S.owned.has(ti.targetId), tracked: S.pages.has(ti.targetId) };
    S.lastHost.set(ti.targetId, t.host); if (ti.title) S.lastTitle.set(ti.targetId, ti.title);
    (win ? tabs : hidden).push(t);
  }));
  const order = new Map(targetInfos.map((ti, i) => [ti.targetId, i]));
  const winIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  const windows = winIds.map((wid, i) => {
    const wt = tabs.filter(t => t.windowId === wid).sort((a, b) => order.get(a.targetId) - order.get(b.targetId));
    wt.forEach((t, j) => { t.win = i + 1; t.n = j + 1; });
    return { n: i + 1, windowId: wid, state: wt[0] && wt[0].windowState, tabs: wt };
  });
  const all = [...tabs, ...hidden];
  for (const t of all) if (all.filter(o => o.id === t.id).length > 1) t.id = t.targetId.slice(0, 10).toLowerCase();
  const profiles = await profilesOf(windows, targetInfos);
  // profiles Chrome knows that have no window now (not in last_active_profiles, no certain open context): open --profile launches them
  let closedProfiles = [];
  try {
    const { info, lastActive } = profileInfo();
    const openDirs = new Set(profiles.filter(p => p.dir && !p.guess).map(p => p.dir));
    if (lastActive && lastActive.length) closedProfiles = Object.values(info).filter(v => !openDirs.has(v.dir) && !(lastActive || []).includes(v.dir)).map(v => ({ dir: v.dir, name: v.name }));
  } catch {}
  return { ms: Date.now() - t0, profiles, windows, hidden, others, closedProfiles };
}

// profile letters stay stable for the life of this connection (A = first seen)
async function profilesOf(windows, targetInfos) {
  let def = null;
  try { def = (await withTimeout(S.bcdp.send('Target.getBrowserContexts'), 1000, 'contexts')).defaultBrowserContextId; } catch {}
  const ctxIds = [...new Set(windows.flatMap(w => w.tabs.map(t => t.ctx)).filter(Boolean))];
  let map = new Map();
  try { map = mapProfiles(ctxIds, targetInfos); } catch (e) { log(`profile mapping failed: ${e.message}`); }
  for (const c of ctxIds) if (!S.letters.has(c)) S.letters.set(c, String.fromCharCode(65 + S.letters.size));
  for (const w of windows) { w.ctx = w.tabs[0] && w.tabs[0].ctx; w.profile = S.letters.get(w.ctx); for (const t of w.tabs) { t.profile = S.letters.get(t.ctx); S.ctxOf.set(t.targetId, t.ctx); } }
  for (const c of ctxIds) { const m = map.get(c); if (m && m.name) S.profName.set(S.letters.get(c), m.name + (m.guess ? ' (추정)' : '')); if (m && m.dir && !m.guess) S.profDir.set(S.letters.get(c), m.dir); }
  if (ctxIds.some(c => { const m = map.get(c); return !m || !m.dir || m.guess; })) winScan();   // background; the next listing uses it
  return ctxIds.map(c => {
    const ws = windows.filter(w => w.ctx === c);
    const hosts = {}; for (const w of ws) for (const t of w.tabs) hosts[t.host] = (hosts[t.host] || 0) + 1;
    const m = map.get(c) || {};
    return { letter: S.letters.get(c), ctx: c, isDefault: c === def, dir: m.dir || null, name: m.name || null, guess: !!m.guess,
      candidates: m.candidates || [], windows: ws.map(w => w.n), topHosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]) };
  }).sort((a, b) => a.letter.localeCompare(b.letter));
}

// browser-level lookup only (no session on the tab)
async function findTarget(id) {
  if (!id || !/^[0-9a-f]{4,32}$/i.test(id)) throw new Error(`bad tab id "${id}" (use the id from \`tabs\`)`);
  const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
  const matches = targetInfos.filter(t => t.type === 'page' && t.targetId.toLowerCase().startsWith(id.toLowerCase()));
  if (!matches.length) throw new Error(`tab ${id} is gone (closed, or Chrome/connection restarted). Run \`tabs\` again.`);
  if (matches.length > 1) throw new Error(`tab id ${id} is ambiguous, use a longer id`);
  S.idMap.set(id.toLowerCase(), matches[0].targetId); S.ctxOf.set(matches[0].targetId, matches[0].browserContextId);
  return matches[0];
}
async function resolveTab(id) {
  if (!id || !/^[0-9a-f]{4,32}$/i.test(id)) throw new Error(`bad tab id "${id}" (use the id from \`tabs\`)`);
  const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
  const matches = targetInfos.filter(t => t.type === 'page' && t.targetId.toLowerCase().startsWith(id.toLowerCase()));
  if (!matches.length) throw new Error(`tab ${id} is gone (closed, or Chrome/connection restarted). Run \`tabs\` again.`);
  if (matches.length > 1) throw new Error(`tab id ${id} is ambiguous, use a longer id`);
  const ti = matches[0];
  S.idMap.set(id.toLowerCase(), ti.targetId); S.ctxOf.set(ti.targetId, ti.browserContextId);
  if (!S.lastHost.has(ti.targetId)) S.lastHost.set(ti.targetId, hostOf(ti.url));
  if (ti.title) S.lastTitle.set(ti.targetId, ti.title);
  const entry = await attach(ti.targetId);   // the ONLY way a tab gets a session: a command operates on it
  use(ti.targetId, entry);
  return { ti, ...entry };
}

// before every action: tab still there, Playwright state healthy, host unchanged, no media unless chosen
async function guard(id, opts = {}) {
  const r = await resolveTab(id);
  if (!r.page.url() && r.ti.url && r.ti.url !== 'about:blank')
    throw new Error(`tab ${id} is stale for Playwright (it was asleep/discarded when we attached; page.title()/evaluate would hang). Ask the owner, then run \`cli.js reconnect\``);
  const host = hostOf(r.ti.url);
  const prev = S.lastHost.get(r.ti.targetId);
  if (opts.expectHost) {
    const want = String(opts.expectHost).toLowerCase();
    if (!(host === want || host.endsWith('.' + want))) throw new Error(`refused: tab ${id} is on ${host}, expected ${want}`);
  } else if (prev && prev !== host && !opts.allowHostChange) {
    throw new Error(`refused: tab ${id} moved from ${prev} to ${host} since last check. Re-run \`tabs\`, or pass --expect-host ${host} if intended`);
  }
  if (!opts.allowMedia && (await pageFlags(r)).audio)
    throw new Error(`refused: tab ${id} is playing media. Pass --allow-media only if the owner chose this tab`);
  if (opts.front) await withTimeout(S.bcdp.send('Target.activateTarget', { targetId: r.ti.targetId }), 5000, 'bringToFront');
  return r;
}

// ---------- 닫힌 프로필 열기 (owner request 2026-11-09 "닫혀있는 프로필도 열게해줘") ----------
// CDP cannot create a tab in a Chrome profile that is not the CDP default (or has no window at all). Chrome itself can:
// `chrome.exe --profile-directory="<folder>" <url>` sent to the RUNNING Chrome (same default user-data-dir, so Chrome's
// process singleton hands the command line to the running browser and the launcher exits at once). Measured (Chromium
// 1248, headed): a profile with no window -> a NEW WINDOW of that profile; a profile that has windows -> a new TAB in its
// last active window. Chrome brings that window to the front (--background cannot be honoured).
// Safety: only folders listed in Local State profile.info_cache (never creates a profile), no --user-data-dir, no other
// flags, never closes anything. The URL we pass is our own data: page with a nonce (exact identification of the new
// tab); the real URL is then loaded with the normal Playwright goto. The owner's tabs are never touched.
let chromeExe = null;
function findChromeExe() {
  if (chromeExe) return Promise.resolve(chromeExe);
  const env = process.env.CHROME_LIVE_CHROME_EXE;   // tests (a fake launcher .js) / unusual installs
  if (env) return Promise.resolve(fs.existsSync(env) ? (chromeExe = env) : null);
  if (process.platform !== 'win32') return Promise.resolve(null);
  // the real chrome.exe always talks to the REAL default user-data-dir: only when that is the one we are attached to
  // (a test daemon with a fake %LOCALAPPDATA% must never reach the owner's Chrome)
  const realLad = path.join(require('os').homedir(), 'AppData', 'Local');
  if (path.resolve(process.env.LOCALAPPDATA || '').toLowerCase() !== path.resolve(realLad).toLowerCase()) return Promise.resolve(null);
  const { execFile } = require('child_process');
  const run = (file, args, ms) => new Promise(res => execFile(file, args, { windowsHide: true, timeout: ms, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, out) => res(err ? '' : String(out || ''))));
  const ok = p => p && /\\chrome\.exe$/i.test(p) && fs.existsSync(p);
  return (async () => {
    // 1) the running Chrome (stable channel: ...\Google\Chrome\Application\chrome.exe; Beta/Canary use other user-data-dirs)
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique"], 8000);
    let p = out.split(/\r?\n/).map(s => s.trim()).find(s => ok(s) && /\\Google\\Chrome\\Application\\chrome\.exe$/i.test(s));
    // 2) registry App Paths, 3) standard install folders
    for (const hive of ['HKCU', 'HKLM']) {
      if (p) break;
      const m = (await run('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], 4000)).match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && ok(m[1].replace(/^"|"$/g, ''))) p = m[1].replace(/^"|"$/g, '');
    }
    if (!p) p = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map(b => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(ok) || null;
    if (p) chromeExe = p;
    return p;
  })();
}
// profile query (letter handled elsewhere) -> Local State folder: exact folder, exact name, then a unique partial name
function localProfileDir(q) {
  const { info } = profileInfo(true);
  const s = String(q || '').trim().toLowerCase().replace(/^프로필\s*/, '');
  if (!s) return null;
  const all = Object.values(info);
  const hit = all.filter(v => v.dir.toLowerCase() === s);
  if (hit.length === 1) return hit[0];
  const byName = all.filter(v => String(v.name).toLowerCase() === s || baseName(profName(v)).toLowerCase() === s);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const part = all.filter(v => String(v.name).toLowerCase().includes(s));
  return part.length === 1 ? part[0] : null;
}
async function launchProfile(dir, { timeoutMs = 15000 } = {}) {
  const { info } = profileInfo(true);
  if (!dir || !info[dir] || !/^[\w .()-]{1,60}$/.test(dir)) throw new Error(`profile folder "${dir}" is not in Chrome's Local State`);
  const exe = await findChromeExe();
  if (!exe) throw new Error('chrome.exe not found (running process / registry / standard folders)');
  const nonce = 'chrome-live-' + require('crypto').randomBytes(6).toString('hex');
  const marker = `data:text/html,<title>chrome-live</title>${nonce}`;
  const { targetInfos: before } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
  const winsBefore = new Set();
  for (const t of before.filter(t => t.type === 'page' && !t.subtype)) { try { winsBefore.add((await withTimeout(S.bcdp.send('Browser.getWindowForTarget', { targetId: t.targetId }), 1000, 'window')).windowId); } catch {} }
  const ctxBefore = new Set(before.map(t => t.browserContextId).filter(Boolean));
  const args = [`--profile-directory=${dir}`, marker];
  const isJs = /\.js$/i.test(exe);
  const t0 = Date.now();
  let early = null;
  const child = require('child_process').spawn(isJs ? process.execPath : exe, isJs ? [exe, ...args] : args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', e => { early = e.message; });
  child.on('exit', code => { if (code !== 0 && code !== 21) early = `launcher exit code ${code}`; });   // 21 = handed to the running Chrome
  child.unref();
  log(`launch profile ${dir}`);
  while (Date.now() - t0 < timeoutMs) {
    const { targetInfos } = await S.bcdp.send('Target.getTargets');
    const t = targetInfos.find(x => x.type === 'page' && x.url.endsWith(nonce));
    if (t) {
      let win = null; try { win = (await withTimeout(S.bcdp.send('Browser.getWindowForTarget', { targetId: t.targetId }), 1000, 'window')).windowId; } catch {}
      if (t.browserContextId) S.ctxDir.set(t.browserContextId, dir);   // Chrome opened it in exactly this folder: certain
      return { targetId: t.targetId, ctx: t.browserContextId, dir, name: info[dir].name, window: win != null && !winsBefore.has(win) ? 'new' : 'existing',
        newProfile: !!(t.browserContextId && !ctxBefore.has(t.browserContextId)), ms: Date.now() - t0 };
    }
    if (early) throw new Error(`launching the profile failed (${early})`);
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`no new tab of profile ${dir} appeared in ${Math.round(timeoutMs / 1000)} s`);
}

// ---------- open in a chosen profile ----------
async function pickContext(like, profile) {
  if (like) {
    if (!/^[0-9a-f]{4,32}$/i.test(like)) throw new Error(`bad --like id "${like}"`);
    const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
    const m = targetInfos.filter(t => t.type === 'page' && t.targetId.toLowerCase().startsWith(like.toLowerCase()));
    if (m.length !== 1) throw new Error(m.length ? `--like ${like} is ambiguous` : `--like tab ${like} is gone. Run \`tabs\` again.`);
    if (!S.letters.has(m[0].browserContextId)) await listTabs();
    return { ctx: m[0].browserContextId, likeTi: m[0], label: `프로필 ${S.letters.get(m[0].browserContextId) || '?'}` };
  }
  const { profiles } = await listTabs();
  const q = String(profile).trim().toLowerCase().replace(/^프로필\s*/, '').replace(/^['"‘’“”]+|['"‘’“”]+$/g, '').trim();
  let hit = profiles.filter(p => p.letter.toLowerCase() === q);
  if (!hit.length) hit = profiles.filter(p => p.dir && !p.guess && p.dir.toLowerCase() === q);
  if (!hit.length) hit = profiles.filter(p => p.name && !p.guess && baseName(p.name).toLowerCase() === q);
  if (!hit.length) hit = profiles.filter(p => p.name && p.name.toLowerCase().includes(q));
  // a profile Chrome knows (Local State; by name or folder): if no open profile is CERTAINLY that folder, let Chrome open
  // it by folder (closed -> new window; open but unmapped -> a tab in its window). Always the right profile.
  const local = /^[a-z]$/.test(q) ? null : localProfileDir(q);
  if (local) {
    const open = profiles.find(p => p.dir === local.dir && !p.guess);
    if (!open) return { ctx: null, likeTi: null, label: `프로필 '${local.name}'`, launchDir: local.dir };
    hit = [open];
  }
  const list = profiles.map(p => `${p.letter}=${p.name || '?'}`).join(', ');
  if (hit.length !== 1) throw new Error(`--profile "${profile}" matches ${hit.length} open profiles (${list})${local ? '' : ' and no closed profile in Local State'}. Use the letter from \`tabs\`, the profile name or folder, or --like <tab id>`);
  const dir = (hit[0].dir && !hit[0].guess ? hit[0].dir : null) || (local && local.dir) || null;
  return { ctx: hit[0].ctx, likeTi: null, label: `프로필 ${hit[0].letter}`, launchDir: dir };
}

async function createInContext(ctx, likeTi, background) {
  let def = null;
  try { def = (await withTimeout(S.bcdp.send('Target.getBrowserContexts'), 1000, 'contexts')).defaultBrowserContextId; } catch {}
  const p = { url: 'about:blank', background };
  if (ctx !== def) p.browserContextId = ctx;
  // tests: contexts of these "profile folders" behave like real profiles (CDP refuses browserContextId for them)
  const noCdp = String(process.env.CHROME_LIVE_TEST_NO_CDP_CREATE || '').split(',').map(s => s.trim()).filter(Boolean);
  const fake = p.browserContextId && noCdp.length && S.ctxDir.has(ctx) && noCdp.includes(S.ctxDir.get(ctx));
  try { if (fake) throw new Error('Failed to find browser context (test)'); return (await withTimeout(S.bcdp.send('Target.createTarget', p), 5000, 'createTarget')).targetId; }
  catch (e) {
    // Chrome only accepts browserContextId for the CDP default profile / CDP-made contexts. Other profiles:
    // ask the owner-chosen --like tab to open a blank tab next to it (isolated world, so page scripts can't see
    // or intercept it; no navigation/click/input in the owner's tab).
    if (!/Failed to find browser context/i.test(e.message)) throw e;
    if (!likeTi) throw new Error('this profile is not Chrome\'s CDP default; Chrome only lets us open a tab there from one of its tabs. Use --like <a tab the owner chose in that profile>');
  }
  // the --like tab is attached only for this window.open, then detached at once (if it was not attached before)
  const wasAttached = S.pages.has(likeTi.targetId);
  const r = await resolveTab(likeTi.targetId.slice(0, 12));
  try { return await openFromLike(r, likeTi, background); }
  finally { const e = S.pages.get(likeTi.targetId); if (!wasAttached && e) { e.busy = 0; detach(likeTi.targetId, '--like done').catch(() => {}); } }
}
// 프로필 기억: open <url> without --like/--profile -> the profile that last did successful work on this site.
// Never uses an unchosen owner tab: a non-default profile is reached through a chrome-live tab (🆕) in it, or the panel
// chat's own selected tab (chatTab); otherwise it refuses with that profile's tab ids (owner picks one for --like).
const baseName = n => n == null ? null : String(n).replace(/\s*\(추정\)\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim() || null;
async function rememberedTarget(rem, background, chatTab) {
  const str = v => typeof v === 'string' && v ? v.slice(0, 80) : null;
  const want = { dir: str(rem.dir), name: str(rem.name), ctx: str(rem.ctx) };
  const what = str(rem.label) || '(기억된 프로필)';
  const guessed = ps => { const g = ps.filter(p => want.name && p.name && p.guess && baseName(p.name) === want.name); return g.length === 1 ? g[0] : null; };
  const find = ps => ps.find(p => want.ctx && p.ctx === want.ctx) || ps.find(p => want.dir && p.dir === want.dir && !p.guess)
    || ps.find(p => want.name && p.name && !p.guess && baseName(p.name) === want.name) || guessed(ps);
  let { profiles } = await listTabs();
  let hit = find(profiles);
  if (!hit && (want.dir || want.name) && profiles.some(p => !p.dir || p.guess)) {   // an unresolved profile may be it: ask Windows now
    await withTimeout(winScan(true), 12000, 'winScan').catch(() => {});
    ({ profiles } = await listTabs()); hit = find(profiles);
  }
  const info = { site: str(rem.host), via: rem.via === 'site' ? 'site' : 'exact', profileLabel: what, n: Number(rem.n) || 0, last: str(rem.last), ...(str(rem.acct) ? { acct: str(rem.acct) } : {}) };
  // 닫힌 프로필 / no opener: Chrome opens the folder itself (see launchProfile)
  const dirKnown = (() => { const { info: li } = profileInfo(); if (want.dir && li[want.dir]) return want.dir; const l = want.name ? localProfileDir(want.name) : null; return l && (!want.dir || l.dir === want.dir) ? l.dir : null; })();
  const viaLaunch = async (status, why) => {
    const L = await launchProfile(dirKnown);
    await listTabs().catch(() => {});   // letter for the (new) context
    const letter = S.letters.get(L.ctx) || null;
    return { targetId: L.targetId, how: `remembered: launched profile ${L.name}`, launched: L, info: { ...info, status, profile: letter, note: why } };
  };
  if (!hit) {
    const amb = want.name ? profiles.filter(p => (!p.dir || p.guess) && (p.candidates.some(c => baseName(c) === want.name) || (p.guess && baseName(p.name) === want.name))).map(p => p.letter) : [];
    let failed = '';
    if (dirKnown) {
      try { return await viaLaunch('launched', amb.length ? `기억된 프로필 ${what}을(를) 폴더로 크롬에 열게 했어요(열린 프로필 중 구분이 안 돼서)` : `기억된 프로필 ${what}이(가) 닫혀 있어 크롬에 그 프로필을 열게 했어요(새 창)`); }
      catch (e) { failed = ` (그 프로필 열기 실패: ${String(e.message).slice(0, 120)})`; log(`launch failed: ${e.message}`); }
    }
    return { info: { ...info, status: amb.length ? 'ambiguous' : 'not-open',
      note: amb.length ? `기억된 프로필 ${what}일 수 있는 프로필이 여러 개(${amb.join(', ')})라 구분이 안 돼 기본 프로필로 열었어요${failed}. 로그인이 안 돼 있으면 open <url> --profile "<이름>" 또는 그 프로필의 탭으로 --like <id>`
        : `기억된 프로필 ${what}이(가) 지금 크롬에 열려 있지 않아 기본 프로필로 열었어요${failed}(로그인이 안 돼 있을 수 있음)` } };
  }
  const label = `프로필 ${hit.letter}`;
  let likeTi = null, pages = [];
  if (!hit.isDefault) {
    const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
    pages = targetInfos.filter(t => t.type === 'page' && !t.subtype && t.browserContextId === hit.ctx);
    const ct = typeof chatTab === 'string' && /^[0-9a-f]{4,32}$/i.test(chatTab) ? chatTab.toLowerCase() : null;
    likeTi = pages.find(t => S.owned.has(t.targetId) && /^https?:|^about:blank/.test(t.url)) || (ct && pages.find(t => t.targetId.toLowerCase().startsWith(ct))) || null;
  }
  let targetId;
  try { targetId = await createInContext(hit.ctx, likeTi, background); }
  catch (e) {
    if (!/Use --like/.test(e.message)) throw e;
    // no opener tab in that profile: Chrome opens a tab in that profile's window by folder
    const dir = (hit.dir && !hit.guess ? hit.dir : null) || dirKnown;
    let failed = '';
    if (dir) {
      try {
        const L = await launchProfile(dir);
        if (L.ctx === hit.ctx || !hit.ctx) return { targetId: L.targetId, how: `remembered: launched profile ${L.name}`, launched: L, info: { ...info, status: 'used', profile: hit.letter } };
        await listTabs().catch(() => {});
        return { targetId: L.targetId, how: `remembered: launched profile ${L.name}`, launched: L, info: { ...info, status: 'used', profile: S.letters.get(L.ctx) || null } };
      } catch (e2) { failed = ` (폴더로 열기도 실패: ${String(e2.message).slice(0, 120)})`; log(`launch failed: ${e2.message}`); }
    }
    const tabs = pages.filter(t => /^https?:/.test(t.url)).slice(0, 5).map(t => `${shortId(t.targetId)} ${hostOf(t.url)}`).join(', ') || '(없음)';
    const def = profiles.find(p => p.isDefault);
    throw new Error(`기억된 프로필 ${what}(지금 ${label})에 새 탭을 열려면 그 프로필의 탭이 하나 필요해요(크롬은 기본 프로필이 아니면 CDP로 바로 못 열어요)${failed}. 그 프로필의 탭: ${tabs}. `
      + `주인이 고른(허락한) 그 프로필 탭으로: open <url> --like <id>.${def ? ` 기본 프로필(${def.letter})로 그냥 열려면: open <url> --profile ${def.letter}` : ''}`);
  }
  const { targetInfo } = await withTimeout(S.bcdp.send('Target.getTargetInfo', { targetId }), 3000, 'targetInfo');
  if (targetInfo.browserContextId !== hit.ctx) { await S.bcdp.send('Target.closeTarget', { targetId }).catch(() => {}); throw new Error(`new tab landed in a different profile than ${label}; closed it`); }
  return { targetId, how: `remembered: ${label}${likeTi ? ' like ' + shortId(likeTi.targetId) : ''}`, info: { ...info, status: 'used', profile: hit.letter } };
}
async function openFromLike(r, likeTi, background) {
  const wasVisible = (await pageFlags(r)).visible;
  const nonce = 'chrome-live-' + require('crypto').randomBytes(6).toString('hex');
  const { frameTree } = await withTimeout(r.session.send('Page.getFrameTree'), 3000, 'frameTree (is the --like tab asleep? ask the owner to click it once)');
  const { executionContextId } = await withTimeout(r.session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'chrome-live-open' }), 3000, 'isolated world');
  await withTimeout(r.session.send('Runtime.evaluate', { expression: `void window.open('about:blank#${nonce}', '_blank', 'noopener')`, contextId: executionContextId, userGesture: true }), 3000, 'window.open');
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await S.bcdp.send('Target.getTargets');
    const t = targetInfos.find(x => x.type === 'page' && x.url.endsWith('#' + nonce));
    if (t) {
      if (background && wasVisible) await S.bcdp.send('Target.activateTarget', { targetId: likeTi.targetId }).catch(() => {});
      return t.targetId;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('the --like tab did not open a new tab (popup blocked?)');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// runs in the page: visible editable fields of the main frame -> {selector, tag, type, name, idAttr, autocomplete,
// label, aria, context (th/dt/preceding text), placeholder, title, readonly, maxlength, filled(bool)}. No values.
const FORMSCAN_JS = () => {
  const q = s => { try { return document.querySelectorAll(s); } catch { return []; } };
  const txt = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  function sel(el) {
    if (el.id && q('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    if (el.name) { const s = `${tag}[name="${String(el.name).replace(/["\\]/g, '\\$&')}"]`; if (q(s).length === 1) return s; }
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement) {
      if (e !== el && e.id && q('#' + esc(e.id)).length === 1) { parts.unshift('#' + esc(e.id)); break; }
      let p = e.tagName.toLowerCase();
      const par = e.parentElement;
      if (par) { const sib = [...par.children].filter(c => c.tagName === e.tagName); if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`; }
      parts.unshift(p); e = par;
    }
    return parts.join(' > ');
  }
  function labelOf(el) {
    const l = el.labels && el.labels.length ? [...el.labels].map(x => x.innerText || x.textContent).join(' ') : '';
    if (l.trim()) return txt(l);
    const c = el.closest('label'); return c ? txt(c.innerText || c.textContent) : '';
  }
  function ariaOf(el) {
    if (el.getAttribute('aria-label')) return txt(el.getAttribute('aria-label'));
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return txt(ids.map(i => { const n = document.getElementById(i); return n ? n.textContent : ''; }).join(' '));
  }
  function contextOf(el) {
    const cell = el.closest('td,dd');
    if (cell) {
      const prev = cell.previousElementSibling;
      if (prev && /^(TH|TD|DT)$/.test(prev.tagName)) return txt(prev.innerText || prev.textContent);
      const tr = cell.closest('tr'); const th = tr && tr.querySelector('th'); if (th) return txt(th.innerText || th.textContent);
    }
    let p = el.previousElementSibling, n = 0;
    while (p && n++ < 3) { const t = txt(p.innerText || p.textContent); if (t && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(p.tagName)) return t; p = p.previousElementSibling; }
    const par = el.parentElement;
    if (par) { const t = [...par.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join(' '); if (txt(t)) return txt(t); }
    return '';
  }
  // v12: text near a widget (for 1-char boxes without own labels): legend / aria-label / the previous non-input sibling of an ancestor
  function nearOf(el) {
    let e = el.parentElement;
    for (let i = 0; i < 4 && e && e !== document.body; i++, e = e.parentElement) {
      if (e.tagName === 'FIELDSET') { const lg = e.querySelector('legend'); if (lg && txt(lg.textContent)) return txt(lg.textContent); }
      const al = e.getAttribute('aria-label'); if (al && txt(al)) return txt(al);
      let p = e.previousElementSibling, n = 0;
      while (p && n++ < 2) { if (!p.matches('input,select,textarea,button') && !p.querySelector('input,select,textarea')) { const t = txt(p.innerText || p.textContent); if (t) return t; } p = p.previousElementSibling; }
    }
    return '';
  }
  // v12: secure virtual keypad / keyboard-security inputs (transkey, nProtect, TouchEn, AnySign ...): never automated
  const KP = /transkey|data-tk-|\btk_|keypad|key-pad|virtual[-_ ]?key|secure[-_ ]?key|nppfs|npkencrypt|touchen|raonk|\bkings\b|anysign|\bastx/i;
  function keypadOf(el) {
    const own = [...el.attributes].map(a => a.name + '=' + a.value).join(' ');
    if (KP.test(own)) return true;
    let p = el.parentElement;
    for (let i = 0; i < 2 && p; i++, p = p.parentElement) if (KP.test(`${p.id} ${typeof p.className === 'string' ? p.className : ''}`)) return true;
    return false;
  }
  const out = [];
  for (const el of document.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
    const r = el.getClientRects();
    const cs = getComputedStyle(el);
    const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'contenteditable';
    if (type === 'hidden' || !r.length || cs.visibility === 'hidden' || cs.display === 'none') continue;
    out.push({ selector: sel(el), tag: el.tagName.toLowerCase(), type, name: txt(el.getAttribute('name')), idAttr: txt(el.id),
      autocomplete: txt(el.getAttribute('autocomplete')), label: labelOf(el), aria: ariaOf(el), context: contextOf(el),
      placeholder: txt(el.getAttribute('placeholder')), title: txt(el.getAttribute('title')),
      readonly: !!(el.readOnly || el.disabled), maxlength: el.maxLength > 0 ? el.maxLength : 0, near: nearOf(el), keypad: keypadOf(el),
      filled: type === 'select' ? false : !!(el.value || (el.isContentEditable && el.textContent.trim())) });
    if (out.length >= 80) break;
  }
  return out;
};

// ---------- 기록 "넣은 값" (owner's side panel only): what a run script typed / set ----------
// runs in the page on the element an action used: {k, t, v} = kind (text|select|check|radio), target name (<=60), value (<=200).
// Password / OTP / card-like fields come back as •••• (the raw value never leaves the page). Non-input elements -> null.
const DESCRIBE_JS = (el) => {
  if (!el || el.nodeType !== 1) return null;
  const T = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const TOG = 'input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio],[role=option],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[aria-pressed]';
  const FIELD = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
  let x = el;
  if (x.tagName === 'LABEL' && x.control) x = x.control;
  else if (x.tagName === 'OPTION' && x.parentElement) x = x.closest('select') || x;
  else if (!x.matches(TOG + ',' + FIELD)) {
    const up = x.closest(TOG + ',label');
    if (up && up.tagName === 'LABEL') { if (up.control) x = up.control; }
    else if (up) x = up;
    else { const ins = x.querySelectorAll(TOG); if (ins.length === 1) x = ins[0]; }
  }
  const tag = x.tagName.toLowerCase(), type = (x.getAttribute('type') || '').toLowerCase(), role = (x.getAttribute('role') || '').toLowerCase();
  const textOf = n => { if (!n) return ''; const c = n.cloneNode(true); for (const f of c.querySelectorAll('input,select,textarea,script,style')) f.remove(); return c.textContent; };
  const byIds = ids => String(ids || '').split(/\s+/).filter(Boolean).map(i => textOf(x.ownerDocument.getElementById(i))).join(' ');
  let name = x.getAttribute('aria-label') || byIds(x.getAttribute('aria-labelledby'));
  if (!T(name, 60) && x.labels && x.labels.length) name = [...x.labels].map(textOf).join(' ');
  if (!T(name, 60)) { const l = x.closest('label'); if (l) name = textOf(l); }
  if (!T(name, 60) && /^(option|radio|checkbox|switch|tab|menuitemcheckbox|menuitemradio)$/.test(role)) name = textOf(x);
  if (!T(name, 60) && x.hasAttribute('aria-pressed')) name = textOf(x);
  if (!T(name, 60)) { const cell = x.closest('td,dd'); const prev = cell && cell.previousElementSibling; if (prev && /^(TH|DT)$/.test(prev.tagName)) name = textOf(prev); }
  if (!T(name, 60)) name = x.getAttribute('placeholder') || x.getAttribute('title') || x.getAttribute('name') || x.id || tag;
  const t = T(name, 60);
  const sig = [type, x.getAttribute('autocomplete'), x.getAttribute('name'), x.id, t].join(' ');
  const secret = type === 'password' || /one-time-code|cc-|current-password|new-password/i.test(x.getAttribute('autocomplete') || '')
    || /pass(word|wd)?\b|passwd|pwd|비밀번호|비번|otp|cvc|cvv|card.?n(o|um)|카드\s*번호|인증\s*번호|보안\s*코드|\bpin\b/i.test(sig);
  const on = v => v === true || v === 'true' || v === 'mixed';
  if (tag === 'select') return { k: 'select', t, v: T([...x.selectedOptions].map(o => o.label || o.text).join(', '), 200) };
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return { k: type === 'radio' ? 'radio' : 'check', t, on: !!x.checked };
  if (/^(checkbox|switch|menuitemcheckbox)$/.test(role)) return { k: 'check', t, on: on(x.getAttribute('aria-checked')) };
  if (/^(radio|menuitemradio)$/.test(role)) return { k: 'radio', t, on: on(x.getAttribute('aria-checked')) };
  if (role === 'option' || role === 'tab') { const s = x.getAttribute('aria-selected'); return { k: role === 'tab' ? 'radio' : 'check', t, on: s == null ? true : on(s) }; }
  if (x.hasAttribute('aria-pressed')) return { k: 'check', t, on: on(x.getAttribute('aria-pressed')) };
  if (tag === 'textarea' || (tag === 'input' && !/^(button|submit|reset|image|file|hidden|range|color)$/.test(type)) || x.isContentEditable)
    return { k: 'text', t, v: secret ? '••••' : T(x.isContentEditable && tag !== 'input' && tag !== 'textarea' ? x.textContent : x.value, 200) };
  return null;
};
const INPUTS_MAX = 30;
const TRACE = new AsyncLocalStorage();   // per run: { entries: Map, more } ; { inner: true } while the original action runs
const INNER = { inner: true };
const capped = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]).catch(() => null);
function noteInput(st, key, d) {
  if (!d || !d.k) return;
  // same field again (clear + type, toggle twice, another selector for the same label): keep its final state, first position
  const alias = `${d.k}\u0001${d.t}`;
  if (st.alias.has(alias)) key = st.alias.get(alias);
  if (st.entries.has(key)) { st.entries.set(key, d); st.alias.set(alias, key); return; }
  if (st.entries.size >= INPUTS_MAX) {   // count each extra field once
    const dr = st.dropped || (st.dropped = new Set());
    if (!dr.has(key) && !dr.has(alias)) st.more++;
    dr.add(key); dr.add(alias); return;
  }
  st.entries.set(key, d); st.alias.set(alias, key);
}
const FRAME_NO = new WeakMap(); let frameSeq = 0;
const frameNo = f => { if (!FRAME_NO.has(f)) FRAME_NO.set(f, ++frameSeq); return FRAME_NO.get(f); };
let patchedFrames = false;
// Frame (client) is where page.* and locator.* actions end up: fill/type/check/uncheck/selectOption/click/tap(selector, ...)
function instrument(page) {
  if (patchedFrames) return;
  try {
    const FP = Object.getPrototypeOf(page.mainFrame());
    const KP = Object.getPrototypeOf(page.keyboard);
    const desc = (frame, selector, ms) => capped(frame.$eval(selector, DESCRIBE_JS), ms);
    for (const name of ['fill', 'type', 'selectOption', 'check', 'uncheck', 'click', 'tap']) {
      const orig = FP[name];
      if (typeof orig !== 'function') continue;
      FP[name] = async function (selector, ...rest) {
        const st = TRACE.getStore();
        if (!st || st.inner || typeof selector !== 'string') return orig.call(this, selector, ...rest);
        const click = name === 'click' || name === 'tap';
        // clicks: only toggles (checkbox / switch / radio / option) are recorded; look before (the page may navigate after)
        const pre = click ? await desc(this, selector, 300) : null;
        const r = await TRACE.run(INNER, () => orig.call(this, selector, ...rest));
        try {
          const key = `${frameNo(this)}|${selector}`;
          if (!click) noteInput(st, key, await desc(this, selector, 500));
          else if (pre && (pre.k === 'check' || pre.k === 'radio')) {
            const d = await desc(this, selector, 500);   // gone after the click (closed dropdown, navigation): assume it toggled
            noteInput(st, key, d && d.k === pre.k ? d : { ...pre, on: pre.k === 'radio' ? true : !pre.on });
          }
        } catch {}
        return r;
      };
    }
    for (const name of ['type', 'insertText']) {   // page.keyboard.type('...') into the focused field (main frame)
      const orig = KP[name];
      if (typeof orig !== 'function') continue;
      KP[name] = async function (...a) {
        const st = TRACE.getStore();
        if (!st || st.inner) return orig.apply(this, a);
        const r = await TRACE.run(INNER, () => orig.apply(this, a));
        try {
          const p = this._page;
          const d = p && await capped(p.mainFrame().evaluate(`(${DESCRIBE_JS})(document.activeElement)`), 500);
          if (d && d.k === 'text') noteInput(st, `kb:${d.t}`, d);
        } catch {}
        return r;
      };
    }
    patchedFrames = true;
  } catch (e) { log(`input log disabled: ${String(e.message).split('\n')[0]}`); patchedFrames = true; }
}
const inputsOf = st => st && st.entries.size ? { inputs: [...st.entries.values()], ...(st.more ? { inputsMore: st.more } : {}) } : {};

const commands = {
  async tabs() { return listTabs(); },
  async diag() {   // read-only: which tabs answer page.title() (what @playwright/mcp awaited for every tab, without timeout)
    const out = [];
    await Promise.all([...S.pages.entries()].map(async ([tid, { page }]) => {
      const t0 = Date.now(); let res;
      try { await withTimeout(page.title(), 3000, 'title'); res = 'ok'; } catch { res = 'HANG'; }
      out.push({ id: shortId(tid), host: hostOf(page.url()), pwUrlKnown: !!page.url(), title: res, ms: Date.now() - t0 });
    }));
    return out.sort((a, b) => b.ms - a.ms);
  },
  async run({ id, code, args, timeout = DEFAULT_TIMEOUT, ...opts }, ctx = {}) {
    const r = await guard(id, opts);
    const page = r.page;
    instrument(page);
    const st = { entries: new Map(), alias: new Map(), more: 0 };
    ctx.inputs = () => inputsOf(st);   // -> reply meta (daemon redacts, then events.jsonl / 기록). Never in the result.
    page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
    log(`run ${id} @${hostOf(r.ti.url)} (${code.length} chars, timeout ${timeout})`);
    const fn = new AsyncFunction('page', 'context', 'args', code);
    const sleep = await wake(r);
    try {
      const result = await withTimeout(TRACE.run(st, () => fn(page, page.context(), args || {})), timeout, `run on tab ${id} (selector missing? or background tab: clicks/screenshots need --front)`);
      S.lastHost.set(r.ti.targetId, hostOf(page.url()));
      return { id, url: page.url(), result: result === undefined ? null : result };
    } catch (e) {
      try { S.lastHost.set(r.ti.targetId, hostOf(page.url())); } catch {}
      log(`run ${id} error: ${e.message.split('\n')[0]}`);
      throw e;
    } finally { sleep(); }
  },
  async shot({ id, file, fullPage = false, type, quality, timeout = DEFAULT_TIMEOUT, ...opts }) {
    const r = await guard(id, { ...opts, allowMedia: true });
    if (!type) type = file && /\.jpe?g$/i.test(file) ? 'jpeg' : 'png';
    if (!['png', 'jpeg'].includes(type)) throw new Error(`bad image type ${type} (png|jpeg)`);
    if (type === 'jpeg' && quality == null) quality = 70;
    if (!file) file = path.join(require('os').tmpdir(), `chrome-live-${id}-${Date.now()}.${type === 'jpeg' ? 'jpg' : 'png'}`);
    file = path.resolve(file);
    log(`shot ${id} @${hostOf(r.ti.url)} ${type}${fullPage ? ' full' : ''}${opts.front ? ' (front)' : ''}`);
    const hint = `screenshot of tab ${id} (background tabs do not paint; retry with --front after telling the owner)`;
    let buf;
    const sleep = await wake(r);
    try {
    if (!fullPage) {
      // fast path: one CDP round trip on the already-attached session (Playwright's screenshot adds
      // several round trips + an rAF wait that stalls in background tabs)
      const p = { format: type, captureBeyondViewport: false, fromSurface: true };
      if (type === 'jpeg') p.quality = Number(quality);
      const res = await withTimeout(r.session.send('Page.captureScreenshot', p), timeout, hint);
      buf = Buffer.from(res.data, 'base64');
    } else {
      buf = await withTimeout(r.page.screenshot({ fullPage, type, quality: type === 'jpeg' ? Number(quality) : undefined, timeout, animations: 'allow', caret: 'initial' }),
        timeout + 1000, hint);
    }
    } finally { sleep(); }
    fs.writeFileSync(file, buf);
    return { id, file, type, bytes: buf.length };
  },
  async snapshot({ id, timeout = DEFAULT_TIMEOUT, depth, selector, maxChars, ...opts }) {
    const r = await guard(id, { ...opts, allowMedia: true });
    log(`snapshot ${id} @${hostOf(r.ti.url)}${depth ? ' depth ' + depth : ''}${selector ? ' (selector)' : ''}`);
    const so = { timeout }; if (depth) so.depth = Number(depth);
    let text = await withTimeout(r.page.locator(selector || 'body').first().ariaSnapshot(so), timeout + 1000, `snapshot of tab ${id}`);
    const full = text.length;
    if (maxChars && full > Number(maxChars)) text = text.slice(0, Number(maxChars)) + `\n… (truncated ${full - Number(maxChars)} of ${full} chars; use --selector/--depth)`;
    return { id, url: r.page.url(), title: r.ti.title, chars: full, snapshot: text };
  },
  // read-only: describe the form fields of the main frame (labels/attributes, never their current values)
  async formscan({ id, timeout = DEFAULT_TIMEOUT, ...opts }) {
    const r = await guard(id, { ...opts, allowMedia: true });
    log(`formscan ${id} @${hostOf(r.ti.url)}`);
    const sleep = await wake(r);
    try {
      const fields = await withTimeout(r.page.evaluate(FORMSCAN_JS), timeout, `formscan of tab ${id}`);
      return { id, url: r.page.url(), fields };
    } finally { sleep(); }
  },
  // types vault values (substituted by the daemon) into fields. Never presses Enter / clicks submit.
  // Returns only ok/reason per selector - never the values.
  async fill({ id, fields, timeout = DEFAULT_TIMEOUT, type = false, allowReadonly = false, ...opts }, ctx = {}) {
    const r = await guard(id, opts);
    if (!Array.isArray(fields) || !fields.length) throw new Error('no fields');
    log(`fill ${id} @${hostOf(r.ti.url)} (${fields.length} fields)`);
    const page = r.page, per = Math.min(8000, Math.max(2000, Math.floor(timeout / fields.length)));
    const results = [];
    const done = [];   // 기록: field name + key only (never the value)
    ctx.inputs = () => done.length ? { inputs: done.slice(0, INPUTS_MAX), ...(done.length > INPUTS_MAX ? { inputsMore: done.length - INPUTS_MAX } : {}) } : {};
    const sleep = await wake(r);
    try {
      for (const f of fields) {
        const out = { selector: f.selector, key: f.key, ok: false };
        let loc = null;
        try {
          loc = page.locator(f.selector).first();
          const info = await loc.evaluate(el => {
            const KP = /transkey|data-tk-|\btk_|keypad|key-pad|virtual[-_ ]?key|secure[-_ ]?key|nppfs|npkencrypt|touchen|raonk|\bkings\b|anysign|\bastx/i;
            let kp = KP.test([...el.attributes].map(a => a.name + '=' + a.value).join(' '));
            for (let p = el.parentElement, i = 0; !kp && p && i < 2; i++, p = p.parentElement) kp = KP.test(`${p.id} ${typeof p.className === 'string' ? p.className : ''}`);
            return { tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), ro: !!(el.readOnly || el.disabled),
              ce: !!el.isContentEditable, max: el.maxLength > 0 ? el.maxLength : 0, kp };
          }, null, { timeout: per });
          // v12: secure virtual keypads are never automated (no keypad clicks, no OCR, no readonly removal)
          if (info.kp) { out.reason = '보안 키패드 칸이라 자동 입력하지 않아요 (owner가 화면 키패드로 직접 입력)'; results.push(out); continue; }
          if (f.rrn && info.ro) { out.reason = '읽기 전용 주민번호 칸(보안 키패드일 수 있음)은 자동 입력하지 않아요 (owner가 직접 입력)'; results.push(out); continue; }
          // password: only the 가입용 계정 item (pw flag set by vault.js) or a masked 주민번호 칸 (rrn flag, v12)
          if ((info.type === 'password' && !f.pw && !f.rrn) ||['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'image'].includes(info.type)) { out.reason = `${info.type} 칸은 입력하지 않음`; results.push(out); continue; }
          let v = String(f.value);
          if (info.max && v.length > info.max) {   // e.g. 010-1234-5678 into maxlength=11 -> digits only
            const d = v.replace(/[\s-]/g, '');
            if (d.length <= info.max) { v = d; out.note = '하이픈/공백 빼고 입력 (칸 길이 제한)'; }
            else { out.reason = `값이 칸 길이 제한(${info.max})보다 김`; results.push(out); continue; }
          }
          if (info.tag === 'select') {
            let done = false;
            for (const how of [{ value: v }, { label: v }]) { try { await loc.selectOption(how, { timeout: per }); done = true; break; } catch {} }
            if (!done) { out.reason = '선택 목록에 맞는 항목 없음'; results.push(out); continue; }
            out.ok = true;
          } else if (info.ro) {
            if (!allowReadonly) { out.reason = '읽기 전용 칸 (사이트의 찾기 버튼으로 채우는 칸일 수 있음; owner가 원하면 --allow-readonly)'; results.push(out); continue; }
            await loc.evaluate((el, val) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d && d.set ? d.set.call(el, val) : (el.value = val);
              el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v, { timeout: per });
            out.ok = true; out.note = '읽기 전용 칸에 직접 값 설정';
          } else {
            if (type) { await loc.fill('', { timeout: per }); await loc.pressSequentially(v, { delay: 15, timeout: per + v.length * 40 }); }
            else await loc.fill(v, { timeout: per });
            if (!info.ce) {
              const now = await loc.inputValue({ timeout: per });
              out.ok = now === v;
              if (!out.ok) out.reason = now ? '입력 후 값이 달라짐 (사이트가 형식을 바꿨을 수 있음; --type 으로 재시도)' : '입력 후 칸이 비어 있음 (--type 으로 재시도)';
            } else out.ok = true;
          }
        } catch (e) { out.reason = e.message.split('\n')[0].slice(0, 160); }
        results.push(out);
        if (out.ok) { const d = await capped(loc.evaluate(DESCRIBE_JS, null, { timeout: 500 }), 700); done.push({ k: 'vault', t: String((d && d.t) || f.selector).slice(0, 60), key: f.key }); }
      }
    } finally { sleep(); }
    S.lastHost.set(r.ti.targetId, hostOf(page.url()));
    return { id, url: page.url(), filled: results.filter(x => x.ok).length, total: results.length, results };
  },
  async front({ id }) {
    const ti = await findTarget(id);   // browser-level: no session on the tab
    log(`front ${id} @${hostOf(ti.url)}`);
    await withTimeout(S.bcdp.send('Target.activateTarget', { targetId: ti.targetId }), 5000, 'bringToFront');
    return { id };
  },
  async open({ url = 'about:blank', background = false, timeout = DEFAULT_TIMEOUT, waitUntil, like, profile, remember, chatTab }) {
    if (waitUntil && !['load', 'domcontentloaded', 'commit', 'networkidle'].includes(waitUntil)) throw new Error(`bad --wait ${waitUntil}`);
    let targetId, how = 'default', remembered = null, launched = null;
    // 프로필 기억 (server.js passes the remembered profile for this site only when there is no --like/--profile)
    if (!like && !profile && remember && typeof remember === 'object') {
      const r = await rememberedTarget(remember, background, chatTab);
      remembered = r.info;
      if (r.targetId) { targetId = r.targetId; how = r.how; launched = r.launched || null; }
    }
    if (targetId) { /* opened in the remembered profile */ }
    else if (like || profile) {
      const { ctx, likeTi, label, launchDir } = await pickContext(like, profile);
      if (!ctx && launchDir) {   // 닫힌 프로필: Chrome opens that folder (new window)
        launched = await launchProfile(launchDir);
        targetId = launched.targetId; how = `launched profile ${launched.name}`;
      } else {
        try { targetId = await createInContext(ctx, likeTi, background); how = `${label}${likeTi ? ' like ' + shortId(likeTi.targetId) : ''}`; }
        catch (e) {
          // open profile without an opener tab (not the CDP default): Chrome opens a tab in that profile's window by folder
          if (!/Use --like/.test(e.message) || like || !launchDir) throw e;
          try { launched = await launchProfile(launchDir); } catch (e2) { throw new Error(`${e.message} (폴더 ${launchDir}로 열기도 실패: ${e2.message})`); }
          targetId = launched.targetId; how = `launched profile ${launched.name}`;
        }
        const { targetInfo } = await withTimeout(S.bcdp.send('Target.getTargetInfo', { targetId }), 3000, 'targetInfo');
        if (!launched && targetInfo.browserContextId !== ctx) {   // never leave a tab in the wrong profile
          await S.bcdp.send('Target.closeTarget', { targetId }).catch(() => {});
          throw new Error(`new tab landed in a different profile than ${label}; closed it`);
        }
      }
    } else {
      ({ targetId } = await withTimeout(S.bcdp.send('Target.createTarget', { url: 'about:blank', background }), 5000, 'createTarget'));
    }
    S.owned.add(targetId); S.idMap.set(shortId(targetId), targetId);
    const entry = await attach(targetId);   // focus emulation is applied there (own tabs only)
    use(targetId, entry);
    log(`open ${shortId(targetId)} -> ${hostOf(url) || 'blank'}${background ? ' (background)' : ''} [${how}]`);
    // domcontentloaded by default: returns as soon as the DOM is usable (Playwright actions auto-wait anyway)
    if (url !== 'about:blank' || launched) await entry.page.goto(url, { timeout, waitUntil: waitUntil || 'domcontentloaded' });   // launched: leave our marker page
    S.lastHost.set(targetId, hostOf(entry.page.url()));
    const newCtx = (await S.bcdp.send('Target.getTargetInfo', { targetId }).catch(() => ({ targetInfo: {} }))).targetInfo.browserContextId;
    if (newCtx) S.ctxOf.set(targetId, newCtx);
    if (newCtx && !S.letters.has(newCtx)) await listTabs().catch(() => {});
    const prof = S.letters.get(newCtx);
    if (launched) { const nm = launched.name; if (prof) S.profName.set(prof, nm); if (prof) S.profDir.set(prof, launched.dir); }
    return { id: shortId(targetId), url: entry.page.url(), profile: prof || null, how, ...(remembered ? { remembered } : {}),
      ...(launched ? { launched: { profile: launched.name, dir: launched.dir, window: launched.window, ms: launched.ms,
        note: `${launched.window === 'new' ? '그 프로필의 새 창' : '그 프로필 창의 새 탭'}으로 열렸어요(크롬이 그 창을 앞으로 띄움${background ? ' · --background는 적용 안 됨' : ''})` } } : {}) };
  },
  async close({ id, force = false }) {
    const ti = await findTarget(id);   // browser-level: closing needs no session on the tab
    if (!S.owned.has(ti.targetId) && !force)
      throw new Error(`refused: tab ${id} was not opened by chrome-live. Close it only if the owner explicitly asked (--force)`);
    log(`close ${id} @${hostOf(ti.url)}${force ? ' (force)' : ''}`);
    const e = S.pages.get(ti.targetId); if (e) clearTimeout(e.idleT);
    await withTimeout(S.bcdp.send('Target.closeTarget', { targetId: ti.targetId }), 5000, 'close');
    S.owned.delete(ti.targetId);
    return { id, closed: true };
  },
  // side panel "follow the tab the owner is looking at" (owner decision 2026-11-01). Browser-level reads ONLY: no
  // session on any tab, works the same in attachMode on-demand and all. Chrome's "tab" targets carry
  // embedderData {tabActive, tabStripIndex}; Browser.getWindowForTarget windowIds are the extension's windows.Window.id
  // (same numbers, checked in Chromium 1248). tab target -> page target: same profile + url + title in that window
  // (the k-th duplicate on one side = the k-th on the other: both lists come in the same WebContents order).
  async activeTab({ windowId, index }) {
    if (!Number.isInteger(windowId)) throw new Error('bad windowId');
    const win = async tid => { try { return (await withTimeout(S.bcdp.send('Browser.getWindowForTarget', { targetId: tid }), 1000, 'window')).windowId; } catch { return null; } };
    const isPage = t => t.type === 'page' && !t.subtype && !t.url.startsWith('devtools://');
    const listed = url => !/^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|about|view-source):/i.test(url);   // browser / extension pages keep the selection
    const [{ targetInfos: tabT }, { targetInfos: all }] = await Promise.all([
      withTimeout(S.bcdp.send('Target.getTargets', { filter: [{ type: 'tab' }] }), 3000, 'Target.getTargets tab'),
      withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets')]);
    const pages = all.filter(isPage);
    const out = ti => {
      const dup = pages.some(o => o.targetId !== ti.targetId && shortId(o.targetId) === shortId(ti.targetId));
      return { found: true, id: dup ? ti.targetId.slice(0, 10).toLowerCase() : shortId(ti.targetId), title: ti.title, host: hostOf(ti.url), listed: listed(ti.url), owned: S.owned.has(ti.targetId) };
    };
    const tabs = tabT.filter(t => t.type === 'tab' && t.embedderData);
    if (!tabs.length) {   // older Chrome without tab targets / embedderData: visible page among the tabs we already have a session on
      const vis = [];
      for (const p of pages) if (S.pages.has(p.targetId) && await win(p.targetId) === windowId && (await pageFlags(S.pages.get(p.targetId))).visible) vis.push(p);
      return vis.length === 1 ? { ...out(vis[0]), via: 'visibility' } : { found: false, reason: 'unsupported' };
    }
    let tab = null;
    const pick = async pred => { for (const t of tabs.filter(pred)) if (await win(t.targetId) === windowId) return t; return null; };
    if (Number.isInteger(index)) tab = await pick(t => t.embedderData.tabStripIndex === index);
    if (!tab) tab = await pick(t => t.embedderData.tabActive);
    if (!tab) return { found: false, reason: 'no-tab' };
    const same = (a, b, title) => a.browserContextId === b.browserContextId && a.url === b.url && (!title || a.title === b.title);
    for (const title of [true, false]) {
      const cands = []; for (const p of pages) if (same(p, tab, title) && await win(p.targetId) === windowId) cands.push(p);
      if (!cands.length) continue;
      if (cands.length === 1) return out(cands[0]);
      const twins = []; for (const t of tabs) if (same(t, tab, title) && await win(t.targetId) === windowId) twins.push(t);
      const k = twins.findIndex(t => t.targetId === tab.targetId);
      return cands[k] ? out(cands[k]) : { found: false, reason: 'ambiguous' };
    }
    return { found: false, reason: 'no-page' };
  },
  // read-only hygiene check: which page targets have ANY CDP session right now (browser-level Target.getTargets)
  async attached() {
    const { targetInfos } = await withTimeout(S.bcdp.send('Target.getTargets'), 3000, 'Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page');
    return { attachMode: SET.attachMode, tabIdleDetachSec: SET.tabIdleDetachSec, pages: pages.length,
      attachedPages: pages.filter(t => t.attached).length, ourSessions: S.pages.size,
      attachedNotOurs: pages.filter(t => t.attached && !S.pages.has(t.targetId)).map(t => shortId(t.targetId)),
      iframesAttached: targetInfos.filter(t => t.type === 'iframe' && t.attached).length,
      workersAttached: targetInfos.filter(t => /worker/.test(t.type) && t.attached).length,
      attachedIds: pages.filter(t => t.attached).map(t => ({ id: shortId(t.targetId), owned: S.owned.has(t.targetId), ours: S.pages.has(t.targetId) })) };
  },
};

// what the side-panel log may show about a command: tab id, domain, profile, tab TITLE (trimmed to 60 chars).
// The title goes ONLY to the local events.jsonl / side panel (never to server.log). Never urls/page contents.
const trimTitle = t => { t = String(t || '').replace(/[ -]+/g, ' ').replace(/\s+/g, ' ').trim(); return t ? (t.length > 60 ? t.slice(0, 59) + '…' : t) : null; };
async function eventMeta(args, data) {
  const id = (data && data.id) || (args && args.id);
  if (!id || typeof id !== 'string') return {};
  const tid = S.idMap.get(id.toLowerCase());
  if (!tid) return { id };
  let url = null;
  try {   // current title (after the action); falls back to the last one seen if the tab is gone
    const { targetInfo } = await withTimeout(S.bcdp.send('Target.getTargetInfo', { targetId: tid }), 500, 'title');
    if (targetInfo && targetInfo.title) S.lastTitle.set(tid, targetInfo.title);
    if (targetInfo) url = targetInfo.url;
  } catch {}
  const ctx = S.ctxOf.get(tid) || null;
  const letter = S.letters.get(ctx) || null;
  // 프로필 기억 only (server.js never puts these in events): folder, context, account hint + "looks like a login page" from the URL
  const hint = urlHints(url);
  return { id, host: S.lastHost.get(tid) || null, profile: letter, profileName: (letter && S.profName.get(letter)) || null, owned: S.owned.has(tid),
    title: trimTitle(S.lastTitle.get(tid)), profileDir: (ctx && S.ctxDir.get(ctx)) || (letter && S.profDir.get(letter)) || null, ctx, ...hint };
}
// account inside a profile, when the URL says it cheaply: YouTube channel id, Google multi-login index. Login pages -> login:true
function urlHints(url) {
  let u; try { u = new URL(url); } catch { return {}; }
  const r = {};
  const ch = u.pathname.match(/\/channel\/(UC[\w-]{22})(?:\/|$)/);
  if (ch && /(^|\.)youtube\.com$/i.test(u.hostname)) r.acct = 'channel:' + ch[1];
  else if (/(^|\.)google\.com$/i.test(u.hostname)) { const n = u.searchParams.get('authuser') || (u.pathname.match(/\/u\/(\d{1,2})(?:\/|$)/) || [])[1]; if (n != null && /^\d{1,2}$/.test(n)) r.acct = 'authuser:' + n; }
  if (/(^|\/)(login|log-in|signin|sign-in|sign_in|servicelogin|logon|oauth2?|sso)(\/|\.|$|\?)/i.test(u.pathname)) r.login = true;
  return r;
}
process.on('message', async m => {
  if (m && m.type === 'settings') {   // from server.js when the owner changes 설정 (no reconnect needed)
    if (Number(m.tabIdleDetachSec) > 0) SET.tabIdleDetachSec = Number(m.tabIdleDetachSec);
    if (['on-demand', 'all'].includes(m.attachMode)) {
      try { if (S.bcdp) await setMode(m.attachMode); else SET.attachMode = m.attachMode; } catch (e) { log(`attachMode switch failed: ${e.message}`); }
    }
    for (const [tid, e] of S.pages) scheduleDetach(tid, e);
    return;
  }
  if (!m || m.type !== 'cmd') return;
  const used = new Set();
  return CMD.run(used, async () => { try { await handle(m); } finally { release(used); } });
});
async function handle(m) {
  let meta = {}; const ctx = {};
  try {
    if (!commands[m.cmd]) throw new Error(`unknown command ${m.cmd}`);
    const data = await commands[m.cmd](m.args || {}, ctx);
    try { meta = await eventMeta(m.args, data); } catch {}
    try { if (ctx.inputs) Object.assign(meta, ctx.inputs()); } catch {}
    send({ type: 'reply', rid: m.rid, ok: true, data, meta });
  } catch (e) {
    try { meta = await eventMeta(m.args, null); } catch {}
    try { if (ctx.inputs) Object.assign(meta, ctx.inputs()); } catch {}   // what was entered before the error
    send({ type: 'reply', rid: m.rid, ok: false, error: e.message.split('\n').slice(0, 3).join(' | '), meta });
  }
}
process.on('disconnect', () => process.exit(0));   // parent gone -> drop CDP with us
process.on('unhandledRejection', e => log(`unhandledRejection: ${e && e.message}`));
// v11: an exception thrown later by a run script (e.g. inside its own setTimeout callback) must not kill the worker:
// that would drop the CDP connection (owner sees the allow prompt again) and abort other commands in flight.
process.on('uncaughtException', e => log(`uncaughtException (kept running): ${String(e && e.message).split(String.fromCharCode(10))[0].trim().slice(0, 200)}`));

(async () => {
  const t0 = Date.now();
  try {
    const transport = await openGate(endpoint, CONNECT_TIMEOUT);   // the one websocket (waits for the owner's allow click)
    const browser = await chromium.connectOverCDP(transport, { timeout: CONNECT_TIMEOUT, noDefaults: true });
    S.browser = browser;
    S.bcdp = await browser.newBrowserCDPSession();
    browser.on('disconnected', () => { send({ type: 'disconnected' }); setTimeout(() => process.exit(0), 100); });
    for (const ctx of browser.contexts()) { ctx.on('page', p => trackPage(p)); await Promise.all(ctx.pages().map(trackPage)); }
    // popups opened BY a tab while one of our commands runs on it (page.waitForEvent('popup') etc.).
    // Browser-level target notifications only; tabs the owner opens are never attached.
    S.bcdp.on('Target.targetCreated', ({ targetInfo: ti }) => {
      if (SET.attachMode === 'all' || ti.type !== 'page' || !ti.openerId) return;
      const op = S.pages.get(ti.openerId);
      if (!op || !op.busy) return;
      S.owned.add(ti.targetId);
      attach(ti.targetId).then(e => scheduleDetach(ti.targetId, e), e => log(`popup attach failed: ${e.message}`));
    });
    await S.bcdp.send('Target.setDiscoverTargets', { discover: true }).catch(e => log(`discover failed: ${e.message}`));
    log(`attachMode ${SET.attachMode}, tab idle detach ${SET.tabIdleDetachSec} s`);
    send({ type: 'connected', ms: Date.now() - t0, pages: S.pages.size });
  } catch (e) {
    send({ type: 'failed', ms: Date.now() - t0, refused: /ECONNREFUSED|connect ECONN/i.test(e.message), error: e.message.split('\n')[0] });
    setTimeout(() => process.exit(1), 100);
  }
})();
