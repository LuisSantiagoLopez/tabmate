// End-to-end tests for Tabmate. Run: npm test
// Loads the unpacked extension into Chromium (Chrome for Testing) and drives real, trusted input.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = process.env.TABMATE_EXT || path.join(ROOT, 'extension');
const SHOTS = path.join(ROOT, 'screenshots');
const PAGES = path.join(__dirname, 'pages');
const HEADED = process.argv.includes('--headed');
const CHROME = process.env.TABMATE_CHROME ||
  [path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')]
    .find((p) => fs.existsSync(p)); // undefined -> Playwright's bundled Chromium

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const f = path.join(PAGES, path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(PAGES) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function waitFor(fn, ms = 10000, step = 100) {
  const until = Date.now() + ms;
  let v;
  while (Date.now() < until) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

/* ---------- pill helpers (closed shadow root: use CDP with pierce) ---------- */
async function pillState(page) {
  return page.evaluate(() => { const h = document.querySelector('tabmate-pill'); return h ? h.getAttribute('data-state') : null; });
}
async function pillNodes(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let host = null;
  (function walk(n) { if (host) return; if (n.nodeName === 'TABMATE-PILL') host = n; (n.children || []).forEach(walk); })(root);
  return { cdp, sr: host && host.shadowRoots && host.shadowRoots[0] };
}
function findByClass(n, cls) {
  if (!n) return null;
  const a = n.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'class' && a[i + 1].split(' ').includes(cls)) return n;
  for (const c of n.children || []) { const r = findByClass(c, cls); if (r) return r; }
  return null;
}
async function pillText(page) {
  const { cdp, sr } = await pillNodes(page);
  const n = findByClass(sr, 'text');
  if (!n) return '';
  const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: n.nodeId });
  await cdp.detach();
  return outerHTML.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').trim();
}
async function pillClick(page, cls) {
  await sleep(600); // let the pill finish resizing
  const { cdp, sr } = await pillNodes(page);
  const n = findByClass(sr, cls);
  if (!n) throw new Error('pill button not found: ' + cls);
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
  await cdp.detach();
  const q = model.border;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
}

/* ---------- trusted input helpers ---------- */
async function typeInto(page, sel, text) {
  await page.click(sel);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Tab'); // blur fires a trusted change event
  await sleep(120);
}
async function choose(page, sel, value) {
  // Real keyboard selection on a focused <select> (trusted change event).
  await page.focus(sel);
  const label = await page.$eval(sel, (s, v) => [...s.options].find((o) => o.value === v).text, value);
  await page.keyboard.type(label, { delay: 15 }); // type-ahead, like a person
  await page.keyboard.press('Tab');
  await sleep(120);
  const got = await page.$eval(sel, (s) => s.value);
  if (got !== value) throw new Error('select failed: ' + sel + ' = ' + got);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-test-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME,
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'],
  });

  const external = [];
  const errors = [];
  ctx.on('request', (r) => {
    const u = r.url();
    if (!/^(chrome-extension:|data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  const watchPage = (p) => {
    p.on('pageerror', (e) => errors.push(p.url() + ' :: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(p.url() + ' :: ' + m.text()); });
  };
  ctx.on('page', watchPage);
  ctx.pages().forEach(watchPage);

  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  sw.on('console', (m) => { if (m.type() === 'error') errors.push('service worker :: ' + m.text()); });
  const extId = new URL(sw.url()).host;
  const X = (p) => `chrome-extension://${extId}/${p}`;
  const store = () => sw.evaluate(() => chrome.storage.local.get(null));
  const sess = () => sw.evaluate(() => chrome.storage.session.get(null));
  console.log('Extension id', extId);

  try {
    /* ---------- install / onboarding ---------- */
    console.log('\nOnboarding');
    const welcome = await waitFor(() => ctx.pages().find((p) => p.url().includes('welcome.html')), 5000);
    check('welcome page opens on install', !!welcome);
    if (welcome) {
      await welcome.waitForLoadState();
      await sleep(300);
      await welcome.screenshot({ path: path.join(SHOTS, 'welcome.png'), fullPage: true });
    }

    /* ---------- sandbox: learn, then autonomous run ---------- */
    console.log('\nSandbox CRM: learn and take over');
    const page = welcome || (await ctx.newPage());
    async function sandboxTask(n, { finish = true } = {}) {
      await page.goto(X('sandbox/crm.html'));
      await page.waitForSelector('#rows tr');
      await sleep(250);
      await choose(page, '#status', 'qualified');
      await page.click('[data-testid=export-leads]');
      await page.waitForURL(/export\.html/);
      if (!finish) return;
      await page.waitForSelector('#format');
      await sleep(250);
      await choose(page, '#format', 'csv');
      await typeInto(page, '#filename', 'qualified-leads-' + n);
      await page.click('#emails');
      await sleep(100);
      await page.click('#createExport');
      await page.waitForSelector('#result:not([hidden])');
    }
    await page.goto(X('sandbox/crm.html'));
    await waitFor(async () => (await pillState(page)) === 'idle', 5000);
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, 'pill-watching.png') });
    check('pill shows "Watching" on a fresh page', /Watching/.test(await pillText(page)), await pillText(page));

    await sandboxTask(1);
    let s = await store();
    check('no workflow learned after doing the task once', (s.workflows || []).length === 0);
    await sandboxTask(2);
    await sleep(300);
    s = await store();
    const wf = (s.workflows || [])[0];
    check('workflow learned after doing the task twice', !!wf && wf.steps.length === 6, wf && (wf.name + ' · ' + wf.steps.length + ' steps'));
    check('auto name says what it does', wf && /^Export leads on Tabmate sandbox$/.test(wf.name), wf && wf.name);
    check('steps use robust selectors', wf && wf.steps.map((x) => x.target.key.split(':')[0]).join(',') === 'id,testid,id,id,id,id', wf && wf.steps.map((x) => x.target.key).join(' | '));
    const st = await pillState(page);
    const lt = await pillText(page);
    check('pill expands to "Learned: <name>"', st === 'learned' && /Learned: Export leads/.test(lt), st + ' / ' + lt);
    await page.screenshot({ path: path.join(SHOTS, 'pill-learned.png') });
    await sleep(5000);

    // Third time: start it by hand, Tabmate finishes.
    await sandboxTask(3, { finish: false });
    const running = await waitFor(async () => (await pillState(page)) === 'running', 6000, 50);
    check('Tabmate takes over after the first 2 steps', running);
    await waitFor(async () => /Doing it for you · 3\/6|Doing it for you · 4\/6/.test(await pillText(page)), 6000, 50);
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, 'pill-running.png') });
    check('pill shows live step counter', /Doing it for you · \d\/6/.test(await pillText(page)) && /Esc/.test(await pillText(page)), await pillText(page));
    const done = await waitFor(async () => (await pillState(page)) === 'done', 15000, 50);
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, 'pill-done.png') });
    const doneText = await pillText(page);
    check('pill says "Done for you · saved ~N"', done && /Done for you saved ~\d+ (sec|min)/.test(doneText), doneText);
    const result = await page.textContent('#result');
    check('runner completed the export on its own', /qualified-leads-2\.csv · 4 leads with emails/.test(result), result);
    s = await store();
    check('workflow stats updated (runs, time saved, log)', s.workflows[0].runs === 1 && s.workflows[0].savedMs > 0 && s.log.some((l) => l.type === 'done'), 'runs=' + s.workflows[0].runs + ' savedMs=' + s.workflows[0].savedMs);
    check('Tabmate did not learn from its own actions', s.workflows.length === 1);

    // Run from the pill on the start page (crosses a page load).
    console.log('\nSandbox CRM: run from the pill');
    await page.goto(X('sandbox/crm.html'));
    await waitFor(async () => /Run|Export leads/.test(await pillText(page)), 5000);
    await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, 'pill-ready-run.png') });
    await pillClick(page, 'b1');
    await page.waitForURL(/export\.html/, { timeout: 10000 });
    const done2 = await waitFor(async () => (await pillState(page)) === 'done', 15000, 50);
    const r2 = (await page.textContent('#result')) || '';
    check('pill "Run" does the whole workflow across 2 pages', done2 && /qualified-leads-2\.csv · 4 leads with emails/.test(r2), r2);

    /* ---------- local site 1: tickets (single page), Esc and click stop ---------- */
    console.log('\nLocal page: tickets');
    const t = await ctx.newPage();
    await t.goto(BASE + '/tickets.html');
    await waitFor(async () => (await pillState(t)) === 'idle', 5000);
    const rows = () => t.$$eval('#list tr', (r) => r.length);
    async function ticket(title, prio, { finish = true } = {}) {
      await t.click('#newTicket');
      await typeInto(t, '#title', title);
      if (!finish) return;
      await choose(t, '#priority', prio);
      await t.click('#save');
      await sleep(150);
    }
    await ticket('Laptop slow', 'high');
    await ticket('VPN down', 'urgent');
    s = await store();
    const tw = s.workflows.find((w) => w.site.startsWith('127.0.0.1'));
    check('learned a 4-step workflow on a local site', tw && tw.steps.length === 4, tw && tw.name);
    await sleep(5000);
    await t.screenshot({ path: path.join(SHOTS, 'pill-hostile-css.png') });

    const before = await rows();
    await ticket('Printer jammed', null, { finish: false });
    const ran = await waitFor(async () => (await pillState(t)) === 'done', 12000, 50);
    const lastRow = await t.$$eval('#list tr', (r) => r[r.length - 1].innerText);
    check('runner finished the ticket (select + save)', ran && (await rows()) === before + 1 && /Printer jammed\s+urgent/.test(lastRow), lastRow);
    await sleep(4200);

    // Esc stops it.
    const b2 = await rows();
    await ticket('Esc test', null, { finish: false });
    await waitFor(async () => (await pillState(t)) === 'running', 5000, 30);
    await t.keyboard.press('Escape');
    await sleep(150);
    const escState = await pillState(t);
    await t.screenshot({ path: path.join(SHOTS, 'pill-stopped.png') });
    await sleep(2500);
    const sessAfterEsc = await sess();
    check('Esc stops the run instantly', escState === 'stopped' && (await rows()) === b2 && !Object.keys(sessAfterEsc.runs || {}).length, 'state=' + escState + ' rows ' + b2 + '->' + (await rows()));
    s = await store();
    check('activity log records the stop', s.log.some((l) => l.type === 'stopped'));
    await sleep(2000);

    // Any user click stops it.
    const b3 = await rows();
    await ticket('Click test', null, { finish: false });
    await waitFor(async () => (await pillState(t)) === 'running', 5000, 30);
    await t.mouse.click(600, 600);
    await sleep(150);
    const clickState = await pillState(t);
    await sleep(2500);
    check('a user click stops the run', clickState === 'stopped' && (await rows()) === b3, 'state=' + clickState);
    await sleep(2000);

    /* ---------- local site 2: checkout, sensitive fields + risky button ---------- */
    console.log('\nLocal page: checkout (sensitive + risky)');
    const c = await ctx.newPage();
    const SECRETS = ['4242424242424242', 'cvv731x', 'hunter2-Secret!'];
    async function checkout(n, { finish = true } = {}) {
      await c.goto(BASE + '/checkout.html');
      await waitFor(async () => (await pillState(c)) !== null, 5000);
      await sleep(200);
      await typeInto(c, '#fullname', 'Ana Test ' + n);
      await typeInto(c, '#email', 'ana' + n + '@example.test');
      if (!finish) return;
      await typeInto(c, '#cc', SECRETS[0]);
      await typeInto(c, '#cvv', SECRETS[1]);
      await typeInto(c, '#pw', SECRETS[2]);
      await c.click('#payNow');
      await sleep(150);
    }
    await checkout(1);
    await checkout(2);
    const dump = JSON.stringify(await store()) + JSON.stringify(await sess());
    check('card, CVV and password values are never stored', SECRETS.every((x) => !dump.includes(x)), SECRETS.filter((x) => dump.includes(x)).join(',') || 'none found');
    s = await store();
    const cw = s.workflows.find((w) => w.steps.some((x) => x.path === '/checkout.html'));
    const sens = cw ? cw.steps.filter((x) => x.sensitive) : [];
    check('sensitive fields are marked "user must fill"', sens.length === 3 && sens.every((x) => x.value === null), sens.map((x) => x.label).join(', '));
    await sleep(5000);

    await checkout(3, { finish: false });
    const needs = await waitFor(async () => (await pillState(c)) === 'needs', 8000, 50);
    await sleep(400);
    const needsText = await pillText(c);
    await sleep(300);
    await c.screenshot({ path: path.join(SHOTS, 'pill-needs-you.png') });
    check('runner pauses at the card field ("Needs you")', needs && /Needs you · Fill “Card number”/.test(needsText), needsText);
    check('runner never typed into the card field', (await c.inputValue('#cc')) === '');
    await c.fill('#cc', '4000000000000002'); // the person fills it
    await pillClick(c, 'b1');
    await waitFor(async () => /Security code/.test(await pillText(c)), 5000, 50);
    await pillClick(c, 'b1');
    await waitFor(async () => /Account password/.test(await pillText(c)), 5000, 50);
    await pillClick(c, 'b1');
    const riskyNeeds = await waitFor(async () => /Click “Pay now” yourself/.test(await pillText(c)), 6000, 50);
    await sleep(1200);
    check('runner pauses before "Pay now" and does not click it', riskyNeeds && (await c.textContent('#orders')) === '0', 'orders=' + (await c.textContent('#orders')) + ' pill=' + (await pillState(c)) + ' / ' + (await pillText(c)));
    await c.screenshot({ path: path.join(SHOTS, 'pill-needs-you-pay.png') });
    await c.click('#payNow'); // the person clicks it
    const finished = await waitFor(async () => (await pillState(c)) === 'done', 6000, 50);
    check('after the person clicks Pay, the run finishes', finished && (await c.textContent('#orders')) === '1');
    const dump2 = JSON.stringify(await store()) + JSON.stringify(await sess());
    check('secrets still not stored after the run', SECRETS.concat('4000000000000002').every((x) => !dump2.includes(x)));

    /* ---------- popup ---------- */
    console.log('\nPopup');
    const tTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url && x.url.startsWith(u)).id, BASE + '/tickets.html');
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 368, height: 760 });
    await pop.goto(X('popup.html?tab=' + tTabId));
    await pop.waitForSelector('.flow');
    await sleep(300);
    await pop.screenshot({ path: path.join(SHOTS, 'popup.png'), fullPage: true });
    const flowCount = await pop.$$eval('.flow', (f) => f.length);
    check('popup lists learned workflows', flowCount === 3, flowCount + ' workflows');
    check('popup shows activity log', (await pop.$$eval('#log li', (l) => l.length)) > 3);
    check('popup shows open source note, no trial lock', /Open source/.test(await pop.textContent('.foot')) && !/trial|Upgrade/i.test(await pop.textContent('body')));

    // Run now from the popup.
    const b4 = await rows();
    await pop.click(`[data-run="${tw.id}"]`);
    const popupRun = await waitFor(async () => (await pillState(t)) === 'done', 15000, 50);
    check('"Run" in popup runs the workflow in the tab', popupRun && (await rows()) === b4 + 1, (await rows()) - b4 + ' rows added');

    // Watching on this site: off -> pill hides and nothing is recorded.
    await pop.click('#siteOn');
    await sleep(400);
    s = await store();
    const hidden = await waitFor(async () => (await pillState(t)) === 'hidden', 3000);
    const histBefore = JSON.stringify(s.history);
    await t.click('#newTicket');
    await typeInto(t, '#title', 'should not record');
    s = await store();
    check('"Watching on this site" off blocks the site', s.settings.blocked.length === 1 && hidden && JSON.stringify(s.history) === histBefore);
    await pop.click('#siteOn');
    await sleep(400);

    // Global pause.
    await pop.click('#globalOn');
    await sleep(400);
    const pausedHidden = await waitFor(async () => (await pillState(t)) === 'hidden', 3000);
    s = await store();
    check('global pause hides the pill everywhere', s.settings.paused && pausedHidden);
    await pop.click('#globalOn');
    await sleep(400);

    // Toggle a workflow off: it no longer takes over.
    await pop.click(`.flow:has([data-run="${tw.id}"]) .switch input`);
    await sleep(300);
    await t.reload();
    await waitFor(async () => (await pillState(t)) === 'idle', 5000);
    const b5 = await rows();
    await ticket('off test', null, { finish: false });
    await sleep(2500);
    check('a workflow turned off does not run', (await pillState(t)) !== 'running' && (await rows()) === b5);
    await pop.click(`.flow:has([data-run="${tw.id}"]) .switch input`);
    await sleep(300);

    // Delete
    await pop.click(`.flow:has([data-run="${cw.id}"]) .icon`);
    await pop.click(`.flow:has([data-run="${cw.id}"]) .icon`);
    await sleep(300);
    s = await store();
    check('delete removes a workflow', !s.workflows.some((w) => w.id === cw.id));
    await pop.screenshot({ path: path.join(SHOTS, 'popup-after.png'), fullPage: true });

    /* ---------- options: MCP export ---------- */
    console.log('\nMCP export (beta)');
    const o = await ctx.newPage();
    await o.goto(X('options.html'));
    await o.waitForSelector('.tool');
    await sleep(300);
    await o.screenshot({ path: path.join(SHOTS, 'options-mcp-export.png'), fullPage: true });
    const toolNames = await o.$$eval('.tool__name', (n) => n.map((x) => x.textContent));
    check('options lists workflows as MCP tools with JSON schema', toolNames.includes('export_leads_on_tabmate_sandbox') && (await o.$$eval('pre', (p) => p.length)) === toolNames.length, toolNames.join(', '));

    /* ---------- privacy ---------- */
    console.log('\nPrivacy and errors');
    check('no external network requests', external.length === 0, external.slice(0, 5).join(' '));
    const extErrors = errors.filter((e) => !/favicon\.ico/.test(e));
    check('no console errors', extErrors.length === 0, extErrors.slice(0, 5).join(' | '));
  } catch (e) {
    check('test run crashed', false, e.stack);
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(path.join(SHOTS, 'test-results.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
