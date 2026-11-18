/* Tabmate onboarding: one screen at a time, routed by the URL hash (#hi, #try, #where, #claude, #done).
   The practice (screen 2) runs in the sandbox CRM with coach marks (sandbox/guide.js), then comes back to #where. */
(function () {
  'use strict';
  const S = self.TabmateShared;
  const ORDER = ['hi', 'try', 'where', 'claude', 'done'];
  const $ = (id) => document.getElementById(id);
  const screens = Object.fromEntries([...document.querySelectorAll('[data-screen]')].map((s) => [s.dataset.screen, s]));
  const dots = $('dots');
  ORDER.forEach(() => dots.append(document.createElement('li')));
  let current = null;

  function show(name, { push = true } = {}) {
    if (!screens[name]) name = 'hi';
    if (name === current) return;
    const back = current && ORDER.indexOf(name) < ORDER.indexOf(current);
    for (const [k, el] of Object.entries(screens)) {
      el.hidden = k !== name;
      el.classList.remove('enter', 'enter-back');
    }
    if (current) { void screens[name].offsetWidth; screens[name].classList.add(back ? 'enter-back' : 'enter'); }
    current = name;
    const i = ORDER.indexOf(name);
    [...dots.children].forEach((d, j) => { d.className = j < i ? 'past' : j === i ? 'now' : ''; });
    dots.setAttribute('aria-label', 'Step ' + (i + 1) + ' of ' + ORDER.length);
    $('back').hidden = i === 0;
    if (push && location.hash.slice(1) !== name) history.pushState(null, '', '#' + name);
    const h = screens[name].querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    if (name === 'where') watchPin();
  }

  const go = (d) => show(ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(current) + d))]);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t) show(t.dataset.go);
  });
  $('back').addEventListener('click', () => go(-1));
  addEventListener('popstate', () => show(location.hash.slice(1), { push: false }));
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT|SUMMARY)$/.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'ArrowRight' && current !== 'try') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  });

  /* ---------- screen 2: start the practice in the sandbox ---------- */
  $('startDemo').addEventListener('click', async () => {
    const { workflows } = await chrome.storage.local.get('workflows');
    const known = (workflows || []).some((w) => w.enabled && w.steps && w.steps[0] && w.steps[0].site === location.host);
    try { sessionStorage.setItem('tabmate-guide', JSON.stringify({ phase: known ? 'known' : 'r1' })); } catch (e) { /* ignore */ }
    location.href = 'sandbox/crm.html';
  });

  /* ---------- screen 3: is Tabmate pinned? ---------- */
  let pinTimer = null;
  function watchPin() {
    if (pinTimer || !chrome.action || !chrome.action.getUserSettings) return;
    const tick = async () => {
      if (current !== 'where') { clearInterval(pinTimer); pinTimer = null; return; }
      try {
        const s = await chrome.action.getUserSettings();
        const on = !!s.isOnToolbar;
        const el = $('pinState');
        el.dataset.on = on ? '1' : '0';
        el.textContent = on ? 'Pinned. Nice!' : 'Not pinned yet';
      } catch (e) { /* older Chrome */ }
    };
    tick();
    pinTimer = setInterval(tick, 1000);
  }

  /* ---------- screen 4: Claude (optional) ---------- */
  chrome.storage.local.get('bridgeToken').then((d) => { $('claudeCmd').textContent = S.claudeCommand(d.bridgeToken); });
  $('claudeHow').addEventListener('toggle', () => { $('claudeNext').textContent = $('claudeHow').open ? 'Next' : 'Skip this'; });
  $('copyCmd').addEventListener('click', async () => {
    const b = $('copyCmd');
    try { await navigator.clipboard.writeText($('claudeCmd').textContent); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select it'; }
    chrome.runtime.sendMessage({ type: 'set-bridge', on: true }, () => void chrome.runtime.lastError);
    setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  });

  /* ---------- screen 5 ---------- */
  $('finish').addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    if (tab) chrome.tabs.remove(tab.id); else window.close();
  });

  show(location.hash.slice(1) || 'hi', { push: false });
})();
