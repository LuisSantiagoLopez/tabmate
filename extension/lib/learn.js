/* Tabmate learning logic. Pure functions, no DOM, no chrome.* calls.
   Loaded by the service worker, the extension pages, and the Node unit tests.

   Words used here:
   - step:      one thing the person did (click, input, select, check, submit, key, copy).
   - item step: a step on an element inside a repeated list (a table row, a list item).
   - list mode: how a list is walked on replay: "fixed" (same row), "last" (newest row),
                "step" (row moves by a stride each run; the source list is looped over).
   - variable:  a typed value that changed between the two recordings. It is filled from
                copied text ("copy"), from a cell of the current row ("cell"), or from a
                caller input with the last value as default ("ask"). */
(function (root) {
  'use strict';
  const S = root.TabmateShared || (typeof require === 'function' ? require('./shared.js') : null);

  const ACT_KINDS = ['click', 'input', 'select', 'check', 'submit', 'key', 'copy'];
  const MAX_DONE_KEYS = 500;

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'tool';
  const trimmed = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function keyCombo(keys) {
    if (!keys) return '';
    return [keys.ctrl && 'ctrl', keys.meta && 'meta', keys.alt && 'alt', keys.shift && 'shift', String(keys.key || '').toLowerCase()].filter(Boolean).join('+');
  }

  function listKey(item) {
    return item && item.list ? item.list.key : '';
  }

  // What makes two steps "the same step". Values are never part of it.
  // Item steps ignore the row index, so "copy the name in row 1" equals "copy the name in row 2".
  // Whether the row matters is decided later, from the two recordings (see inferLists).
  function signature(step) {
    const target = step.item && step.item.generic
      ? 'item:' + listKey(step.item) + '>' + (step.item.inner || step.item.cell || '')
      : (step.target && step.target.key) || '';
    return [step.kind, step.site || '', step.path, target, step.kind === 'key' ? keyCombo(step.keys) : ''].join('|');
  }

  function sameSeq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (signature(a[i]) !== signature(b[i])) return false;
    return true;
  }

  // A recorded step matches a learned step: same signature, and same row when that list is fixed.
  function matchesLearned(act, wfStep, wf) {
    if (signature(act) !== signature(wfStep)) return false;
    const list = wfStep.item && wf.lists && wf.lists[listKey(wfStep.item)];
    if (list && list.mode === 'fixed') return act.item && act.item.index === wfStep.item.index;
    return true;
  }

  /* ---------- lists ---------- */
  function inferLists(earlier, latest) {
    const lists = {};
    for (let i = 0; i < latest.length; i++) {
      const x = latest[i].item, e = earlier[i].item;
      if (!x || !x.generic || !e) continue;
      const k = listKey(x);
      let mode, stride = 0;
      if (x.index === e.index) mode = 'fixed';
      else if (x.index === x.count - 1 && e.index === e.count - 1) mode = 'last';
      else { mode = 'step'; stride = x.index - e.index; }
      const seen = lists[k];
      if (seen) {
        if (seen.mode !== mode || seen.stride !== stride) return null; // rows don't move together: not a pattern
        continue;
      }
      lists[k] = { mode, stride, lastIndex: x.index, list: x.list, itemSel: x.itemSel || '', firstStep: i, source: false };
    }
    // The source list is the first moving list the person reads from (copy) or clicks in.
    const src = Object.entries(lists).find(([, l]) => l.mode === 'step' && ['copy', 'click'].includes(latest[l.firstStep].kind));
    if (src) src[1].source = true;
    return lists;
  }

  /* ---------- variables ---------- */
  // "Hello Maya!" built from copied "Maya" -> { prefix: "Hello ", suffix: "!" }
  function template(value, part) {
    if (!part) return null;
    const at = value.indexOf(part);
    if (at < 0) return null;
    return { prefix: value.slice(0, at), suffix: value.slice(at + part.length) };
  }

  function findVariable(i, earlier, latest) {
    const x = trimmed(latest[i].value), e = trimmed(earlier[i].value);
    for (let j = i - 1; j >= 0; j--) {
      const xs = latest[j], es = earlier[j];
      if (xs.kind === 'copy' && es.kind === 'copy') {
        const t = template(x, trimmed(xs.value));
        if (t && t.prefix + trimmed(es.value) + t.suffix === e) return { from: 'copy', step: j, prefix: t.prefix, suffix: t.suffix };
      }
      const xc = xs.item && xs.item.cells, ec = es.item && es.item.cells;
      if (xc && ec) {
        for (let c = 0; c < xc.length; c++) {
          if (trimmed(xc[c]) && trimmed(xc[c]) === x && trimmed(ec[c]) === e) return { from: 'cell', step: j, col: c };
        }
      }
    }
    return { from: 'ask' };
  }

  function makeName(steps, sites, loop) {
    const act = steps.find((s) => s.kind === 'click' || s.kind === 'submit') || steps.find((s) => s.kind !== 'copy') || steps[0];
    let verb = (act.label || 'Run').replace(/[“”"]/g, '').trim();
    if (verb.length > 28) verb = verb.slice(0, 28).trim() + '…';
    const noun = (steps[0].heading || '').trim();
    const nounOk = !loop && noun && noun.split(/\s+/).length <= 3 && !verb.toLowerCase().includes(noun.toLowerCase().replace(/s$/, ''));
    const where = sites.length > 1 ? 'from ' + sites.map(S.siteLabel).join(' to ') : 'on ' + S.siteLabel(sites[0]);
    return verb + (nounOk ? ' ' + noun.toLowerCase() : '') + (loop ? ' for each row' : '') + ' ' + where;
  }

  function uniqueParam(label, used, i) {
    let key = slug(label);
    while (used.has(key)) key += '_' + (i + 1);
    used.add(key);
    return key;
  }

  // Build a workflow from two matching runs. Returns null when they don't form a clean pattern.
  function buildWorkflow(earlier, latest, now) {
    const lists = inferLists(earlier, latest);
    if (!lists) return null;
    const tabRefs = new Map();
    const used = new Set();
    const steps = latest.map((x, i) => {
      const st = JSON.parse(JSON.stringify(x));
      if (!tabRefs.has(x.tab)) tabRefs.set(x.tab, tabRefs.size);
      st.tabRef = tabRefs.get(x.tab);
      delete st.tab;
      if (st.item) delete st.item.cells; // page data is read fresh on every run
      if (st.kind === 'copy') st.value = null;
      if (!st.sensitive && (st.kind === 'input' || st.kind === 'select') && trimmed(x.value) !== trimmed(earlier[i].value)) {
        st.var = findVariable(i, earlier, latest);
      }
      if (!st.sensitive && ['input', 'select', 'check'].includes(st.kind) && !(st.var && st.var.from !== 'ask')) {
        st.param = uniqueParam(st.label, used, i);
      }
      return st;
    });
    const sites = [...new Set(steps.map((s) => s.site))];
    const source = Object.keys(lists).find((k) => lists[k].source) || '';
    const doneKeys = source
      ? [earlier[lists[source].firstStep], latest[lists[source].firstStep]].map((s) => s.item.rowKey).filter(Boolean)
      : [];
    const dur = (seq) => Math.max(2000, seq[seq.length - 1].ts - seq[0].ts + 2000);
    return {
      id: 'wf_' + now.toString(36) + Math.random().toString(36).slice(2, 7),
      site: sites[0], sites, name: makeName(steps, sites, !!source), steps, enabled: true,
      lists, loop: !!source, source, doneKeys,
      runs: 0, savedMs: 0, manualMs: Math.round((dur(latest) + dur(earlier)) / 2),
      createdAt: now, updatedAt: now, lastRunAt: 0,
    };
  }

  function containedIn(seq, wfSteps) {
    const loop = wfSteps.concat(wfSteps);
    for (let i = 0; i + seq.length <= loop.length; i++) if (sameSeq(seq, loop.slice(i, i + seq.length))) return true;
    return false;
  }

  // Looks for the latest steps repeating an earlier run. Returns { wf, created } or null.
  function detect(acts, workflows, now) {
    const n = acts.length;
    let match = null;
    for (let k = Math.min(S.MAX_STEPS, Math.floor(n / 2)); k >= S.MIN_STEPS && !match; k--) {
      const suffix = acts.slice(n - k);
      for (let j = n - 2 * k; j >= 0; j--) {
        const earlier = acts.slice(j, j + k);
        if (sameSeq(earlier, suffix)) { match = { earlier, suffix }; break; }
      }
    }
    if (!match) return null;
    const cand = buildWorkflow(match.earlier, match.suffix, now);
    if (!cand) return null;
    // Signatures include the site, so this compares against every workflow safely.
    const mine = workflows;
    // A longer version of a workflow we already know: extend it, keep its id and stats.
    const base = mine.find((w) => w.steps.length < cand.steps.length && sameSeq(w.steps, cand.steps.slice(0, w.steps.length)));
    if (base) {
      Object.assign(base, {
        steps: cand.steps, sites: cand.sites, lists: cand.lists, loop: cand.loop, source: cand.source,
        doneKeys: [...new Set((base.doneKeys || []).concat(cand.doneKeys))], manualMs: cand.manualMs, name: cand.name, updatedAt: now,
      });
      return { wf: base, created: false };
    }
    if (mine.some((w) => containedIn(cand.steps, w.steps))) return null;
    workflows.push(cand);
    return { wf: cand, created: true };
  }

  // Did the person just start a learned workflow by hand? Returns { wf, index } or null.
  function triggered(acts, workflows) {
    let best = null;
    for (const wf of workflows) {
      if (!wf.enabled || wf.steps.length < S.MIN_STEPS) continue;
      const p = wf.steps.length >= 4 ? 2 : 1;
      const tail = acts.slice(-p);
      if (tail.length < p) continue;
      if (tail.some((s) => s.ts <= wf.updatedAt || s.ts <= (wf.lastRunAt || 0))) continue;
      if (tail[tail.length - 1].ts - tail[0].ts > 10 * 60 * 1000) continue;
      if (!tail.every((s, i) => matchesLearned(s, wf.steps[i], wf))) continue;
      if (!best || wf.steps.length > best.wf.steps.length) best = { wf, index: p, tail };
    }
    return best;
  }

  /* ---------- replay helpers ---------- */
  // The value to type for a step in the current run, or null when the page data it needs is missing.
  function valueFor(step, run) {
    const inputs = run.inputs || {};
    if (step.param && Object.prototype.hasOwnProperty.call(inputs, step.param)) return inputs[step.param];
    const v = step.var;
    if (!v || v.from === 'ask') return step.value;
    if (v.from === 'copy') {
      const got = (run.copies || {})[v.step];
      return got == null ? null : (v.prefix || '') + got + (v.suffix || '');
    }
    if (v.from === 'cell') {
      const cells = (run.cells || {})[v.step];
      return cells && cells[v.col] != null ? cells[v.col] : null;
    }
    return step.value;
  }

  // Which row an item step works on in this run: a number, "last", or null (not an item step).
  function rowFor(step, wf, run) {
    if (!step.item || !step.item.generic) return null;
    const list = wf.lists && wf.lists[listKey(step.item)];
    if (!list || list.mode === 'fixed') return null; // resolved from its exact target
    if (list.mode === 'last') return 'last';
    const r = (run.rows || {})[listKey(step.item)];
    return r == null ? list.lastIndex + list.stride : r;
  }

  // Next unprocessed row of the source list, after `from` (or from the start when from is null).
  function nextRow(keys, from, stride, doneKeys) {
    const done = new Set(doneKeys || []);
    const dir = stride < 0 ? -1 : 1;
    let i = from == null ? (dir > 0 ? 0 : keys.length - 1) : from + dir;
    for (; i >= 0 && i < keys.length; i += dir) if (!done.has(keys[i])) return i;
    return -1;
  }

  function rememberDone(wf, key) {
    if (!key) return;
    const keys = (wf.doneKeys || []).filter((k) => k !== key);
    keys.push(key);
    if (keys.length > MAX_DONE_KEYS) keys.splice(0, keys.length - MAX_DONE_KEYS);
    wf.doneKeys = keys;
  }

  /* ---------- MCP tool shape ---------- */
  const RESERVED = ['list_workflows', 'run_workflow'];
  function toolName(wf, taken) {
    let base = slug(wf.name);
    if (RESERVED.includes(base)) base = 'run_' + base;
    let name = base, n = 2;
    while (taken && taken.has(name)) name = base.slice(0, 56) + '_' + n++;
    if (taken) taken.add(name);
    return name;
  }

  function toTool(wf, taken) {
    const properties = {};
    const notes = [];
    wf.steps.forEach((st, i) => {
      if (st.sensitive && ['input', 'select', 'check'].includes(st.kind)) { notes.push('Step ' + (i + 1) + ' (' + st.label + ') is private and is filled by the person.'); return; }
      if (!st.param) return;
      properties[st.param] = st.kind === 'check'
        ? { type: 'boolean', description: st.label, default: !!st.value }
        : { type: 'string', description: st.label + (st.kind === 'select' ? ' (option value)' : ''), default: st.value == null ? '' : String(st.value) };
    });
    if (wf.loop) properties.max_rows = { type: 'integer', minimum: 1, maximum: 500, description: 'Most rows to process (default: all new rows).' };
    const fromPage = wf.steps.filter((s) => s.var && s.var.from !== 'ask').map((s) => s.label);
    return {
      name: toolName(wf, taken),
      description: wf.name + '. ' + wf.steps.length + ' steps, learned by Tabmate' +
        (wf.sites && wf.sites.length > 1 ? ' across ' + wf.sites.map(S.siteLabel).join(' and ') : '') + '.' +
        (wf.loop ? ' Repeats for every new row in the list.' : '') +
        (fromPage.length ? ' Filled from the page: ' + fromPage.join(', ') + '.' : '') +
        (notes.length ? ' ' + notes.join(' ') : ''),
      inputSchema: { type: 'object', properties, additionalProperties: false },
      annotations: { site: S.siteLabel(wf.site), sites: (wf.sites || [wf.site]).map(S.siteLabel), startUrl: wf.steps[0] ? wf.steps[0].url : '', steps: wf.steps.map((s) => s.kind + ': ' + s.label) },
    };
  }

  // Older saved workflows have no per-step site. Fill it in.
  function migrate(wf) {
    for (const st of wf.steps) {
      if (!st.site) st.site = wf.site;
      if (st.tabRef == null) st.tabRef = 0;
    }
    if (!wf.sites) wf.sites = [wf.site];
    if (!wf.lists) wf.lists = {};
    if (!wf.doneKeys) wf.doneKeys = [];
    if (!wf.steps.some((s) => s.param)) {
      const used = new Set();
      wf.steps.forEach((st, i) => { if (!st.sensitive && ['input', 'select', 'check'].includes(st.kind)) st.param = uniqueParam(st.label, used, i); });
    }
    return wf;
  }

  const api = {
    ACT_KINDS, slug, keyCombo, signature, sameSeq, matchesLearned, inferLists, findVariable, buildWorkflow,
    detect, triggered, valueFor, rowFor, nextRow, rememberDone, toTool, toolName, migrate, listKey,
  };
  root.TabmateLearn = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
