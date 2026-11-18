// Shared helpers for the Tabmate end-to-end suites.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = process.env.TABMATE_EXT || path.join(ROOT, 'extension');
const SHOTS = path.join(ROOT, 'screenshots');
const HEADED = process.argv.includes('--headed');
const CHROME = process.env.TABMATE_CHROME ||
  [path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')]
    .find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChecker(suite) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ suite, name, ok: !!ok, detail: detail == null ? undefined : String(detail).slice(0, 600) });
    console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail != null && detail !== '' ? '  (' + String(detail).slice(0, 300) + ')' : ''));
  };
  return { results, check };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
// Static server for one folder, plus extra mounts { '/vendor/': '/abs/dir' }.
function serveDir(dir, mounts = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      let base = dir, rel = url;
      for (const [prefix, d] of Object.entries(mounts)) if (url.startsWith(prefix)) { base = d; rel = url.slice(prefix.length - 1); }
      let f = path.join(base, path.normalize(rel));
      if (!f.startsWith(base)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function launch({ allow = () => false, keepWelcome = false, userDir: reuse = null } = {}) {
  const userDir = reuse || fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-test-'));
  // No "Save password?" bubble: in headless Chrome it silently steals keyboard focus.
  fs.mkdirSync(path.join(userDir, 'Default'), { recursive: true });
  if (!reuse) fs.writeFileSync(path.join(userDir, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME,
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'],
  });
  const external = [];
  const errors = [];
  ctx.on('request', (r) => { const u = r.url(); if (!/^(chrome-extension:|data:|blob:|about:)/.test(u) && !allow(u)) external.push(u); });
  const watchPage = (p) => {
    p.on('pageerror', (e) => errors.push(p.url() + ' :: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(p.url() + ' :: ' + m.text()); });
  };
  ctx.on('page', watchPage);
  ctx.pages().forEach(watchPage);
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) || (await ctx.waitForEvent('serviceworker'));
  sw.on('console', (m) => { if (m.type() === 'error') errors.push('service worker :: ' + m.text()); });
  const extId = new URL(sw.url()).host;
  // Close the welcome tab so it doesn't get in the way.
  await sleep(600);
  if (!keepWelcome) for (const p of ctx.pages()) if (p.url().includes('welcome.html')) await p.close();
  return {
    ctx, sw, extId, external, errors,
    X: (p) => `chrome-extension://${extId}/${p}`,
    store: () => sw.evaluate(() => chrome.storage.local.get(null)),
    sess: () => sw.evaluate(() => chrome.storage.session.get(null)),
    userDir,
    close: async () => { await ctx.close(); if (!reuse) fs.rmSync(userDir, { recursive: true, force: true }); },
  };
}

async function waitFor(fn, ms = 10000, step = 100) {
  const until = Date.now() + ms;
  let v;
  while (Date.now() < until) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

/* ---------- pill (closed shadow root: CDP with pierce) ---------- */
async function pillState(page) {
  return page.evaluate(() => { const h = document.querySelector('tabmate-pill'); return h ? h.getAttribute('data-state') : null; }).catch(() => null);
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
  try {
    const { cdp, sr } = await pillNodes(page);
    const n = findByClass(sr, 'text');
    if (!n) { await cdp.detach(); return ''; }
    const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: n.nodeId });
    await cdp.detach();
    return outerHTML.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').trim();
  } catch (e) { return ''; }
}
async function pillClick(page, cls) {
  await sleep(600);
  const { cdp, sr } = await pillNodes(page);
  const n = findByClass(sr, cls);
  if (!n) throw new Error('pill button not found: ' + cls);
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
  await cdp.detach();
  const q = model.border;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
}

/* ---------- trusted input ---------- */
async function typeInto(page, sel, text) {
  await page.click(sel);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Tab');
  await sleep(120);
}
// Real keyboard selection on a focused <select> (trusted change event), like a person typing ahead.
async function choose(page, sel, value) {
  await page.focus(sel);
  const label = await page.$eval(sel, (s, v) => [...s.options].find((o) => o.value === v).text, value);
  await page.keyboard.type(label, { delay: 15 });
  await page.keyboard.press('Tab');
  await sleep(120);
  const got = await page.$eval(sel, (s) => s.value);
  if (got !== value) throw new Error('select failed: ' + sel + ' = ' + got);
}

module.exports = { ROOT, EXT, SHOTS, HEADED, sleep, makeChecker, serveDir, launch, waitFor, pillState, pillText, pillClick, typeInto, choose };
