/* Tabmate service worker: storage, pattern detection, and the runner.
   The runner drives a workflow one step at a time. For each step it picks the right tab
   (focusing it, or opening it), waits for the page, and asks that tab's content script to
   do the step. All data lives in chrome.storage (local + session). The only connection
   it ever opens is the optional Claude bridge on 127.0.0.1 (see bridge.js). */
importScripts('lib/shared.js', 'lib/learn.js', 'bridge.js');
const S = self.TabmateShared;
const L = self.TabmateLearn;

const LOG_CAP = 200;
const FINISHED_MEMORY_MS = 8000;
const lastActionTs = {};   // tabId -> ts of last click/submit (to tell typed navigations apart)
const lastFinished = {};   // tabId -> { runId, status, savedMs, reason, ts } for pages that reloaded at the end

/* ---------- storage helpers ---------- */
const local = chrome.storage.local;
const session = chrome.storage.session;

async function getAll() {
  const d = await local.get(['settings', 'workflows', 'history', 'log']);
  return {
    settings: Object.assign({ paused: false, blocked: [], bridge: false }, d.settings || {}),
    workflows: (d.workflows || []).map(L.migrate),
    history: Array.isArray(d.history) ? d.history : [],
    log: d.log || [],
  };
}

// Serialize every read-modify-write so quick events never clobber each other.
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

function addLog(log, entry) {
  log.unshift(Object.assign({ ts: Date.now() }, entry));
  if (log.length > LOG_CAP) log.length = LOG_CAP;
}

function siteOf(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|chrome-extension):$/.test(u.protocol)) return '';
    return u.host;
  } catch (e) { return ''; }
}

function watching(settings, site) {
  return !settings.paused && !!site && !settings.blocked.includes(site);
}

function publicWf(wf) {
  return { id: wf.id, name: wf.name, site: wf.site, sites: wf.sites, steps: wf.steps.length, loop: !!wf.loop };
}

function pushHistory(history, entry) {
  const prev = history[history.length - 1];
  if (prev && entry.ts - prev.ts > S.SESSION_GAP_MS) history.length = 0;
  history.push(entry);
  if (history.length > S.HISTORY_CAP) history.splice(0, history.length - S.HISTORY_CAP);
}

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- install ---------- */
chrome.runtime.onInstalled.addListener(async (details) => {
  const d = await local.get(['settings', 'bridgeToken']);
  if (!d.settings) await local.set({ settings: { paused: false, blocked: [], bridge: false }, workflows: [], history: [], log: [] });
  if (!d.bridgeToken) await local.set({ bridgeToken: randomToken() });
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// Tab switches and new tabs go on the timeline, so a workflow knows it crossed tabs.
chrome.tabs.onActivated.addListener(({ tabId }) => serial(async () => {
  const { settings, history } = await getAll();
  if (settings.paused || active) return;
  pushHistory(history, { kind: 'tab', tab: tabId, ts: Date.now() });
  await local.set({ history });
}));

chrome.tabs.onRemoved.addListener((tabId) => {
  if (active && Object.values(active.run.tabs).includes(tabId)) stopRun(active.run.id, 'error', 'A tab it needed was closed');
});

/* ---------- step sanitizing ---------- */
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const strList = (v, n, max) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, n)) : []);
const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);

function cleanSel(sel) {
  sel = sel || {};
  return {
    tag: str(sel.tag, 20), testid: str(sel.testid, 120), id: str(sel.id, 120), aria: str(sel.aria, 120),
    name: str(sel.name, 120), role: str(sel.role, 30), type: str(sel.type, 20), text: str(sel.text, 80),
    label: str(sel.label, 80), placeholder: str(sel.placeholder, 80), near: str(sel.near, 60), css: str(sel.css, 400),
    pos: sel.pos ? { x: num(sel.pos.x), y: num(sel.pos.y) } : null,
    shadow: strList(sel.shadow, 300, 5), frame: strList(sel.frame, 300, 5),
    shape: str(sel.shape, 80), anchor: str(sel.anchor, 200), ordinal: num(sel.ordinal),
  };
}

function cleanItem(it) {
  if (!it || typeof it !== 'object' || !it.list) return null;
  return {
    list: { key: str(it.list.key, 400), sel: cleanSel(it.list.sel) }, itemSel: str(it.itemSel, 80),
    index: num(it.index), count: num(it.count), cell: str(it.cell, 300), inner: str(it.inner, 300), isRow: !!it.isRow, generic: !!it.generic,
    rowKey: str(it.rowKey, 120), cells: strList(it.cells, 200, 12),
  };
}

function cleanStep(raw, site, tabId) {
  if (!raw || typeof raw !== 'object' || !L.ACT_KINDS.includes(raw.kind)) return null;
  const t = raw.target;
  const step = {
    kind: raw.kind, site, tab: tabId,
    target: t ? { key: str(t.key, 300), sel: cleanSel(t.sel) } : null,
    item: cleanItem(raw.item),
    label: str(raw.label, 60) || raw.kind,
    sensitive: !!raw.sensitive,
    value: null,
    path: str(raw.path, 300) || '/',
    url: str(raw.url, 1000),
    heading: str(raw.heading, 40),
    title: str(raw.title, 60),
    ts: Date.now(),
  };
  if (siteOf(step.url) !== site) return null;
  if (raw.kind === 'key') {
    const k = raw.keys || {};
    step.keys = { key: str(k.key, 30), code: str(k.code, 30), ctrl: !!k.ctrl, meta: !!k.meta, alt: !!k.alt, shift: !!k.shift };
  }
  if (raw.pasted) step.pasted = true;
  if (raw.editable) step.editable = true;
  if (!step.sensitive) {
    if (step.kind === 'check') step.value = !!raw.value;
    else if (['input', 'select', 'copy'].includes(step.kind)) step.value = str(raw.value, 2000);
    if (step.kind === 'select') step.valueLabel = str(raw.valueLabel, 60);
  } else if (step.item) step.item.cells = [];
  return step;
}

function readyFor(workflows, site, path) {
  return workflows.filter((w) => w.enabled && w.steps[0] && w.steps[0].site === site && w.steps[0].path === path).map(publicWf);
}

/* ---------- content messages ---------- */
async function onHello(msg, tabId, site) {
  const { settings, workflows, history } = await getAll();
  const on = watching(settings, site);
  const path = str(msg.path, 300);
  const out = { enabled: on, ready: on ? readyFor(workflows, site, path) : [] };
  if (!on) return out;
  const fin = lastFinished[tabId];
  if (fin && Date.now() - fin.ts < FINISHED_MEMORY_MS) { delete lastFinished[tabId]; out.finished = fin; return out; }
  if (active && Object.values(active.run.tabs).includes(tabId)) {
    out.running = { runId: active.run.id, index: active.run.index, total: active.wf.steps.length, rowLabel: rowLabel(active.run) };
    return out;
  }
  // A navigation the person typed or picked from history (not caused by a click) goes on the timeline.
  if ((msg.nav === 'navigate' || msg.nav === 'back_forward') && Date.now() - (lastActionTs[tabId] || 0) > 3000) {
    pushHistory(history, { kind: 'nav', site, tab: tabId, path, url: str(msg.url, 1000), ts: Date.now() });
    await local.set({ history });
  }
  return out;
}

async function onStep(msg, tabId, site) {
  const all = await getAll();
  if (!watching(all.settings, site)) return {};
  if (active) return {}; // never learn from (or during) Tabmate's own run
  const step = cleanStep(msg.step, site, tabId);
  if (!step) return {};
  if (step.kind === 'click' || step.kind === 'submit') lastActionTs[tabId] = step.ts;
  pushHistory(all.history, step);
  const acts = all.history.filter((s) => L.ACT_KINDS.includes(s.kind));

  const trig = L.triggered(acts, all.workflows);
  if (trig) {
    all.history.length = 0;
    addLog(all.log, { type: 'start', site, workflowId: trig.wf.id, text: 'Took over: ' + trig.wf.name });
    await local.set({ history: all.history, log: all.log });
    startRun(trig.wf, { via: 'auto', from: trig.index, tail: trig.tail });
    return {};
  }

  const found = L.detect(acts, all.workflows, Date.now());
  const out = {};
  if (found) {
    const text = 'Learned: ' + found.wf.name + ' (' + found.wf.steps.length + ' steps)';
    if (found.created) addLog(all.log, { type: 'learned', site, workflowId: found.wf.id, text });
    else if (all.log[0] && all.log[0].workflowId === found.wf.id && all.log[0].type === 'learned') all.log[0].text = text;
    out.learned = publicWf(found.wf);
    out.ready = readyFor(all.workflows, site, step.path);
  }
  await local.set(found ? { history: all.history, workflows: all.workflows, log: all.log } : { history: all.history });
  if (found) bridgeChanged();
  return out;
}

async function onRunStartFromPill(msg, tabId, site) {
  const { settings, workflows } = await getAll();
  const wf = workflows.find((w) => w.id === msg.workflowId);
  if (!wf || !wf.enabled || wf.steps[0].site !== site || !watching(settings, site)) return {};
  const r = startRun(wf, { via: 'pill', tabId });
  return r.error ? { error: r.error } : { ok: true };
}

// The onboarding practice: "Watch me do it" runs the sandbox workflow just learned, in the same tab.
// Only the sandbox pages can ask, and only for a workflow that lives on the sandbox.
async function onGuideRun(tabId, site) {
  const { settings, workflows, log } = await getAll();
  const wf = workflows.filter((w) => w.enabled && w.steps[0] && w.steps[0].site === site).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!wf || !watching(settings, site)) return { error: 'none' };
  const r = startRun(wf, { via: 'guide', tabId });
  if (r.error) return { error: r.error };
  addLog(log, { type: 'start', site, workflowId: wf.id, text: 'Started: ' + wf.name });
  await local.set({ log });
  return { ok: true, runId: r.runId };
}

// "Undo" on the Learned toast: forget a workflow learned a moment ago on this same site, and the steps that taught it.
async function onUndoLearned(msg, tabId, site) {
  const all = await getAll();
  const wf = all.workflows.find((w) => w.id === msg.workflowId);
  if (!wf || wf.site !== site || Date.now() - (wf.updatedAt || 0) > 5 * 60 * 1000) return { ready: readyFor(all.workflows, site, '') };
  all.workflows = all.workflows.filter((w) => w.id !== wf.id);
  all.history.length = 0;
  addLog(all.log, { type: 'deleted', site, workflowId: wf.id, text: 'Undid: ' + wf.name });
  await local.set({ workflows: all.workflows, history: all.history, log: all.log });
  bridgeChanged();
  return { ready: [] };
}

function onProgress(msg) {
  if (active && active.run.id === msg.runId && Number.isFinite(msg.acted)) {
    active.run.acted = Math.max(active.run.acted, msg.acted);
    saveRun();
  }
  return {};
}

async function onNeeds(msg) {
  if (!active || active.run.id !== msg.runId) return {};
  const { log } = await getAll();
  active.run.waiting = { index: msg.index, label: str(msg.label, 60), reason: msg.reason === 'sensitive' ? 'sensitive' : 'risky' };
  addLog(log, { type: 'needs', site: active.wf.site, workflowId: active.wf.id, text: 'Waited for you: ' + str(msg.label, 60) + (msg.reason === 'sensitive' ? ' (private field)' : ' (needs your OK)') });
  await local.set({ log });
  return {};
}

/* ================================================================
   RUNNER
   ================================================================ */
let active = null; // { run, wf, waiters: [], stop: null | { status, reason }, wake: fn }
let keepAlive = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveRun() {
  if (!active) return session.set({ runs: {} });
  const r = active.run;
  return session.set({ runs: { [r.id]: { workflowId: r.workflowId, index: r.index, from: r.from, via: r.via, startedAt: r.startedAt, tabs: r.tabs, row: r.rowNumber } } });
}

function rowLabel(run) {
  return run && run.loop ? run.rowNumber : 0;
}

// Starts a run. Returns { promise } resolving to the run result, or { error }.
function startRun(wf, opts) {
  if (active) return { error: 'busy' };
  const run = {
    id: 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    workflowId: wf.id, index: opts.from || 0, from: opts.from || 0, via: opts.via, startedAt: Date.now(),
    tabs: {}, rows: {}, copies: {}, cells: {}, inputs: opts.inputs || {}, acted: -1,
    loop: !!wf.loop, rowNumber: 1, rowsDone: 0, maxRows: opts.maxRows || 200, copied: [], tabsUsed: [],
    preferTab: opts.tabId || null,
  };
  // The steps the person already did seed the run: their tabs, rows and copied text.
  (opts.tail || []).forEach((st, i) => {
    run.tabs[wf.steps[i].tabRef || 0] = st.tab;
    if (st.item && st.item.generic) {
      run.rows[L.listKey(st.item)] = st.item.index;
      run.cells[i] = st.item.cells || [];
      if (st.item.rowKey && i === (wf.lists[wf.source] || {}).firstStep) run.rowKey = st.item.rowKey;
    }
    if (st.kind === 'copy') run.copies[i] = st.value;
  });
  if (opts.tabId && run.tabs[0] == null) run.tabs[0] = opts.tabId;
  active = { run, wf, waiters: [], stop: null };
  const promise = new Promise((resolve) => active.waiters.push(resolve));
  keepAlive = keepAlive || setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  saveRun();
  const a = active;
  drive(a).catch(() => finishRun(a, 'error', 'Something went wrong'));
  return { promise, runId: run.id };
}

function stopRun(runId, status, reason) {
  if (!active || (runId && active.run.id !== runId)) return false;
  active.stop = { status, reason };
  if (active.wake) active.wake();
  return true;
}

/* ---------- tabs ---------- */
async function getTab(id) {
  return id == null ? null : chrome.tabs.get(id).catch(() => null);
}

async function tabForStep(run, step) {
  const ref = step.tabRef || 0;
  const known = await getTab(run.tabs[ref]);
  if (known) return known;
  const taken = new Set(Object.values(run.tabs));
  const all = await chrome.tabs.query({});
  const fits = all.filter((t) => !taken.has(t.id) && siteOf(t.url || '') === step.site);
  const pathOf = (t) => { try { return S.pathPattern(new URL(t.url).pathname); } catch (e) { return ''; } };
  const tab = fits.find((t) => t.id === run.preferTab) || fits.find((t) => t.active && pathOf(t) === step.path) ||
    fits.find((t) => pathOf(t) === step.path) || fits.find((t) => t.active) || fits[0];
  if (tab) { run.tabs[ref] = tab.id; return tab; }
  const created = await chrome.tabs.create({ url: step.url, active: true });
  run.tabs[ref] = created.id;
  run.opened = (run.opened || 0) + 1;
  return created;
}

async function waitTab(tabId, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await getTab(tabId);
    if (!t) return null;
    if (test(t)) return t;
    await sleep(100);
  }
  return null;
}

function onStepPage(t, step) {
  try { return siteOf(t.url) === step.site && S.pathPattern(new URL(t.url).pathname) === step.path; } catch (e) { return false; }
}

async function ping(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'ping' }); } catch (e) { return null; }
}

// Focus the tab, make sure it shows the step's page, and that Tabmate is loaded there.
async function prepareTab(a, tab, step) {
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  // A click just before this step may still be loading the next page.
  let t = await waitTab(tab.id, (x) => onStepPage(x, step) && x.status === 'complete', 3000);
  if (!t) {
    const now = await getTab(tab.id);
    if (!now) return 'A tab it needed was closed';
    if (!onStepPage(now, step)) await chrome.tabs.update(tab.id, { url: step.url });
    t = await waitTab(tab.id, (x) => onStepPage(x, step) && x.status === 'complete', 20000);
    if (!t) return 'Can’t open the next page';
  }
  const until = Date.now() + 6000;
  let injected = false;
  while (Date.now() < until && !a.stop) {
    const p = await ping(tab.id);
    if (p && p.ok && p.path === step.path) return '';
    if (!p && !injected && Date.now() > until - 4500 && /^https?:/.test(t.url || '')) {
      injected = true;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/shared.js', 'lib/finder.js', 'content.js'] }).catch(() => {});
    }
    await sleep(120);
  }
  return a.stop ? '' : 'Tabmate isn’t loaded on that page';
}

// Send one step. A click that unloads the page closes the channel: that still counts as done.
function execInTab(a, tabId, payload) {
  return new Promise((resolve) => {
    a.wake = () => resolve({ status: 'stopped' });
    chrome.tabs.sendMessage(tabId, payload)
      .then((res) => resolve(res || { status: 'gone' }))
      .catch(() => resolve({ status: 'gone' }));
  }).finally(() => { a.wake = null; });
}

/* ---------- the loop ---------- */
async function drive(a) {
  const { run, wf } = a;
  const n = wf.steps.length;
  const { settings } = await getAll();
  if (wf.loop && run.from === 0) {
    const first = await nextSourceRow(a, null);
    if (first == null) return finishRun(a, 'done', '', 'Nothing new to do');
    if (first.error) return finishRun(a, 'error', first.error);
  }
  for (;;) {
    if (a.stop) return finishRun(a, a.stop.status, a.stop.reason);
    if (run.index >= n) {
      run.rowsDone++;
      if (run.rowKey) L.rememberDone(wf, run.rowKey);
      if (!wf.loop || run.rowsDone >= run.maxRows) return finishRun(a, 'done');
      const next = await nextSourceRow(a, run.rows[wf.source]);
      if (next == null) return finishRun(a, 'done');
      if (next.error) return finishRun(a, 'error', next.error);
      run.index = 0;
      run.rowNumber++;
      continue;
    }
    const step = wf.steps[run.index];
    if (!watching(settings, step.site)) return finishRun(a, 'error', 'Tabmate is off on ' + S.siteLabel(step.site));
    const tab = await tabForStep(run, step);
    if (!run.tabsUsed.includes(tab.id)) run.tabsUsed.push(tab.id);
    const problem = await prepareTab(a, tab, step);
    if (a.stop) continue;
    if (problem) return finishRun(a, 'error', problem);

    const value = ['input', 'select', 'check'].includes(step.kind) ? L.valueFor(step, run) : null;
    if (value === null && ['input', 'select'].includes(step.kind) && !step.sensitive) return finishRun(a, 'error', 'Missing the copied text for “' + step.label + '”');
    const row = L.rowFor(step, wf, run);
    const payload = { type: 'exec', runId: run.id, index: run.index, total: n, step, value, row, rowLabel: rowLabel(run) };
    const res = await execInTab(a, tab.id, payload);
    if (a.stop) continue;
    if (res.status === 'gone') {
      if (run.acted >= run.index) { run.index++; saveRun(); continue; }
      return finishRun(a, 'error', 'The page changed before Tabmate could act');
    }
    if (res.status === 'stopped') return finishRun(a, 'stopped');
    if (res.status !== 'ok') {
      // The list ran out of rows partway through a loop: the work is done.
      if (res.missingRow && wf.loop && run.rowsDone > 0) return finishRun(a, 'done');
      return finishRun(a, 'error', str(res.reason, 80) || 'Something changed on the page');
    }
    if (step.kind === 'copy') { run.copies[run.index] = str(res.copied, 2000); run.copied.push(run.copies[run.index]); }
    if (step.item && step.item.generic) {
      run.cells[run.index] = strList(res.cells, 200, 12);
      if (run.index === (wf.lists[wf.source] || {}).firstStep) run.rowKey = str(res.rowKey, 120);
      if (row !== null && row !== 'last') run.rows[L.listKey(step.item)] = row;
    }
    run.index++;
    saveRun();
  }
}

// Moves the source list to its next new row and the other moving lists along with it.
async function nextSourceRow(a, from) {
  const { run, wf } = a;
  const src = wf.lists[wf.source];
  const step = wf.steps[src.firstStep];
  const tab = await tabForStep(run, step);
  const problem = await prepareTab(a, tab, step);
  if (problem) return { error: problem };
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'list-rows', item: step.item }).catch(() => null);
  const keys = res && res.keys;
  if (!keys) return null;
  const i = L.nextRow(keys, from, src.stride, wf.doneKeys);
  if (i < 0) return null;
  run.rows[wf.source] = i;
  run.rowKey = keys[i];
  for (const [k, list] of Object.entries(wf.lists)) {
    if (k === wf.source || list.mode !== 'step') continue;
    run.rows[k] = (run.rows[k] == null ? list.lastIndex : run.rows[k]) + list.stride;
  }
  run.copies = {};
  run.cells = {};
  return i;
}

async function finishRun(a, status, reason, note) {
  if (!a || active !== a) return;
  const { run } = a;
  active = null;
  clearInterval(keepAlive);
  keepAlive = null;
  await session.set({ runs: {} });
  const out = await serial(async () => {
    const { workflows, log } = await getAll();
    const wf = workflows.find((w) => w.id === run.workflowId);
    const res = { status, reason: reason || '', note: note || '', steps: run.index, rows: run.rowsDone, copied: run.copied.slice(0, 50), savedMs: 0 };
    if (!wf) return res;
    wf.lastRunAt = Date.now();
    for (const [k, list] of Object.entries(wf.lists || {})) if (run.rows[k] != null) list.lastIndex = run.rows[k];
    wf.doneKeys = a.wf.doneKeys;
    if (status === 'done') {
      // Saved time: the steps Tabmate did, as a share of how long the person took by hand.
      const n = wf.steps.length;
      const did = Math.max(0, run.rowsDone * n - Math.min(run.from || 0, n));
      const saved = Math.round((wf.manualMs || 0) * did / n);
      if (run.rowsDone || !wf.loop) wf.runs += 1;
      wf.savedMs += saved;
      res.savedMs = saved;
      addLog(log, { type: 'done', site: wf.site, workflowId: wf.id, savedMs: saved, name: wf.name, text: (note ? note + ': ' : 'Did it for you: ') + wf.name + (wf.loop ? ' · ' + run.rowsDone + ' rows' : '') + ' · saved ' + S.formatSaved(saved) });
    } else if (status === 'stopped') {
      addLog(log, { type: 'stopped', site: wf.site, workflowId: wf.id, text: 'You stopped: ' + wf.name });
    } else {
      addLog(log, { type: 'error', site: wf.site, workflowId: wf.id, text: 'Stopped: ' + wf.name + (reason ? ' · ' + str(reason, 80) : '') });
    }
    await local.set({ workflows, log, history: [] });
    return res;
  });
  const ended = { type: 'run-ended', runId: run.id, status, savedMs: out.savedMs, reason: reason || '' };
  for (const tabId of run.tabsUsed) {
    lastFinished[tabId] = Object.assign({ ts: Date.now() }, ended);
    chrome.tabs.sendMessage(tabId, ended).then(() => { delete lastFinished[tabId]; }, () => {});
  }
  const last = await getTab(run.tabsUsed[run.tabsUsed.length - 1]);
  if (last) Object.assign(out, { url: last.url, title: last.title });
  a.waiters.forEach((w) => w(out));
}

/* ---------- popup / options actions ---------- */
async function onAdmin(msg) {
  const all = await getAll();
  const wf = msg.workflowId ? all.workflows.find((w) => w.id === msg.workflowId) : null;
  switch (msg.type) {
    case 'set-paused':
      all.settings.paused = !!msg.paused;
      addLog(all.log, { type: 'settings', text: msg.paused ? 'Paused everywhere' : 'Resumed' });
      if (msg.paused) stopRun(null, 'stopped');
      break;
    case 'set-site-watch': {
      const site = str(msg.site, 300);
      if (!site) return {};
      const set = new Set(all.settings.blocked);
      if (msg.on) set.delete(site); else set.add(site);
      all.settings.blocked = [...set];
      break;
    }
    case 'set-bridge':
      all.settings.bridge = !!msg.on;
      addLog(all.log, { type: 'settings', text: msg.on ? 'Claude can run your workflows' : 'Claude disconnected' });
      break;
    case 'toggle-workflow':
      if (!wf) return {};
      wf.enabled = !!msg.enabled;
      break;
    case 'delete-workflow':
      if (!wf) return {};
      all.workflows = all.workflows.filter((w) => w.id !== wf.id);
      addLog(all.log, { type: 'deleted', site: wf.site, text: 'Deleted: ' + wf.name });
      break;
    case 'clear-log':
      all.log = [];
      break;
    case 'stop-run':
      stopRun(null, 'stopped');
      return { ok: true };
    case 'run-now': {
      if (!wf || !wf.enabled || !watching(all.settings, wf.steps[0].site)) return { ok: false, reason: 'off' };
      const tab = await getTab(Number(msg.tabId));
      const r = startRun(wf, { via: 'popup', tabId: tab && siteOf(tab.url || '') === wf.steps[0].site ? tab.id : null });
      if (r.error) return { ok: false, reason: r.error };
      addLog(all.log, { type: 'start', site: wf.site, workflowId: wf.id, text: 'Started: ' + wf.name });
      await local.set({ log: all.log });
      return { ok: true };
    }
    default:
      return {};
  }
  await local.set({ settings: all.settings, workflows: all.workflows, log: all.log });
  if (msg.type === 'set-bridge') bridgeSync();
  if (['toggle-workflow', 'delete-workflow'].includes(msg.type)) bridgeChanged();
  return { ok: true };
}

/* ---------- what the Claude bridge can ask for ---------- */
async function toolsForClaude() {
  const { workflows } = await getAll();
  const taken = new Set();
  return workflows.filter((w) => w.enabled).map((wf) => Object.assign(L.toTool(wf, taken), { id: wf.id, sites: wf.sites, loop: !!wf.loop }));
}

async function runForClaude(params) {
  const { workflows, settings, log } = await getAll();
  const tools = await toolsForClaude();
  const want = str(params && params.workflow, 200);
  const tool = tools.find((t) => t.name === want || t.id === want || t.description.startsWith(want + '.'));
  if (!tool) return { status: 'error', reason: 'No learned workflow called “' + want + '”. Call list_workflows to see them.' };
  const wf = workflows.find((w) => w.id === tool.id);
  const blocked = wf.sites.find((s) => !watching(settings, s));
  if (blocked) return { status: 'error', reason: 'Tabmate is paused or off on ' + S.siteLabel(blocked) + '.' };
  const inputs = {};
  const raw = (params && params.inputs) || {};
  for (const [k, spec] of Object.entries(tool.inputSchema.properties)) {
    if (!(k in raw) || k === 'max_rows') continue;
    inputs[k] = spec.type === 'boolean' ? !!raw[k] : str(String(raw[k]), 2000);
  }
  const maxRows = Math.min(500, Math.max(1, Number(raw.max_rows || params.max_rows) || 200));
  const r = startRun(wf, { via: 'claude', inputs, maxRows });
  if (r.error) return { status: 'error', reason: 'Tabmate is already running a workflow. Try again when it is done.' };
  addLog(log, { type: 'start', site: wf.site, workflowId: wf.id, text: 'Claude started: ' + wf.name });
  await local.set({ log });
  const waitMs = Math.min(600000, Math.max(5000, Number(params && params.wait_ms) || 110000));
  const timeout = sleep(waitMs).then(() => ({ status: 'running', reason: active && active.run.waiting ? 'Waiting for the person: ' + active.run.waiting.label : 'Still running in Chrome' }));
  const res = await Promise.race([r.promise, timeout]);
  return Object.assign({ workflow: tool.name }, res);
}

/* ---------- message routing ---------- */
const CONTENT = { hello: onHello, step: onStep, 'run-start': onRunStartFromPill, needs: onNeeds, 'undo-learned': onUndoLearned };
const ADMIN_TYPES = ['set-paused', 'set-site-watch', 'set-bridge', 'toggle-workflow', 'delete-workflow', 'clear-log', 'run-now', 'stop-run'];
const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id + '/';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const fromExtPage = (sender.url || '').startsWith(EXT_ORIGIN) && !/\/sandbox\//.test(sender.url);
  let job;
  if (sender.tab && (CONTENT[msg.type] || ['progress', 'run-stop', 'open-updates', 'guide-run'].includes(msg.type))) {
    const tabId = sender.tab.id;
    const site = siteOf(sender.url || sender.tab.url || ''); // never trust a site name sent in the message
    if (!site) return false;
    if (msg.type === 'open-updates') { chrome.tabs.create({ url: S.UPDATES_URL }); return false; }
    if (msg.type === 'run-stop') {
      if (active && Object.values(active.run.tabs).includes(tabId)) stopRun(msg.runId, 'stopped');
      sendResponse({});
      return false;
    }
    if (msg.type === 'progress') { sendResponse(onProgress(msg)); return false; }
    if (msg.type === 'guide-run') {
      if (!/\/sandbox\//.test(sender.url || '') || !(sender.url || '').startsWith(EXT_ORIGIN)) return false;
      job = serial(() => onGuideRun(tabId, site));
      job.then((r) => sendResponse(r || {}), () => sendResponse({}));
      return true;
    }
    job = serial(() => CONTENT[msg.type](msg, tabId, site));
  } else if (ADMIN_TYPES.includes(msg.type) && fromExtPage) {
    job = serial(() => onAdmin(msg));
  } else if (msg.type === 'bridge-status' && fromExtPage) {
    sendResponse(bridgeStatus());
    return false;
  } else return false;
  job.then((r) => sendResponse(r || {}), () => sendResponse({}));
  return true;
});

bridgeInit({ tools: toolsForClaude, run: runForClaude });
