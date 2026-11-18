/* Onboarding practice: big coach marks in the sandbox CRM.
   Turned on by welcome.html (sessionStorage "tabmate-guide"). Every element here carries data-tabmate-ui,
   so Tabmate never records clicks on the coach itself. Phases:
   r1 -> r1done -> r2 -> learned | retry -> running -> done | stopped | error, and "known" if Tabmate already learned it. */
(function () {
  'use strict';
  const KEY = 'tabmate-guide';
  let g = null;
  try { g = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { g = null; }
  if (!g || !g.phase) return;
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(g)); } catch (e) { /* ignore */ } };
  const onExport = /export\.html$/.test(location.pathname);
  const welcome = (hash) => { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } location.href = '../welcome.html#' + hash; };

  /* ---------- UI ---------- */
  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    kids.forEach((k) => n.append(k));
    return n;
  };
  const root = h('div', { 'data-tabmate-ui': '', class: 'tg' });
  const barText = h('span', { class: 'tg-bar__text' });
  const barSteps = h('span', { class: 'tg-bar__steps', 'aria-hidden': 'true' });
  for (let i = 0; i < 5; i++) barSteps.append(h('i'));
  const quit = h('button', { type: 'button', class: 'tg-quit' }, 'Leave practice');
  const bar = h('div', { class: 'tg-bar', role: 'status' }, h('span', { class: 'tg-bar__tag' }, 'Practice'), barText, barSteps, quit);
  const ring = h('div', { class: 'tg-ring', 'aria-hidden': 'true' });
  const tipH = h('p', { class: 'tg-tip__h' });
  const tipP = h('p', { class: 'tg-tip__p' });
  const tip = h('div', { class: 'tg-tip', role: 'status', 'aria-live': 'polite' }, tipH, tipP);
  const card = h('div', { class: 'tg-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tgCardH' });
  const veil = h('div', { class: 'tg-veil', hidden: '' }, card);
  root.append(bar, ring, tip, veil);
  document.documentElement.classList.add('tg-on');
  document.body.append(root);
  quit.addEventListener('click', () => welcome('try'));

  /* ---------- coach marks (rounds 1 and 2) ---------- */
  function coachStep() {
    if (!onExport) {
      const status = document.getElementById('status');
      if (status.value !== 'qualified') return { i: 0, el: status, t: 'Pick “Qualified”', p: 'Click this box. Then choose Qualified.' };
      return { i: 1, el: document.querySelector('[data-testid=export-leads]'), t: 'Click Export', p: 'This opens the export page.' };
    }
    const fmt = document.getElementById('format');
    const name = document.getElementById('filename');
    if (!fmt.value) return { i: 2, el: fmt, t: 'Pick “CSV”', p: 'Click this box. Then choose CSV.' };
    if (!name.value.trim()) return { i: 3, el: name, t: 'Type a file name', p: 'Any name works, like my-list.' };
    return { i: 4, el: document.getElementById('createExport'), t: 'Click Create export', p: 'This makes the file.' };
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { left: r.left - 8 + 'px', top: r.top - 8 + 'px', width: r.width + 16 + 'px', height: r.height + 16 + 'px' });
    const tw = tip.offsetWidth || 300, th = tip.offsetHeight || 110;
    const right = innerWidth - r.right, left = r.left;
    let x, side;
    if (right >= tw + 36) { x = r.right + 26; side = 'right'; } else if (left >= tw + 36) { x = r.left - tw - 26; side = 'left'; } else { x = Math.max(12, Math.min(innerWidth - tw - 12, r.left)); side = 'below'; }
    let y = side === 'below' ? r.bottom + 22 : r.top + r.height / 2 - th / 2;
    y = Math.max(84, Math.min(innerHeight - th - 76, y));
    Object.assign(tip.style, { left: x + 'px', top: y + 'px' });
    tip.dataset.side = side;
  }

  let lastStep = -1;
  function paintCoach() {
    if (g.phase !== 'r1' && g.phase !== 'r2') return;
    const s = coachStep();
    if (!s.el) return;
    if (s.i !== lastStep) {
      tipH.textContent = s.t;
      tipP.textContent = s.p;
      tip.classList.remove('tg-bump'); void tip.offsetWidth; tip.classList.add('tg-bump');
      [...barSteps.children].forEach((d, j) => { d.className = j < s.i ? 'past' : j === s.i ? 'now' : ''; });
      lastStep = s.i;
    }
    ring.classList.add('on');
    tip.classList.add('on');
    place(s.el);
  }

  function hideCoach() { ring.classList.remove('on'); tip.classList.remove('on'); }

  /* ---------- cards between rounds ---------- */
  const TICK = '<svg class="tg-tick" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M19 33l9 9 17-19" pathLength="1"/></svg>';
  function showCard({ tick, title, body, buttons }) {
    hideCoach();
    card.textContent = '';
    if (tick) card.insertAdjacentHTML('beforeend', TICK);
    card.append(h('h2', { class: 'tg-card__h', id: 'tgCardH' }, title), h('p', { class: 'tg-card__p' }, body));
    const row = h('div', { class: 'tg-card__actions' });
    buttons.forEach((b, i) => {
      const btn = h('button', { type: 'button', class: i === 0 ? 'tg-btn' : 'tg-link' }, b.label);
      btn.addEventListener('click', b.on);
      row.append(btn);
    });
    card.append(row);
    veil.hidden = false;
    card.classList.remove('tg-in'); void card.offsetWidth; card.classList.add('tg-in');
    setTimeout(() => { const b = card.querySelector('button'); if (b) b.focus(); }, 60);
  }
  function hideCard() { veil.hidden = true; }

  const sandboxFlows = async () => {
    const { workflows } = await chrome.storage.local.get('workflows');
    return (workflows || []).filter((w) => w.enabled && w.steps && w.steps[0] && w.steps[0].site === location.host);
  };

  async function watchMe() {
    g.phase = 'running';
    g.since = Date.now();
    save();
    render();
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'guide-run' }, (x) => r(chrome.runtime.lastError ? null : x)));
    if (!res || !res.ok) { g.phase = 'error'; save(); render(); }
  }

  function render() {
    const round = g.phase === 'r2' || g.phase === 'retry' ? 2 : 1;
    bar.dataset.mode = g.phase === 'running' ? 'run' : '';
    switch (g.phase) {
      case 'r1':
      case 'r2':
        hideCard();
        barText.textContent = round === 1 ? 'Round 1 of 2: show me the task' : 'Round 2 of 2: do it once more';
        lastStep = -1;
        paintCoach();
        break;
      case 'r1done':
        barText.textContent = 'Round 1 of 2: done';
        showCard({ title: 'Nice work!', body: 'Now do it once more, the same way. That is how I learn.', buttons: [{ label: 'Do it once more', on: () => { g.phase = 'r2'; save(); location.href = 'crm.html'; } }] });
        break;
      case 'retry':
        barText.textContent = 'Round 2 of 2';
        showCard({ title: 'Almost!', body: 'I need to see the same steps one more time. Pick Qualified, click Export, then make the file.', buttons: [{ label: 'Try once more', on: () => { g.phase = 'r2'; save(); location.href = 'crm.html'; } }] });
        break;
      case 'learned':
      case 'known':
        barText.textContent = 'You taught me';
        showCard({ tick: true, title: g.phase === 'known' ? 'I already know this one.' : 'I learned it!', body: 'You showed me twice. Now sit back and watch me do it all by myself.', buttons: [{ label: 'Watch me do it', on: watchMe }] });
        break;
      case 'running':
        hideCard();
        hideCoach();
        barText.textContent = 'Hands off. I’m doing it by myself. Press Esc to stop me.';
        break;
      case 'done':
        barText.textContent = 'Practice done';
        showCard({ tick: true, title: 'Done! I did it by myself.', body: 'I picked Qualified, clicked Export and made the file. I can do the same with your real tasks.', buttons: [{ label: 'Next', on: () => welcome('where') }] });
        break;
      case 'stopped':
        barText.textContent = 'You stopped me';
        showCard({ title: 'You stopped me.', body: 'That is how you stop me any time: press Esc or click anywhere.', buttons: [{ label: 'Watch me again', on: watchMe }, { label: 'Go on without it', on: () => welcome('where') }] });
        break;
      default:
        barText.textContent = 'Practice';
        showCard({ title: 'I got stuck.', body: 'Something on the page changed. Let’s try that again.', buttons: [{ label: 'Try again', on: watchMe }, { label: 'Go on without it', on: () => welcome('where') }] });
    }
  }

  /* ---------- events ---------- */
  ['change', 'input', 'focusin'].forEach((t) => document.addEventListener(t, () => setTimeout(paintCoach, 0), true));
  addEventListener('resize', paintCoach);
  addEventListener('scroll', paintCoach, true);
  setInterval(paintCoach, 400);

  const form = document.getElementById('exportForm');
  if (form) form.addEventListener('submit', () => setTimeout(async () => {
    if (g.phase === 'r1') { g.phase = 'r1done'; save(); render(); return; }
    if (g.phase !== 'r2') return;
    hideCoach();
    barText.textContent = 'Let me think…';
    let learned = false;
    for (let i = 0; i < 20 && !learned; i++) { learned = (await sandboxFlows()).length > 0; if (!learned) await new Promise((r) => setTimeout(r, 100)); }
    g.phase = learned ? 'learned' : 'retry';
    save();
    render();
  }, 0));

  function checkRunEnd(log) {
    if (g.phase !== 'running') return;
    const e = (log || []).find((x) => x.ts >= g.since && ['done', 'stopped', 'error'].includes(x.type));
    if (!e) return;
    g.phase = e.type;
    save();
    setTimeout(render, e.type === 'done' ? 900 : 200); // let the pill say "Done" first
  }
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.log) checkRunEnd(c.log.newValue); });
  if (g.phase === 'running') chrome.storage.local.get('log').then((d) => checkRunEnd(d.log));

  render();
})();
