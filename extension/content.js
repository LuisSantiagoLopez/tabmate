/* Tabmate content script: the pill, the recorder and the runner.
   Runs in every top-level page (and is loaded directly by the sandbox pages).
   Nothing here talks to the network. Everything goes to the service worker. */
(function () {
  'use strict';
  if (window.__tabmateLoaded) return;
  window.__tabmateLoaded = true;
  if (!window.chrome || !chrome.runtime || !chrome.runtime.id) return;

  const S = self.TabmateShared;
  if (!/^(https?|chrome-extension):$/.test(location.protocol) || !location.host) return;

  /* ---------------- state ---------------- */
  let enabled = false;        // watching on this page
  let running = null;         // active run controller
  let readyWorkflows = [];
  let lastSubmitClickTs = 0;
  let pageGone = false;

  // The next page picks the run back up; nothing to report from here.
  addEventListener('pagehide', () => { pageGone = true; if (running) { running.aborted = true; endRunHere(); } });

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res || null);
        });
      } catch (e) { resolve(null); } // extension reloaded: stay quiet
    });
  }

  /* ================================================================
     PILL (closed shadow DOM so page CSS and scripts cannot reach it)
     ================================================================ */
  const MARK = '<svg class="mark" viewBox="135 249 759 523" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="64" stroke-linecap="round" stroke-linejoin="round" d="M145 450H426C488 450 482 372 546 372H630C693 372 685 448 750 448H804C851 448 884 481 884 529V681C884 730 853 762 804 762H339C272 762 225 715 225 647V313C225 283 247 259 276 259C305 259 327 283 327 313V450"/></svg>';
  const CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l13 7.2-5.6 1.6L15.8 19l-2.7 1.3-3.4-7.1L5 17z" fill="#C6FF3D" stroke="#0B2B2A" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { position: fixed; left: 0; right: 0; bottom: 20px; display: flex; justify-content: center; pointer-events: none; z-index: 2147483647;
    transition: transform .34s cubic-bezier(.32,.72,0,1); }
  .wrap.up { bottom: auto; top: 20px; }
  .pill {
    --bg: rgba(10, 38, 36, .86); --fg: #F3F4F1; --soft: rgba(243,244,241,.58); --line: rgba(255,255,255,.09);
    --accent: #C6FF3D; --on-accent: #0B2B2A; --chip: rgba(243,244,241,.12);
    pointer-events: auto; position: relative; display: flex; align-items: center;
    height: 40px; padding: 0 8px 0 13px; border-radius: 13px; overflow: hidden; white-space: nowrap;
    background: var(--bg); color: var(--fg);
    -webkit-backdrop-filter: blur(20px) saturate(170%); backdrop-filter: blur(20px) saturate(170%);
    font: 500 13px/1 "Inter Tight", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: -0.006em; font-feature-settings: "tnum" 1;
    box-shadow: inset 0 0 0 .5px var(--line), inset 0 1px 0 rgba(255,255,255,.06), 0 14px 34px -14px rgba(4,16,15,.55), 0 2px 6px -1px rgba(4,16,15,.22);
    transition: width .34s cubic-bezier(.32,.72,0,1), transform .32s cubic-bezier(.34,1.36,.64,1), opacity .2s ease, background .3s ease;
    transform: none; opacity: 1;
  }
  .pill[data-theme="light"] {
    --bg: rgba(251, 251, 248, .84); --fg: #0B2B2A; --soft: rgba(11,43,42,.55); --line: rgba(11,43,42,.10);
    --accent: #0B2B2A; --on-accent: #C6FF3D; --chip: rgba(11,43,42,.07);
    box-shadow: inset 0 0 0 .5px var(--line), 0 14px 34px -14px rgba(0,0,0,.6), 0 2px 6px -1px rgba(0,0,0,.3);
  }
  .pill.hidden { transform: translateY(14px) scale(.96); opacity: 0; pointer-events: none; }
  .wrap.up .pill.hidden { transform: translateY(-14px) scale(.96); }
  .pill[data-state="idle"] { opacity: .74; padding-right: 13px; }
  .pill[data-state="idle"]:has(button:not([hidden])) { padding-right: 6px; }
  .pill[data-state="idle"]:hover { opacity: 1; }
  .inner { display: flex; align-items: center; gap: 9px; flex: none; }
  .mark { width: 17px; height: 12px; color: var(--fg); flex: none; opacity: .92; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #C6FF3D; flex: none; box-shadow: 0 0 0 0 rgba(198,255,61,.6); }
  .pill[data-theme="light"] .dot { background: #5BBF2A; }
  .pill[data-state="idle"] .dot { animation: pulse 2.8s ease-in-out infinite; }
  .pill[data-state="running"] .dot { animation: pulse 1.2s ease-in-out infinite; }
  .pill[data-state="needs"] .dot { background: #FFB547; }
  .pill[data-state="error"] .dot, .pill[data-state="stopped"] .dot { background: #9AA6A3; }
  .pill[data-state="done"] .dot, .pill[data-state="learned"] .dot { width: 14px; height: 14px; background: #C6FF3D url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M4 7.2l2 2 4-4.4' fill='none' stroke='%230B2B2A' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/14px no-repeat; animation: pop .34s cubic-bezier(.34,1.56,.64,1); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(198,255,61,.5); } 70% { box-shadow: 0 0 0 6px rgba(198,255,61,0); } 100% { box-shadow: 0 0 0 0 rgba(198,255,61,0); } }
  @keyframes pop { from { transform: scale(.3); } to { transform: none; } }
  .text { display: flex; align-items: baseline; gap: 7px; transition: opacity .16s ease, transform .2s ease; }
  .text.swap { opacity: 0; transform: translateY(3px); }
  .main b { font-weight: 600; color: var(--fg); }
  .sub { color: var(--soft); font-weight: 400; font-size: 12.5px; }
  .sub kbd { font: 500 11px/1 "Inter Tight", ui-sans-serif, system-ui, sans-serif; padding: 2px 5px; border-radius: 5px; background: var(--chip); color: var(--fg); }
  button {
    all: unset; cursor: pointer; font: 600 12.5px/1 "Inter Tight", ui-sans-serif, system-ui, sans-serif;
    height: 28px; padding: 0 11px; display: inline-flex; align-items: center; border-radius: 9px; background: var(--accent); color: var(--on-accent); flex: none;
    transition: transform .15s ease, background .15s ease, filter .15s ease;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: scale(.96); }
  button:focus-visible { outline: 2px solid #C6FF3D; outline-offset: 2px; }
  button.ghost { background: var(--chip); color: var(--fg); }
  button[hidden] { display: none; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--chip); opacity: 0; transition: opacity .3s ease; }
  .bar i { display: block; height: 100%; width: 0; background: #C6FF3D; box-shadow: 0 0 8px rgba(198,255,61,.7); transition: width .45s cubic-bezier(.32,.72,0,1); }
  .pill[data-state="running"] .bar, .pill[data-state="needs"] .bar { opacity: 1; }
  .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; pointer-events: none; opacity: 0;
    transform: translate(-40px,-40px); transition: transform .55s cubic-bezier(.3,.7,.2,1), opacity .25s ease;
    filter: drop-shadow(0 4px 10px rgba(11,43,42,.35)); }
  .cursor.on { opacity: 1; }
  .cursor svg { width: 24px; height: 24px; display: block; }
  .cursor .tap { position: absolute; left: -9px; top: -9px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #C6FF3D; opacity: 0; }
  .cursor.click .tap { animation: tap .45s ease-out; }
  @keyframes tap { from { opacity: .9; transform: scale(.4); } to { opacity: 0; transform: scale(1.6); } }
  .ring { position: fixed; pointer-events: none; border-radius: 8px; box-shadow: 0 0 0 2px #FFB547, 0 0 0 6px rgba(255,181,71,.25); opacity: 0; transition: opacity .25s ease; }
  .ring.on { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .pill, .text, .bar i, .cursor, .wrap { transition: none !important; }
    .pill .dot { animation: none !important; }
  }`;

  const host = document.createElement('tabmate-pill');
  host.setAttribute('data-state', 'hidden');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="wrap"><div class="pill hidden" data-state="idle" role="status" aria-live="polite">
      <div class="inner">${MARK}<span class="dot"></span>
        <span class="text"><span class="main"></span><span class="sub"></span></span>
        <button class="b1" type="button" hidden></button><button class="b2 ghost" type="button" hidden></button>
      </div><div class="bar"><i></i></div>
    </div></div>
    <div class="cursor">${CURSOR}<span class="tap"></span></div>
    <div class="ring"></div>`;
  const $ = (s) => shadow.querySelector(s);
  const pill = $('.pill'), inner = $('.inner'), textEl = $('.text'), mainEl = $('.main'), subEl = $('.sub');
  const b1 = $('.b1'), b2 = $('.b2'), barFill = $('.bar i'), cursor = $('.cursor'), ring = $('.ring');
  let b1Handler = null, b2Handler = null, collapseTimer = null;

  // Only real clicks from the person count. Page scripts cannot press the pill.
  b1.addEventListener('click', (e) => { if (e.isTrusted && b1Handler) b1Handler(); });
  b2.addEventListener('click', (e) => { if (e.isTrusted && b2Handler) b2Handler(); });

  // Keep the pill exactly as wide as what it shows (text swaps, buttons, the check mark).
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(inner);

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fit() {
    const cs = getComputedStyle(pill);
    pill.style.width = Math.ceil(inner.scrollWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) + 'px';
  }

  // Light glass on dark pages, dark glass on light pages.
  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m || (m[3] !== undefined && Number(m[3]) < 0.5)) continue;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
    }
    return false;
  }

  // Never sit on top of the thing Tabmate is about to click: move to the top edge instead.
  const wrapEl = () => shadow.querySelector('.wrap');
  function avoid(el) {
    const r = el ? viewRect(el) : null;
    const below = innerHeight - 20 - 40 - 16; // pill area at the bottom, with a margin
    wrapEl().classList.toggle('up', !!r && r.top + r.height > below);
  }

  // view: { state, main (html), sub (html), b1: {label, on}, b2: {label, on}, progress: 0..1 }
  function render(view) {
    clearTimeout(collapseTimer);
    mount();
    host.setAttribute('data-state', view.state);
    pill.setAttribute('data-state', view.state);
    pill.dataset.theme = pageIsDark() ? 'light' : 'dark';
    pill.classList.remove('hidden');
    const apply = () => {
      mainEl.innerHTML = view.main || '';
      subEl.innerHTML = view.sub || '';
      subEl.style.display = view.sub ? '' : 'none';
      [[b1, view.b1, (h) => (b1Handler = h)], [b2, view.b2, (h) => (b2Handler = h)]].forEach(([btn, cfg, set]) => {
        if (cfg) { btn.textContent = cfg.label; btn.hidden = false; set(cfg.on); } else { btn.hidden = true; set(null); }
      });
      barFill.style.width = Math.round((view.progress || 0) * 100) + '%';
      fit();
      textEl.classList.remove('swap');
    };
    if (mainEl.innerHTML && mainEl.innerHTML !== (view.main || '')) {
      textEl.classList.add('swap');
      setTimeout(apply, 160);
    } else apply();
  }

  function hidePill() {
    clearTimeout(collapseTimer);
    pill.classList.add('hidden');
    host.setAttribute('data-state', 'hidden');
  }

  function idle() {
    if (!running) wrapEl().classList.remove('up');
    if (!enabled) return hidePill();
    const ready = readyWorkflows[0];
    if (ready) {
      return render({ state: 'idle', main: 'Watching', sub: esc(ready.name), b1: { label: 'Run', on: () => startFromPill(ready.id) } });
    }
    render({ state: 'idle', main: 'Watching' });
  }

  function flash(view, ms) {
    render(view);
    collapseTimer = setTimeout(idle, ms || 4200);
  }

  /* ================================================================
     RECORDER
     Watches the top page, its same-origin iframes and open shadow roots.
     Text fields are recorded once, when you leave them (or press Enter, or paste).
     ================================================================ */
  const F = self.TabmateFinder;
  const { norm } = F;
  const TEXTLIKE = /^(text|email|search|tel|url|number|date|datetime-local|month|week|time|)$/;
  const CLICKABLE = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=switch],[role=checkbox],[role=radio],input[type=submit],input[type=button],input[type=reset],summary';
  const COPY_PASTE_KEYS = /^[cvxazy]$/i;

  // Tabmate's own UI (the pill, and coach marks marked data-tabmate-ui) is never recorded.
  function inPill(e) {
    return !!e.composedPath && e.composedPath().some((n) => n === host || (n.nodeType === 1 && n.hasAttribute('data-tabmate-ui')));
  }
  function canRecord(e) {
    return enabled && !running && e.isTrusted && !inPill(e);
  }
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const isTextField = (el) => !!el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && (TEXTLIKE.test((el.getAttribute('type') || '').toLowerCase()) || el.type === 'password')) || el.isContentEditable);
  const editableRoot = (el) => { let c = el; while (c && c.parentElement && c.parentElement.isContentEditable) c = c.parentElement; return c; };
  const fieldValue = (el) => (el.isContentEditable ? norm(el.innerText) : String(el.value));

  function heading() {
    const h = document.querySelector('h1');
    return h ? norm(h.innerText).slice(0, 40) : '';
  }

  function baseStep(kind, el) {
    const step = {
      kind, target: F.describe(el), label: F.friendlyLabel(el), value: null, sensitive: false, item: null,
      path: S.pathPattern(location.pathname), url: location.origin + location.pathname + location.search,
      heading: heading(), title: norm(document.title).slice(0, 60), ts: Date.now(),
    };
    // Inside a repeated list, a step is "this element in some row". The two recordings
    // decide later whether the row stays the same, moves on, or is always the newest.
    const item = F.listItemOf(el);
    if (item) step.item = Object.assign(item, { generic: true });
    return step;
  }

  async function record(step) {
    const res = await send({ type: 'step', step });
    if (!res || !res.learned) return;
    readyWorkflows = res.ready || readyWorkflows;
    const wf = res.learned;
    flash({ state: 'learned', main: 'Learned: <b>' + esc(wf.name) + '</b>', sub: wf.steps + ' steps', b2: { label: 'Undo', on: () => undoLearned(wf) } }, 6000);
  }

  async function undoLearned(wf) {
    const res = await send({ type: 'undo-learned', workflowId: wf.id });
    readyWorkflows = readyWorkflows.filter((w) => w.id !== wf.id);
    flash({ state: 'stopped', main: 'Forgot it', sub: 'I won’t do this one' }, 2600);
  }

  // Text fields typed into but not yet recorded.
  const dirty = new Set();
  const lastRecorded = new WeakMap();

  function flushField(el, extra) {
    if (!el || !dirty.has(el)) return;
    dirty.delete(el);
    if (!el.isConnected) return;
    const value = fieldValue(el);
    if (lastRecorded.get(el) === value) return;
    lastRecorded.set(el, value);
    const step = baseStep('input', el);
    if (F.isSensitive(el)) step.sensitive = true;
    else step.value = value.slice(0, 2000);
    if (el.isContentEditable) step.editable = true;
    Object.assign(step, extra || {});
    record(step);
  }
  function flushAll() {
    for (const el of [...dirty]) flushField(el);
  }

  function onClick(e) {
    if (!canRecord(e)) return;
    const raw = realTarget(e);
    if (!raw || !raw.closest) return;
    if (raw.closest('input:not([type=submit]):not([type=button]):not([type=reset]),textarea,select,label,[contenteditable=""],[contenteditable=true]')) return;
    let el = raw.closest(CLICKABLE);
    if (!el) el = pointerTarget(raw);
    if (!el) return;
    flushAll();
    const step = baseStep('click', el);
    if (el.form && (el.type === 'submit' || (el.tagName === 'BUTTON' && !el.getAttribute('type')))) lastSubmitClickTs = Date.now();
    record(step);
  }

  // Custom widgets (div buttons, dropdown options) often only show a pointer cursor.
  function pointerTarget(raw) {
    const view = raw.ownerDocument.defaultView;
    let cur = raw;
    for (let d = 0; cur && d < 4 && cur !== cur.ownerDocument.body; d++, cur = cur.parentElement) {
      const r = cur.getBoundingClientRect();
      if (r.width * r.height > 0.3 * view.innerWidth * view.innerHeight) return null;
      if (cur.hasAttribute('onclick') || cur.hasAttribute('tabindex') || view.getComputedStyle(cur).cursor === 'pointer') return cur;
    }
    return null;
  }

  function recordChoice(el) {
    let step;
    if (el.tagName === 'SELECT') {
      step = baseStep('select', el);
      step.value = el.value;
      const opt = el.options[el.selectedIndex];
      step.valueLabel = opt ? norm(opt.text).slice(0, 60) : '';
    } else if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) {
      step = baseStep('check', el);
      step.value = !!el.checked;
    } else return false;
    if (F.isSensitive(el)) { step.sensitive = true; step.value = null; delete step.valueLabel; }
    record(step);
    return true;
  }

  function onChange(e) {
    if (!canRecord(e)) return;
    const el = realTarget(e);
    if (!el || !el.tagName) return;
    if (recordChoice(el)) return;
    if (isTextField(el)) { dirty.add(el); flushField(el); }
  }

  // "change" does not leave shadow roots, "input" does. Use it for fields inside shadow DOM.
  function onInput(e) {
    if (!e.isTrusted || inPill(e)) return;
    const raw = realTarget(e);
    if (!raw || !raw.tagName) return;
    const el = raw.isContentEditable ? editableRoot(raw) : raw;
    if (isTextField(el)) { if (canRecord(e)) dirty.add(el); return; }
    if (canRecord(e) && el.getRootNode() !== el.ownerDocument) recordChoice(el);
  }

  function onFocusOut(e) {
    if (!canRecord(e)) return;
    const raw = realTarget(e);
    if (raw && raw.nodeType === 1) flushField(raw.isContentEditable ? editableRoot(raw) : raw);
  }

  function onPaste(e) {
    if (!canRecord(e)) return;
    const raw = realTarget(e);
    if (!isTextField(raw)) return;
    const el = raw.isContentEditable ? editableRoot(raw) : raw;
    setTimeout(() => { dirty.add(el); flushField(el, { pasted: true }); }, 0);
  }

  function onCopy(e) {
    if (!canRecord(e)) return;
    const doc = (realTarget(e) && realTarget(e).ownerDocument) || document;
    const active = deepActive(doc);
    let el, text;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
      if (F.isSensitive(active)) return;
      el = active;
      text = String(active.value).slice(active.selectionStart || 0, active.selectionEnd || 0);
    } else {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      text = sel.toString();
      const asEl = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
      const anchor = asEl(sel.anchorNode), common = asEl(sel.getRangeAt(0).commonAncestorContainer);
      el = [anchor, common].find((c) => c && norm(c.innerText).includes(norm(text))) || common;
    }
    text = norm(text);
    if (!el || !text || F.isSensitive(el)) return;
    flushAll();
    const step = baseStep('copy', el);
    step.value = text.slice(0, 2000);
    step.label = 'Copy ' + (F.friendlyLabel(el) || 'text').slice(0, 50);
    record(step);
  }

  function deepActive(doc) {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function onKeyDown(e) {
    if (!canRecord(e) || e.repeat) return;
    const el = realTarget(e);
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    const target = el && el.nodeType === 1 && el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement ? (el.isContentEditable ? editableRoot(el) : el) : null;
    let isShortcut = false;
    if (e.key === 'Enter' && !mods && target && isTextField(target) && target.tagName !== 'TEXTAREA' && !target.isContentEditable && !target.form) isShortcut = true;
    if (mods && !/^(Control|Meta|Alt|Shift)$/.test(e.key) && !(COPY_PASTE_KEYS.test(e.key) && !e.altKey && !e.shiftKey) && e.key !== 'Tab') isShortcut = true;
    if (!isShortcut) return;
    flushAll();
    const step = target ? baseStep('key', target) : Object.assign(baseStep('key', el.ownerDocument.body), { target: null, item: null });
    step.keys = { key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey };
    step.label = 'Press ' + [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+');
    record(step);
  }

  function onSubmit(e) {
    if (!canRecord(e)) return;
    if (Date.now() - lastSubmitClickTs < 1200) return; // the button click already covers it
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    flushAll();
    const step = baseStep('submit', form);
    const btn = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
    step.label = btn ? F.textOf(btn) || 'Submit' : 'Submit form';
    record(step);
  }

  const watchedDocs = new WeakSet();
  function watchDoc(doc) {
    if (!doc || watchedDocs.has(doc)) return;
    watchedDocs.add(doc);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('input', onInput, true);
    doc.addEventListener('focusout', onFocusOut, true);
    doc.addEventListener('paste', onPaste, true);
    doc.addEventListener('copy', onCopy, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('submit', onSubmit, true);
    if (doc !== document) {
      doc.addEventListener('keydown', onRunKey, true);
      doc.addEventListener('pointerdown', onRunPointer, true);
    }
    watchFrames(doc);
    try {
      new MutationObserver(() => watchFrames(doc)).observe(doc.documentElement, { childList: true, subtree: true });
    } catch (e) { /* document gone */ }
  }
  function watchFrames(doc) {
    for (const fr of doc.querySelectorAll('iframe,frame')) {
      if (fr.__tabmateFrame) continue;
      fr.__tabmateFrame = true;
      const attach = () => { let d = null; try { d = fr.contentDocument; } catch (e) { d = null; } if (d && d.documentElement) watchDoc(d); };
      fr.addEventListener('load', attach);
      attach();
    }
  }

  /* ================================================================
     RUNNER (one step at a time; the service worker picks tabs and order)
     ================================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

  function moveCursorTo(el) {
    avoid(el);
    const r = viewRect(el);
    cursor.classList.add('on');
    cursor.style.transform = `translate(${Math.round(r.left + Math.min(r.width / 2, 40)) - 4}px, ${Math.round(r.top + r.height / 2) - 3}px)`;
  }
  function tapCursor() {
    cursor.classList.remove('click');
    void cursor.offsetWidth;
    cursor.classList.add('click');
  }
  function showRing(el) {
    const r = viewRect(el);
    Object.assign(ring.style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
    ring.classList.add('on');
  }
  // Element box in top-page coordinates (adds iframe offsets).
  function viewRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top;
    let w = el.ownerDocument.defaultView;
    try {
      while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); left += fr.left; top += fr.top; w = w.parent; }
    } catch (e) { /* cross-origin */ }
    return { left, top, width: r.width, height: r.height };
  }

  // Wait until the page stops changing (SPA re-renders, late network) or a short limit passes.
  function settle(maxMs) {
    return new Promise((resolve) => {
      let timer = null, done = false, lastNet = Date.now();
      const finish = () => { if (done) return; done = true; mo.disconnect(); po && po.disconnect(); clearTimeout(cap); resolve(); };
      const quiet = () => { clearTimeout(timer); timer = setTimeout(() => (Date.now() - lastNet >= 250 ? finish() : quiet()), 160); };
      const mo = new MutationObserver(quiet);
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      let po = null;
      try { po = new PerformanceObserver(() => { lastNet = Date.now(); quiet(); }); po.observe({ type: 'resource', buffered: false }); } catch (e) { po = null; }
      const cap = setTimeout(finish, maxMs);
      quiet();
    });
  }

  function nativeSetter(el) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const own = el.ownerDocument.defaultView;
    const realProto = (own && own[proto.constructor.name] && own[proto.constructor.name].prototype) || proto;
    const desc = Object.getOwnPropertyDescriptor(realProto, 'value');
    return desc && desc.set;
  }

  // Sets a value the way typing does, so React, Vue and plain pages all see it.
  function setValue(el, value) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = doc.execCommand && doc.execCommand('insertText', false, value);
      if (!ok || norm(el.innerText) !== norm(value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === value)) {
      const byLabel = [...el.options].find((o) => norm(o.text) === norm(value));
      if (byLabel) value = byLabel.value;
    }
    const set = nativeSetter(el);
    if (set) set.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressKeys(el, keys) {
    const target = el || deepActive(document) || document.body;
    const code = keys.key === 'Enter' ? 13 : keys.key && keys.key.length === 1 ? keys.key.toUpperCase().charCodeAt(0) : 0;
    const init = { key: keys.key, code: keys.code, ctrlKey: !!keys.ctrl, metaKey: !!keys.meta, altKey: !!keys.alt, shiftKey: !!keys.shift, bubbles: true, cancelable: true, composed: true };
    if (el && el.focus) el.focus({ preventScroll: true });
    const fire = (type) => {
      const ev = new KeyboardEvent(type, init);
      Object.defineProperty(ev, 'keyCode', { get: () => code });
      Object.defineProperty(ev, 'which', { get: () => code });
      return target.dispatchEvent(ev);
    };
    const go = fire('keydown');
    if (go && keys.key === 'Enter') fire('keypress');
    fire('keyup');
  }

  function clickLikeAPerson(el) {
    if (el.focus) el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const view = el.ownerDocument.defaultView;
    el.dispatchEvent(new view.PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, at)));
    el.dispatchEvent(new view.MouseEvent('mousedown', at));
    el.dispatchEvent(new view.PointerEvent('pointerup', Object.assign({ pointerId: 1, isPrimary: true }, at)));
    el.dispatchEvent(new view.MouseEvent('mouseup', at));
    el.click();
  }

  function selectForShow(el) {
    try {
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
    } catch (e) { /* not selectable */ }
  }

  // Run state in this tab. One run can touch several tabs; each tab only knows its own steps.
  function beginRun(runId) {
    if (running && running.runId === runId) return running;
    if (running) endRunHere();
    running = { runId, aborted: false, mode: 'running', waitingOn: null, resumeFn: null };
    return running;
  }
  function endRunHere() {
    cursor.classList.remove('on');
    ring.classList.remove('on');
    if (running && running.resumeFn) running.resumeFn();
    running = null;
  }
  function stopByPerson() {
    if (!running || running.aborted) return;
    const runId = running.runId;
    running.aborted = true;
    endRunHere();
    send({ type: 'run-stop', runId });
    flash({ state: 'stopped', main: 'Stopped', sub: 'You have control' }, 3000);
  }
  function onRunKey(e) {
    if (running && e.key === 'Escape' && e.isTrusted) { e.stopPropagation(); stopByPerson(); }
  }
  function onRunPointer(e) {
    if (!running || !e.isTrusted || inPill(e)) return;
    const ctl = running;
    if (ctl.mode === 'needs') {
      // While waiting on the person, a click on the flagged button is them doing that step.
      const w = ctl.waitingOn;
      const t = realTarget(e);
      if (w && w.risky && (t === w.el || w.el.contains(t))) {
        w.byUser = true;
        send({ type: 'progress', runId: ctl.runId, acted: w.index });
        setTimeout(() => ctl.resumeFn && ctl.resumeFn(), 50);
      }
      return;
    }
    stopByPerson();
  }
  addEventListener('keydown', onRunKey, true);
  addEventListener('pointerdown', onRunPointer, true);

  function progressView(done, total, row) {
    return {
      state: 'running', main: 'Doing it for you · <b>' + done + '/' + total + '</b>' + (row ? ' · row ' + row : ''),
      sub: 'Press <kbd>Esc</kbd> to stop', progress: done / total,
    };
  }

  async function findTarget(step, row, ctl) {
    const until = Date.now() + 10000;
    let found = { el: null };
    while (!ctl.aborted && Date.now() < until) {
      if (row != null && step.item) {
        found = F.findInRow(step.item, row);
        if (found.missingRow && found.rows && Date.now() > until - 7000) return found; // the list is there, the row is not
      } else found = { el: step.target ? F.resolve(step.target) : document.body };
      if (found.el && F.usable(found.el)) return found;
      await sleep(150);
    }
    return found.el && F.usable(found.el) ? found : { el: null };
  }

  // Does one step. Answers { status: ok | stopped | error, ... }.
  async function execStep(msg) {
    const ctl = beginRun(msg.runId);
    const { step, index, total } = msg;
    const stopped = () => ({ status: 'stopped' });
    render(progressView(index, total, msg.rowLabel));
    await settle(1500);
    if (ctl.aborted) return stopped();

    const found = await findTarget(step, msg.row, ctl);
    if (ctl.aborted) return stopped();
    const el = found.el;
    if (!el) return { status: 'error', reason: found.missingRow ? 'Row not found' : 'Couldn’t find “' + step.label + '”', missingRow: !!found.missingRow };

    el.scrollIntoView({ block: 'center', behavior: motion() ? 'smooth' : 'auto' });
    await sleep(300);
    if (ctl.aborted) return stopped();
    moveCursorTo(el);
    await sleep(520);
    if (ctl.aborted) return stopped();

    // Safety rails. Text is never read out of a private field (it could reach Claude).
    if (step.kind === 'copy' && F.isSensitive(el)) return { status: 'error', reason: 'Won’t copy from a private field' };
    const sensitive = step.sensitive || (step.kind !== 'copy' && step.kind !== 'click' && F.isSensitive(el));
    const actText = step.kind === 'submit' ? (() => { const sb = el.querySelector('button[type=submit],input[type=submit],button:not([type])'); return sb ? F.textOf(sb) : ''; })() : F.textOf(el);
    const risky = (step.kind === 'click' || step.kind === 'submit' || step.kind === 'key') && (S.isRisky(step.label) || S.isRisky(actText));
    if (sensitive || risky) {
      showRing(el);
      ctl.waitingOn = { el, index, risky, byUser: false };
      send({ type: 'needs', runId: msg.runId, index, reason: sensitive ? 'sensitive' : 'risky', label: step.label });
      await new Promise((resolve) => {
        ctl.mode = 'needs';
        ctl.resumeFn = () => { ctl.resumeFn = null; ctl.mode = 'running'; resolve(); };
        render({
          state: 'needs',
          main: 'Needs you · <b>' + esc(sensitive ? 'Fill “' + step.label + '”' : 'Click “' + (actText || step.label) + '” yourself') + '</b>',
          sub: sensitive ? 'Tabmate never types here' : 'Tabmate won’t do this one',
          progress: index / total,
          b1: sensitive ? { label: 'Continue', on: () => ctl.resumeFn && ctl.resumeFn() } : null,
          b2: { label: 'Stop', on: () => stopByPerson() },
        });
      });
      ring.classList.remove('on');
      ctl.waitingOn = null;
      if (ctl.aborted) return stopped();
      if (risky) await sleep(700); // the person clicked it; it may be loading the next page
      if (ctl.aborted || pageGone) return stopped();
      render(progressView(index + 1, total, msg.rowLabel));
      return { status: 'ok', byPerson: true, rowKey: found.rowKey, cells: found.cells };
    }

    // Tell the service worker before acting: a click may unload this page.
    await send({ type: 'progress', runId: msg.runId, acted: index });
    if (ctl.aborted) return stopped();
    tapCursor();
    render(progressView(index + 1, total, msg.rowLabel));
    const out = { status: 'ok', rowKey: found.rowKey, cells: found.cells };
    try {
      if (step.kind === 'click') clickLikeAPerson(el);
      else if (step.kind === 'input' || step.kind === 'select') setValue(el, msg.value == null ? '' : String(msg.value));
      else if (step.kind === 'check') { if (el.checked !== !!msg.value) clickLikeAPerson(el); }
      else if (step.kind === 'submit') { el.requestSubmit ? el.requestSubmit() : el.submit(); }
      else if (step.kind === 'key') pressKeys(step.target ? el : null, step.keys || {});
      else if (step.kind === 'copy') {
        selectForShow(el);
        out.copied = norm(/^(INPUT|TEXTAREA)$/.test(el.tagName) ? el.value : el.innerText || el.textContent).slice(0, 2000);
      }
    } catch (e) {
      return { status: 'error', reason: 'Couldn’t do “' + step.label + '”' };
    }
    await sleep(380);
    return out;
  }

  function rowKeys(item) {
    const rows = F.listRows(item);
    return rows ? rows.map((r) => norm(r.innerText || r.textContent).slice(0, 120)) : null;
  }

  async function startFromPill(workflowId) {
    if (running) return;
    await send({ type: 'run-start', workflowId });
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === 'exec') {
      execStep(msg).then(reply, () => reply({ status: 'error', reason: 'Something changed on the page' }));
      return true;
    }
    if (msg.type === 'ping') { reply({ ok: true, path: S.pathPattern(location.pathname), ready: document.readyState }); return false; }
    if (msg.type === 'list-rows') { reply({ keys: rowKeys(msg.item) }); return false; }
    if (msg.type === 'run-ended') { onRunEnded(msg); return false; }
    if (msg.type === 'refresh') hello();
    return false;
  });

  function onRunEnded(msg) {
    const mine = running && running.runId === msg.runId;
    if (mine) endRunHere();
    if (!mine && !msg.wasHere) return;
    if (msg.status === 'done') flash({ state: 'done', main: 'Done for you', sub: msg.savedMs ? 'saved ' + S.formatSaved(msg.savedMs) : '', progress: 1 }, 3800);
    else if (msg.status === 'stopped') flash({ state: 'stopped', main: 'Stopped', sub: 'You have control' }, 3000);
    else flash({ state: 'error', main: esc(msg.reason || 'Something changed on the page'), sub: 'Stopped' }, 5200);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.workflows)) hello(true);
  });

  /* ================================================================
     START
     ================================================================ */
  async function hello(quiet) {
    const nav = (performance.getEntriesByType('navigation')[0] || {}).type || 'navigate';
    const res = await send({ type: 'hello', path: S.pathPattern(location.pathname), url: location.origin + location.pathname + location.search, nav: quiet ? 'none' : nav, title: norm(document.title).slice(0, 60) });
    if (!res) return;
    enabled = !!res.enabled;
    readyWorkflows = res.ready || [];
    if (!enabled) {
      if (running) stopByPerson();
      return hidePill();
    }
    if (res.finished) return onRunEnded(Object.assign({ wasHere: true }, res.finished));
    if (res.running && !running) {
      beginRun(res.running.runId);
      return render(progressView(res.running.index, res.running.total, res.running.rowLabel));
    }
    if (!running && !collapseTimer) idle();
    else if (!running && host.getAttribute('data-state') === 'idle') idle();
  }

  watchDoc(document);
  hello();
})();
