(function () {
  'use strict';
  const S = self.TabmateShared;
  const $ = (id) => document.getElementById(id);
  let tab = null;
  let tabSite = '';

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({}));

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k && k.nodeType ? k : document.createTextNode(k == null ? '' : String(k)));
    return n;
  }

  const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  async function getTab() {
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    if (forced) return chrome.tabs.get(forced).catch(() => null);
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t || null;
  }

  function siteOf(url) {
    try {
      const u = new URL(url);
      return /^(https?|chrome-extension):$/.test(u.protocol) ? u.host : '';
    } catch (e) { return ''; }
  }

  async function render() {
    const d = await chrome.storage.local.get(['settings', 'workflows', 'log']);
    const settings = Object.assign({ paused: false, blocked: [] }, d.settings || {});
    const workflows = d.workflows || [];
    const log = d.log || [];

    $('globalOn').checked = !settings.paused;
    $('pauseLabel').textContent = settings.paused ? 'Paused' : 'On';

    // This site
    const ownPopup = tab && (tab.url || '').startsWith(location.origin + '/popup.html');
    $('siteRow').hidden = !tabSite || ownPopup;
    if (tabSite) {
      const on = !settings.blocked.includes(tabSite);
      $('siteOn').checked = on && !settings.paused;
      $('siteOn').disabled = settings.paused;
      $('siteRow').classList.toggle('off', !on || settings.paused);
      $('siteTitle').textContent = settings.paused ? 'Paused everywhere' : on ? 'Watching on this site' : 'Not watching this site';
      $('siteHost').textContent = S.siteLabel(tabSite);
    }

    // Learned workflows
    const list = $('flows');
    list.textContent = '';
    $('empty').hidden = workflows.length > 0;
    for (const wf of workflows.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      const toggle = el('input', { type: 'checkbox', 'aria-label': 'Turn on ' + wf.name });
      toggle.checked = wf.enabled;
      toggle.addEventListener('change', async () => { await send({ type: 'toggle-workflow', workflowId: wf.id, enabled: toggle.checked }); render(); });
      const run = el('button', { class: 'btn btn--lime btn--sm', type: 'button', 'data-run': wf.id }, 'Run');
      run.disabled = !wf.enabled || settings.paused || settings.blocked.includes(wf.site);
      if (run.disabled) run.style.opacity = '.45';
      run.addEventListener('click', async () => {
        if (!tab) return;
        const r = await send({ type: 'run-now', workflowId: wf.id, tabId: tab.id });
        if (r && r.ok && !new URLSearchParams(location.search).get('tab')) window.close();
      });
      const del = el('button', { class: 'icon', type: 'button', 'aria-label': 'Delete ' + wf.name, title: 'Delete' });
      del.innerHTML = ICON_TRASH; // static markup, no data
      del.addEventListener('click', async () => {
        if (del.dataset.confirm) { await send({ type: 'delete-workflow', workflowId: wf.id }); render(); return; }
        del.dataset.confirm = '1';
        del.textContent = 'Sure?';
        del.style.width = 'auto';
        del.style.padding = '0 8px';
        setTimeout(render, 2500);
      });
      const meta = [S.siteLabel(wf.site), wf.steps.length + ' steps', 'ran ' + wf.runs + '×', 'saved ' + (wf.savedMs ? S.formatSaved(wf.savedMs) : '0 min')].join(' · ');
      list.append(el('li', { class: 'flow' + (wf.enabled ? '' : ' off') },
        el('span', { class: 'flow__name' }, wf.name),
        el('span', { class: 'flow__meta' }, meta),
        el('span', { class: 'flow__ctl' }, run, el('span', { class: 'switch' }, toggle, el('span')), del)));
    }

    // Activity
    const ol = $('log');
    ol.textContent = '';
    $('logEmpty').hidden = log.length > 0;
    for (const e of log.slice(0, 30)) {
      ol.append(el('li', { class: 'k-' + e.type }, el('time', { datetime: new Date(e.ts).toISOString() }, ago(e.ts)), el('span', {}, e.text)));
    }

    // Blocked
    const ul = $('blocked');
    ul.textContent = '';
    $('blockedCount').textContent = settings.blocked.length ? '(' + settings.blocked.length + ')' : '';
    $('blockedEmpty').hidden = settings.blocked.length > 0;
    for (const host of settings.blocked) {
      const b = el('button', { class: 'link', type: 'button' }, 'Unblock');
      b.addEventListener('click', async () => { await send({ type: 'set-site-watch', site: host, on: true }); render(); });
      ul.append(el('li', {}, el('span', {}, S.siteLabel(host)), b));
    }
  }

  $('globalOn').addEventListener('change', async (e) => { await send({ type: 'set-paused', paused: !e.target.checked }); render(); });
  $('siteOn').addEventListener('change', async (e) => { await send({ type: 'set-site-watch', site: tabSite, on: e.target.checked }); render(); });
  $('clearLog').addEventListener('click', async () => { await send({ type: 'clear-log' }); render(); });
  $('openSandbox').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('sandbox/crm.html') }));
  $('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('openUpdates').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: S.UPDATES_URL }); });
  chrome.storage.onChanged.addListener(() => render());

  (async () => {
    tab = await getTab();
    tabSite = tab ? siteOf(tab.url || '') : '';
    render();
  })();
})();
