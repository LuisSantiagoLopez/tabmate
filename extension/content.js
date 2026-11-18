/* Tabmate content script: the pill, the recorder and the runner.
   Runs in every top-level page (and is loaded directly by the sandbox pages).
   Nothing here talks to the network. Everything goes to the service worker. */
(function () {
  'use strict';
  if (window.__tabmateLoaded) return;
  window.__tabmateLoaded = true;
  if (!window.chrome || !chrome.runtime || !chrome.runtime.id) return;

  const S = self.TabmateShared;
  const site = location.host;
  if (!/^(https?|chrome-extension):$/.test(location.protocol) || !site) return;

  /* ---------------- state ---------------- */
  let enabled = false;        // watching on this page
  let running = null;         // active run controller
  let readyWorkflows = [];
  let lastSubmitClickTs = 0;
  let pageGone = false;

  addEventListener('pagehide', () => { pageGone = true; if (running) running.abort('unload'); });

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
  .wrap { position: fixed; left: 0; right: 0; bottom: 18px; display: flex; justify-content: center; pointer-events: none; }
  .pill {
    pointer-events: auto; position: relative; display: flex; align-items: center; gap: 9px;
    height: 38px; padding: 0 14px 0 12px; border-radius: 999px; overflow: hidden; white-space: nowrap;
    background: #0B2B2A; color: #F3F4F1;
    font: 500 13px/1 "Inter Tight", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: -0.005em;
    box-shadow: 0 0 0 1px rgba(198,255,61,.10), 0 10px 30px -10px rgba(5,20,20,.55), 0 2px 6px rgba(5,20,20,.25);
    transition: width .46s cubic-bezier(.2,.8,.2,1), transform .46s cubic-bezier(.2,.8,.2,1), opacity .3s ease;
    transform: translateY(0); opacity: 1;
  }
  .pill.hidden { transform: translateY(70px); opacity: 0; pointer-events: none; }
  .pill[data-state="idle"] { opacity: .88; }
  .pill[data-state="idle"]:hover { opacity: 1; }
  .inner { display: flex; align-items: center; gap: 9px; }
  .mark { width: 18px; height: 13px; color: #F3F4F1; flex: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #C6FF3D; flex: none; box-shadow: 0 0 0 0 rgba(198,255,61,.6); }
  .pill[data-state="idle"] .dot { animation: pulse 2.4s ease-in-out infinite; }
  .pill[data-state="needs"] .dot { background: #FFB547; }
  .pill[data-state="error"] .dot, .pill[data-state="stopped"] .dot { background: #9AA6A3; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(198,255,61,.55); } 70% { box-shadow: 0 0 0 7px rgba(198,255,61,0); } 100% { box-shadow: 0 0 0 0 rgba(198,255,61,0); } }
  .text { display: flex; align-items: baseline; gap: 8px; transition: opacity .22s ease; }
  .text.swap { opacity: 0; }
  .main b { font-weight: 600; color: #fff; }
  .sub { color: rgba(243,244,241,.55); font-weight: 400; font-size: 12px; }
  .sub kbd { font: inherit; padding: 1px 5px; border-radius: 5px; background: rgba(243,244,241,.12); color: #F3F4F1; }
  button {
    all: unset; cursor: pointer; font: 600 12px/1 "Inter Tight", ui-sans-serif, system-ui, sans-serif;
    padding: 7px 11px; border-radius: 999px; background: #C6FF3D; color: #0B2B2A; flex: none;
    transition: transform .15s ease, background .15s ease;
  }
  button:hover { transform: translateY(-1px); }
  button:focus-visible { outline: 2px solid #C6FF3D; outline-offset: 2px; }
  button.ghost { background: rgba(243,244,241,.12); color: #F3F4F1; }
  button[hidden] { display: none; }
  .bar { position: absolute; left: 14px; right: 14px; bottom: 4px; height: 2px; border-radius: 2px; background: rgba(243,244,241,.10); opacity: 0; transition: opacity .3s ease; }
  .bar i { display: block; height: 100%; width: 0; border-radius: 2px; background: #C6FF3D; transition: width .5s cubic-bezier(.2,.8,.2,1); }
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
    .pill, .text, .bar i, .cursor { transition: none !important; }
    .pill[data-state="idle"] .dot { animation: none; }
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

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fit() {
    pill.style.width = Math.ceil(inner.scrollWidth + 28) + 'px';
  }

  // view: { state, main (html), sub (html), b1: {label, on}, b2: {label, on}, progress: 0..1 }
  function render(view) {
    clearTimeout(collapseTimer);
    mount();
    host.setAttribute('data-state', view.state);
    pill.setAttribute('data-state', view.state);
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
     ELEMENT DESCRIPTORS (robust selectors)
     ================================================================ */
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const looksGenerated = (id) => !id || /\d{3,}|^[0-9a-f-]{8,}$|^(ember|react|radix|mui|headlessui)|^:r|[:]/i.test(id);

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || (t === 'input' && /^(submit|button|reset)$/.test(el.type))) return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea' || t === 'input') return 'textbox';
    return t;
  }

  function textOf(el) {
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type)) return norm(el.value);
    return norm(el.innerText || el.textContent).slice(0, 60);
  }

  function labelText(el) {
    let t = '';
    if (el.labels && el.labels.length) t = norm(el.labels[0].innerText);
    if (!t && el.getAttribute('aria-labelledby')) {
      const l = document.getElementById(el.getAttribute('aria-labelledby'));
      if (l) t = norm(l.innerText);
    }
    return t.slice(0, 60);
  }

  function friendlyLabel(el) {
    return (norm(el.getAttribute('aria-label')) || labelText(el) || norm(el.getAttribute('placeholder')) ||
      (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? '' : textOf(el)) || norm(el.getAttribute('name')) ||
      norm(el.getAttribute('title')) || el.tagName.toLowerCase()).slice(0, 60);
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      if (cur.id && !looksGenerated(cur.id)) { parts.unshift('#' + cssEsc(cur.id)); break; }
      const tag = cur.tagName.toLowerCase();
      let idx = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) idx++;
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  function byText(tag, role, text) {
    if (!text) return [];
    const els = document.querySelectorAll(tag || '*');
    const out = [];
    for (const e of els) if (roleOf(e) === role && textOf(e) === text && visible(e)) out.push(e);
    return out;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const sel = {
      tag,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || '',
      id: looksGenerated(el.id) ? '' : el.id,
      aria: norm(el.getAttribute('aria-label')),
      name: el.getAttribute('name') || '',
      role: roleOf(el),
      text: /^(input|select|textarea)$/.test(tag) && !/^(submit|button|reset)$/.test(el.type) ? '' : textOf(el),
      css: cssPath(el),
    };
    let key;
    if (sel.testid && unique(`[data-testid="${cssEsc(sel.testid)}"]`)) key = 'testid:' + sel.testid;
    else if (sel.id && unique('#' + cssEsc(sel.id))) key = 'id:' + sel.id;
    else if (sel.aria && unique(`${tag}[aria-label="${cssEsc(sel.aria)}"]`)) key = 'aria:' + tag + ':' + sel.aria;
    else if (sel.name && unique(`${tag}[name="${cssEsc(sel.name)}"]`)) key = 'name:' + tag + ':' + sel.name;
    else if (sel.text && byText(tag, sel.role, sel.text).length === 1) key = 'text:' + sel.role + ':' + sel.text;
    else key = 'css:' + sel.css;
    return { key, sel };
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function resolve(target) {
    const s = target.sel || {};
    const tries = [];
    const k = target.key || '';
    const order = ['testid', 'id', 'aria', 'name', 'text', 'css'];
    const first = k.split(':')[0];
    order.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    for (const kind of order) {
      try {
        if (kind === 'testid' && s.testid) tries.push(() => document.querySelector(`[data-testid="${cssEsc(s.testid)}"],[data-test-id="${cssEsc(s.testid)}"],[data-test="${cssEsc(s.testid)}"]`));
        if (kind === 'id' && s.id) tries.push(() => document.getElementById(s.id));
        if (kind === 'aria' && s.aria) tries.push(() => document.querySelector(`${s.tag}[aria-label="${cssEsc(s.aria)}"]`));
        if (kind === 'name' && s.name) tries.push(() => document.querySelector(`${s.tag}[name="${cssEsc(s.name)}"]`));
        if (kind === 'text' && s.text) tries.push(() => byText(s.tag, s.role, s.text)[0] || null);
        if (kind === 'css' && s.css) tries.push(() => document.querySelector(s.css));
      } catch (e) { /* bad selector: skip */ }
    }
    for (const t of tries) {
      let el = null;
      try { el = t(); } catch (e) { el = null; }
      if (el && el.isConnected && visible(el) && !el.disabled) return el;
    }
    return null;
  }

  /* ================================================================
     SENSITIVE FIELDS: never recorded, never typed into
     ================================================================ */
  function isSensitive(el) {
    if (!el || !el.tagName) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)cc-|password|one-time-code/.test(ac)) return true;
    const hay = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText(el), ac].join(' ');
    return S.SENSITIVE_WORDS.test(hay);
  }

  /* ================================================================
     RECORDER
     ================================================================ */
  const TEXTLIKE = /^(text|email|search|tel|url|number|date|datetime-local|month|week|time|)$/;
  const CLICKABLE = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=switch],input[type=submit],input[type=button],input[type=reset],summary';

  function inPill(e) {
    return e.composedPath && e.composedPath().includes(host);
  }

  function canRecord(e) {
    return enabled && !running && e.isTrusted && !inPill(e);
  }

  function heading() {
    const h = document.querySelector('h1');
    return h ? norm(h.innerText).slice(0, 40) : '';
  }

  function baseStep(kind, el) {
    const t = describe(el);
    return {
      kind, target: t, label: friendlyLabel(el), value: null, sensitive: false,
      path: S.pathPattern(location.pathname), url: location.origin + location.pathname + location.search,
      heading: heading(), title: norm(document.title).slice(0, 60), ts: Date.now(),
    };
  }

  async function record(step) {
    const res = await send({ type: 'step', step });
    if (!res) return;
    if (res.learned) {
      readyWorkflows = res.ready || readyWorkflows;
      flash({ state: 'learned', main: 'Learned: <b>' + esc(res.learned.name) + '</b>', sub: res.learned.steps + ' steps' }, 4600);
    }
    if (res.run && !pageGone) startRun(res.run, res.workflow);
  }

  document.addEventListener('click', (e) => {
    if (!canRecord(e)) return;
    const raw = e.target && e.target.closest ? e.target : null;
    if (!raw) return;
    if (raw.closest('input:not([type=submit]):not([type=button]):not([type=reset]),textarea,select,label,[contenteditable=""],[contenteditable=true]')) return;
    const el = raw.closest(CLICKABLE);
    if (!el) return;
    const step = baseStep('click', el);
    if (el.form && (el.type === 'submit' || (el.tagName === 'BUTTON' && !el.getAttribute('type')))) lastSubmitClickTs = Date.now();
    record(step);
  }, true);

  document.addEventListener('change', (e) => {
    if (!canRecord(e)) return;
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName;
    let step;
    if (tag === 'SELECT') {
      step = baseStep('select', el);
      step.value = el.value;
      const opt = el.options[el.selectedIndex];
      step.valueLabel = opt ? norm(opt.text).slice(0, 60) : '';
    } else if (tag === 'TEXTAREA' || (tag === 'INPUT' && TEXTLIKE.test((el.getAttribute('type') || '').toLowerCase()))) {
      step = baseStep('input', el);
      step.value = String(el.value).slice(0, 2000);
    } else if (tag === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) {
      step = baseStep('check', el);
      step.value = !!el.checked;
    } else if (tag === 'INPUT' && el.type === 'password') {
      step = baseStep('input', el);
    } else return;
    if (isSensitive(el)) { step.sensitive = true; step.value = null; delete step.valueLabel; }
    record(step);
  }, true);

  document.addEventListener('submit', (e) => {
    if (!canRecord(e)) return;
    if (Date.now() - lastSubmitClickTs < 1200) return; // the button click already covers it
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    const step = baseStep('submit', form);
    const btn = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
    step.label = btn ? textOf(btn) || 'Submit' : 'Submit form';
    record(step);
  }, true);

  /* ================================================================
     RUNNER
     ================================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function moveCursorTo(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, 40));
    const y = Math.round(r.top + r.height / 2);
    cursor.classList.add('on');
    cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  }

  function tapCursor() {
    cursor.classList.remove('click');
    void cursor.offsetWidth;
    cursor.classList.add('click');
  }

  function showRing(el) {
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
    ring.classList.add('on');
  }

  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus({ preventScroll: true });
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function startFromPill(workflowId) {
    if (running) return;
    const res = await send({ type: 'run-start', workflowId });
    if (res && res.run) startRun(res.run, res.workflow);
  }

  function startRun(run, wf) {
    if (running || !wf || !wf.steps) return;
    const ctl = { aborted: false, waitingOn: null, resumeFn: null, mode: 'running' };
    running = ctl;
    const total = wf.steps.length;

    const progressView = (done) => ({
      state: 'running', main: 'Doing it for you · <b>' + done + '/' + total + '</b>',
      sub: 'Press <kbd>Esc</kbd> to stop', progress: done / total,
    });

    const onKey = (e) => { if (e.key === 'Escape' && e.isTrusted) { e.stopPropagation(); ctl.abort('stopped'); } };
    const onDown = (e) => {
      if (!e.isTrusted || inPill(e)) return;
      if (ctl.mode === 'needs') {
        // While waiting on the person, a click on the flagged element is them doing that step.
        if (ctl.waitingOn && ctl.waitingOn.risky && (e.target === ctl.waitingOn.el || ctl.waitingOn.el.contains(e.target))) {
          ctl.waitingOn.byUser = true;
          send({ type: 'progress', index: ctl.waitingOn.index + 1 });
          setTimeout(() => ctl.resumeFn && ctl.resumeFn(), 50);
        }
        return;
      }
      ctl.abort('stopped');
    };
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onDown, true);

    const cleanup = () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onDown, true);
      cursor.classList.remove('on');
      ring.classList.remove('on');
      running = null;
    };

    ctl.abort = (why) => {
      if (ctl.aborted) return;
      ctl.aborted = true;
      if (ctl.resumeFn) ctl.resumeFn();
      cleanup();
      if (why === 'unload') return; // the next page picks the run back up
      send({ type: 'run-end', status: why === 'stopped' ? 'stopped' : 'error', reason: ctl.reason || '' });
      if (why === 'stopped') flash({ state: 'stopped', main: 'Stopped', sub: 'You have control' }, 3000);
      else flash({ state: 'error', main: esc(ctl.reason || 'Something changed on the page'), sub: 'Stopped' }, 5200);
    };

    const waitForUser = (view) => new Promise((resolve) => {
      ctl.mode = 'needs';
      ctl.resumeFn = () => { ctl.resumeFn = null; ctl.mode = 'running'; resolve(); };
      render(view);
    });

    (async () => {
      render(progressView(run.index));
      await sleep(650);
      for (let i = run.index; i < total; i++) {
        if (ctl.aborted) return;
        const step = wf.steps[i];

        // Right page? A click before this may still be loading the next page.
        if (S.pathPattern(location.pathname) !== step.path) {
          const until = Date.now() + 3000;
          while (Date.now() < until && !ctl.aborted && S.pathPattern(location.pathname) !== step.path) await sleep(100);
          if (ctl.aborted) return;
          if (S.pathPattern(location.pathname) !== step.path) {
            let u;
            try { u = new URL(step.url); } catch (e) { u = null; }
            if (!u || u.host !== location.host) { ctl.reason = 'Can’t open the next page'; return ctl.abort('error'); }
            await send({ type: 'progress', index: i });
            cleanup();
            location.assign(u.href);
            return;
          }
        }

        // Find the element (wait for it to appear).
        let el = null;
        const until = Date.now() + 8000;
        while (!ctl.aborted && Date.now() < until && !(el = resolve(step.target))) await sleep(120);
        if (ctl.aborted) return;
        if (!el) { ctl.reason = 'Couldn’t find “' + step.label + '”'; return ctl.abort('error'); }

        el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        await sleep(320);
        if (ctl.aborted) return;
        moveCursorTo(el);
        await sleep(560);
        if (ctl.aborted) return;

        // Safety rails.
        const sensitive = step.sensitive || isSensitive(el);
        const actText = step.kind === 'submit' ? (() => { const sb = el.querySelector('button[type=submit],input[type=submit],button:not([type])'); return sb ? textOf(sb) : ''; })() : textOf(el);
        const riskyText = (step.kind === 'click' || step.kind === 'submit') && (S.isRisky(step.label) || S.isRisky(actText));
        if (sensitive || riskyText) {
          showRing(el);
          ctl.waitingOn = { el, index: i, risky: riskyText, byUser: false };
          send({ type: 'needs', index: i, reason: sensitive ? 'sensitive' : 'risky', label: step.label });
          await waitForUser({
            state: 'needs',
            main: 'Needs you · <b>' + esc(sensitive ? 'Fill “' + step.label + '”' : 'Click “' + (actText || step.label) + '” yourself') + '</b>',
            sub: sensitive ? 'Tabmate never types here' : 'Tabmate won’t do this one',
            progress: i / total,
            b1: sensitive ? { label: 'Continue', on: () => ctl.resumeFn && ctl.resumeFn() } : null,
            b2: { label: 'Stop', on: () => ctl.abort('stopped') },
          });
          ring.classList.remove('on');
          if (ctl.aborted) return;
          ctl.waitingOn = null;
          if (riskyText) {
            // The person clicked it (it may be loading the next page). Wait a beat, then go on.
            await sleep(700);
            if (ctl.aborted || pageGone) return;
            render(progressView(i + 1));
            continue;
          }
          await send({ type: 'progress', index: i + 1 });
          render(progressView(i + 1));
          continue;
        }

        await send({ type: 'progress', index: i + 1 });
        if (ctl.aborted) return;
        tapCursor();
        render(progressView(i + 1));
        try {
          if (step.kind === 'click') { el.focus && el.focus({ preventScroll: true }); el.click(); }
          else if (step.kind === 'input' || step.kind === 'select') setValue(el, step.value == null ? '' : step.value);
          else if (step.kind === 'check') { if (el.checked !== !!step.value) el.click(); }
          else if (step.kind === 'submit') { el.requestSubmit ? el.requestSubmit() : el.submit(); }
        } catch (e) { ctl.reason = 'Couldn’t do “' + step.label + '”'; return ctl.abort('error'); }
        await sleep(380);
      }
      if (ctl.aborted) return;
      cleanup();
      const res = await send({ type: 'run-end', status: 'done' });
      const saved = res && res.savedMs ? S.formatSaved(res.savedMs) : '';
      flash({ state: 'done', main: 'Done for you', sub: saved ? 'saved ' + saved : '', progress: 1 }, 3800);
    })();
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.type === 'run' && msg.run && !running) startRun(msg.run, msg.workflow);
    if (msg.type === 'refresh') hello();
  });

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
      if (running) running.abort('stopped');
      return hidePill();
    }
    if (res.finished != null) return flash({ state: 'done', main: 'Done for you', sub: res.finished ? 'saved ' + S.formatSaved(res.finished) : '', progress: 1 }, 3800);
    if (res.run && res.workflow && !running) return startRun(res.run, res.workflow);
    if (!running && !collapseTimer) idle();
    else if (!running && host.getAttribute('data-state') === 'idle') idle();
  }

  hello();
})();
