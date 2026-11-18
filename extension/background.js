/* Tabmate service worker: storage, pattern detection, run state.
   All data lives in chrome.storage.local (workflows, history, log, settings)
   and chrome.storage.session (active runs). No network calls. */
importScripts('lib/shared.js');
const S = self.TabmateShared;

const LOG_CAP = 200;
const lastActionTs = {}; // tabId -> ts of last click/submit (to tell typed navigations apart)

/* ---------- storage helpers ---------- */
const local = chrome.storage.local;
const session = chrome.storage.session;

async function getAll() {
  const d = await local.get(['settings', 'workflows', 'history', 'log']);
  return {
    settings: Object.assign({ paused: false, blocked: [] }, d.settings || {}),
    workflows: d.workflows || [],
    history: d.history || {},
    log: d.log || [],
  };
}
async function getRuns() { return (await session.get('runs')).runs || {}; }
async function setRuns(runs) { await session.set({ runs }); }

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
  return { id: wf.id, name: wf.name, site: wf.site, steps: wf.steps.length };
}

/* ---------- install ---------- */
chrome.runtime.onInstalled.addListener(async (details) => {
  const d = await local.get(['settings']);
  if (!d.settings) await local.set({ settings: { paused: false, blocked: [] }, workflows: [], history: {}, log: [] });
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  const runs = await getRuns();
  if (runs[tabId]) { delete runs[tabId]; await setRuns(runs); }
}));

/* ---------- step sanitizing ---------- */
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function cleanStep(raw, site) {
  if (!raw || typeof raw !== 'object') return null;
  const kinds = ['click', 'input', 'select', 'check', 'submit'];
  if (!kinds.includes(raw.kind)) return null;
  const t = raw.target || {};
  const sel = t.sel || {};
  const step = {
    kind: raw.kind,
    target: {
      key: str(t.key, 300),
      sel: {
        tag: str(sel.tag, 20), testid: str(sel.testid, 120), id: str(sel.id, 120), aria: str(sel.aria, 120),
        name: str(sel.name, 120), role: str(sel.role, 30), text: str(sel.text, 80), css: str(sel.css, 400),
      },
    },
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
  if (!step.sensitive) {
    if (step.kind === 'check') step.value = !!raw.value;
    else if (step.kind === 'input' || step.kind === 'select') step.value = str(raw.value, 2000);
    if (step.kind === 'select') step.valueLabel = str(raw.valueLabel, 60);
  }
  return step;
}

/* ---------- pattern detection ---------- */
function makeName(steps, site) {
  const act = steps.find((s) => s.kind === 'click' || s.kind === 'submit') || steps[0];
  let verb = (act.label || 'Run').replace(/[“”"]/g, '').trim();
  if (verb.length > 28) verb = verb.slice(0, 28).trim() + '…';
  const noun = (steps[0].heading || '').trim();
  const nounOk = noun && noun.split(/\s+/).length <= 3 && !verb.toLowerCase().includes(noun.toLowerCase().replace(/s$/, ''));
  return verb + (nounOk ? ' ' + noun.toLowerCase() : '') + ' on ' + S.siteLabel(site);
}

function containedIn(seq, wfSteps) {
  const loop = wfSteps.concat(wfSteps);
  for (let i = 0; i + seq.length <= loop.length; i++) {
    if (S.sameSeq(seq, loop.slice(i, i + seq.length))) return true;
  }
  return false;
}

// Returns { wf, created } when the latest steps repeat an earlier run.
function detect(acts, workflows, site) {
  const n = acts.length;
  let match = null;
  for (let k = Math.min(S.MAX_STEPS, Math.floor(n / 2)); k >= S.MIN_STEPS && !match; k--) {
    const suffix = acts.slice(n - k);
    for (let j = n - 2 * k; j >= 0; j--) {
      if (S.sameSeq(acts.slice(j, j + k), suffix)) { match = { suffix, earlier: acts.slice(j, j + k) }; break; }
    }
  }
  if (!match) return null;
  const cand = match.suffix;
  const siteWfs = workflows.filter((w) => w.site === site);
  const dur = (seq) => Math.max(2000, seq[seq.length - 1].ts - seq[0].ts + 2000);
  const manualMs = Math.round((dur(match.suffix) + dur(match.earlier)) / 2);

  // Longer version of a workflow we already know: extend it.
  const base = siteWfs.find((w) => w.steps.length < cand.length && S.sameSeq(w.steps, cand.slice(0, w.steps.length)));
  if (base) {
    base.steps = cand;
    base.manualMs = manualMs;
    base.name = makeName(cand, site);
    base.updatedAt = Date.now();
    return { wf: base, created: false };
  }
  if (siteWfs.some((w) => containedIn(cand, w.steps))) return null;

  const wf = {
    id: 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    site, name: makeName(cand, site), steps: cand, enabled: true,
    runs: 0, savedMs: 0, manualMs, createdAt: Date.now(), updatedAt: Date.now(), lastRunAt: 0,
  };
  workflows.push(wf);
  return { wf, created: true };
}

// Did the person just start a learned workflow by hand?
function triggered(acts, workflows, site) {
  let best = null;
  for (const wf of workflows) {
    if (wf.site !== site || !wf.enabled || wf.steps.length < S.MIN_STEPS) continue;
    const p = wf.steps.length >= 4 ? 2 : 1;
    const tail = acts.slice(-p);
    if (tail.length < p) continue;
    if (tail.some((s) => s.ts <= wf.createdAt || s.ts <= (wf.lastRunAt || 0))) continue;
    if (tail[tail.length - 1].ts - tail[0].ts > 10 * 60 * 1000) continue;
    if (!S.sameSeq(tail, wf.steps.slice(0, p))) continue;
    if (!best || wf.steps.length > best.wf.steps.length) best = { wf, index: p };
  }
  return best;
}

function readyFor(workflows, site, path) {
  return workflows.filter((w) => w.site === site && w.enabled && w.steps[0] && w.steps[0].path === path).map(publicWf);
}

/* ---------- message handlers ---------- */
async function onHello(msg, tabId, site) {
  const { settings, workflows, history } = await getAll();
  const on = watching(settings, site);
  const path = str(msg.path, 300);
  const out = { enabled: on, ready: on ? readyFor(workflows, site, path) : [] };
  if (!on) return out;

  const runs = await getRuns();
  const run = runs[tabId];
  if (run) {
    const wf = workflows.find((w) => w.id === run.workflowId);
    if (wf && wf.site === site && run.index >= wf.steps.length) {
      // The last step was done (by the person, after a "Needs you") and loaded a new page.
      const r = await onRunEnd({ status: 'done' }, tabId);
      out.finished = r.savedMs || 0;
      return out;
    }
    if (wf && wf.site === site && run.index < wf.steps.length) {
      out.run = run;
      out.workflow = wf;
      return out;
    }
    delete runs[tabId];
    await setRuns(runs);
  }

  // A navigation the person typed or picked from history (not caused by a click) is recorded as a step.
  if ((msg.nav === 'navigate' || msg.nav === 'back_forward') && Date.now() - (lastActionTs[tabId] || 0) > 3000) {
    const h = history[site] || [];
    h.push({ kind: 'nav', path, url: str(msg.url, 1000), title: str(msg.title, 60), ts: Date.now() });
    if (h.length > S.HISTORY_CAP) h.splice(0, h.length - S.HISTORY_CAP);
    history[site] = h;
    await local.set({ history });
  }
  return out;
}

async function onStep(msg, tabId, site) {
  const all = await getAll();
  if (!watching(all.settings, site)) return {};
  const runs = await getRuns();
  if (runs[tabId]) return {}; // never learn from Tabmate's own actions
  const step = cleanStep(msg.step, site);
  if (!step) return {};
  if (step.kind === 'click' || step.kind === 'submit') lastActionTs[tabId] = step.ts;

  const h = all.history[site] || [];
  const prev = h[h.length - 1];
  if (prev && step.ts - prev.ts > S.SESSION_GAP_MS) h.length = 0;
  h.push(step);
  if (h.length > S.HISTORY_CAP) h.splice(0, h.length - S.HISTORY_CAP);
  all.history[site] = h;
  const acts = h.filter((s) => s.kind !== 'nav');

  const out = {};
  const trig = triggered(acts, all.workflows, site);
  if (trig) {
    const run = { workflowId: trig.wf.id, index: trig.index, from: trig.index, startedAt: Date.now(), via: 'auto' };
    runs[tabId] = run;
    await setRuns(runs);
    all.history[site] = [];
    addLog(all.log, { type: 'start', site, workflowId: trig.wf.id, text: 'Took over: ' + trig.wf.name });
    await local.set({ history: all.history, log: all.log });
    out.run = run;
    out.workflow = trig.wf;
    return out;
  }

  const found = detect(acts, all.workflows, site);
  if (found) {
    if (found.created) addLog(all.log, { type: 'learned', site, workflowId: found.wf.id, text: 'Learned: ' + found.wf.name + ' (' + found.wf.steps.length + ' steps)' });
    else if (all.log[0] && all.log[0].workflowId === found.wf.id && all.log[0].type === 'learned') all.log[0].text = 'Learned: ' + found.wf.name + ' (' + found.wf.steps.length + ' steps)';
    out.learned = publicWf(found.wf);
    out.ready = readyFor(all.workflows, site, step.path);
  }
  await local.set(found ? { history: all.history, workflows: all.workflows, log: all.log } : { history: all.history });
  return out;
}

async function startRun(tabId, wf, index, via) {
  const runs = await getRuns();
  const run = { workflowId: wf.id, index, from: index, startedAt: Date.now(), via };
  runs[tabId] = run;
  await setRuns(runs);
  const { history, log } = await getAll();
  history[wf.site] = [];
  addLog(log, { type: 'start', site: wf.site, workflowId: wf.id, text: 'Started: ' + wf.name });
  await local.set({ history, log });
  return run;
}

async function onRunStart(msg, tabId, site) {
  const { settings, workflows } = await getAll();
  const wf = workflows.find((w) => w.id === msg.workflowId);
  if (!wf || wf.site !== site || !wf.enabled || !watching(settings, site)) return {};
  const run = await startRun(tabId, wf, 0, 'pill');
  return { run, workflow: wf };
}

async function onProgress(msg, tabId) {
  const runs = await getRuns();
  if (!runs[tabId]) return {};
  const i = Number(msg.index);
  if (Number.isFinite(i) && i >= 0) runs[tabId].index = i;
  await setRuns(runs);
  return { ok: true };
}

async function onNeeds(msg, tabId) {
  const runs = await getRuns();
  const run = runs[tabId];
  if (!run) return {};
  const { workflows, log } = await getAll();
  const wf = workflows.find((w) => w.id === run.workflowId);
  if (!wf) return {};
  addLog(log, { type: 'needs', site: wf.site, workflowId: wf.id, text: 'Waited for you: ' + str(msg.label, 60) + (msg.reason === 'sensitive' ? ' (private field)' : ' (needs your OK)') });
  await local.set({ log });
  return {};
}

async function onRunEnd(msg, tabId) {
  const runs = await getRuns();
  const run = runs[tabId];
  if (!run) return {};
  delete runs[tabId];
  await setRuns(runs);
  const { workflows, history, log } = await getAll();
  const wf = workflows.find((w) => w.id === run.workflowId);
  if (!wf) return {};
  history[wf.site] = [];
  wf.lastRunAt = Date.now();
  const out = {};
  if (msg.status === 'done') {
    // Saved time: the steps Tabmate did, as a share of how long the person took by hand.
    const share = (wf.steps.length - Math.min(run.from || 0, wf.steps.length)) / wf.steps.length;
    const saved = Math.round((wf.manualMs || 0) * Math.max(share, 0));
    wf.runs += 1;
    wf.savedMs += saved;
    out.savedMs = saved;
    addLog(log, { type: 'done', site: wf.site, workflowId: wf.id, text: 'Did it for you: ' + wf.name + ' · saved ' + S.formatSaved(saved) });
  } else if (msg.status === 'stopped') {
    addLog(log, { type: 'stopped', site: wf.site, workflowId: wf.id, text: 'You stopped: ' + wf.name });
  } else {
    addLog(log, { type: 'error', site: wf.site, workflowId: wf.id, text: 'Stopped: ' + wf.name + (msg.reason ? ' · ' + str(msg.reason, 80) : '') });
  }
  await local.set({ workflows, history, log });
  return out;
}

/* ---------- popup / options actions ---------- */
async function injectIfNeeded(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'refresh' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/shared.js', 'content.js'] });
      return true;
    } catch (err) { return false; }
  }
}

async function onAdmin(msg) {
  const all = await getAll();
  const wf = msg.workflowId ? all.workflows.find((w) => w.id === msg.workflowId) : null;
  switch (msg.type) {
    case 'set-paused':
      all.settings.paused = !!msg.paused;
      addLog(all.log, { type: 'settings', text: msg.paused ? 'Paused everywhere' : 'Resumed' });
      break;
    case 'set-site-watch': {
      const site = str(msg.site, 300);
      if (!site) return {};
      const set = new Set(all.settings.blocked);
      if (msg.on) set.delete(site); else set.add(site);
      all.settings.blocked = [...set];
      break;
    }
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
    case 'run-now': {
      if (!wf || !wf.enabled || !watching(all.settings, wf.site)) return { ok: false, reason: 'off' };
      const tabId = Number(msg.tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { ok: false };
      const start = wf.steps[0];
      if (siteOf(start.url) !== wf.site) return { ok: false };
      const run = await startRun(tabId, wf, 0, 'popup');
      const here = siteOf(tab.url || '') === wf.site && S.pathPattern(new URL(tab.url).pathname) === start.path;
      if (here && (await injectIfNeeded(tabId))) {
        chrome.tabs.sendMessage(tabId, { type: 'run', run, workflow: wf }).catch(() => {});
      } else {
        await chrome.tabs.update(tabId, { url: start.url });
      }
      return { ok: true };
    }
    default:
      return {};
  }
  await local.set({ settings: all.settings, workflows: all.workflows, log: all.log });
  return { ok: true };
}

const CONTENT_TYPES = ['hello', 'step', 'run-start', 'progress', 'needs', 'run-end', 'open-updates'];
const ADMIN_TYPES = ['set-paused', 'set-site-watch', 'toggle-workflow', 'delete-workflow', 'clear-log', 'run-now'];
const EXT_ORIGIN = 'chrome-extension://' + chrome.runtime.id + '/';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const fromExtPage = (sender.url || '').startsWith(EXT_ORIGIN);
  let job;
  if (CONTENT_TYPES.includes(msg.type) && sender.tab) {
    const tabId = sender.tab.id;
    const site = siteOf(sender.url || sender.tab.url || ''); // never trust a site name sent in the message
    if (!site) return false;
    if (msg.type === 'open-updates') { chrome.tabs.create({ url: S.UPDATES_URL }); return false; }
    const fn = { hello: onHello, step: onStep, 'run-start': onRunStart, progress: onProgress, needs: onNeeds, 'run-end': onRunEnd }[msg.type];
    job = serial(() => fn(msg, tabId, site));
  } else if (ADMIN_TYPES.includes(msg.type) && fromExtPage && !/\/sandbox\//.test(sender.url)) {
    job = serial(() => onAdmin(msg));
  } else return false;
  job.then((r) => sendResponse(r || {}), () => sendResponse({}));
  return true;
});
