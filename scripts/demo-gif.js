// Records the "third time, Tabmate takes over" moment in the sandbox and saves docs/demo.gif.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = process.env.TABMATE_CHROME || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function choose(page, sel, value) {
  await page.focus(sel);
  const label = await page.$eval(sel, (s, v) => [...s.options].find((o) => o.value === v).text, value);
  await page.keyboard.type(label, { delay: 15 });
  await page.keyboard.press('Tab');
  await sleep(150);
}
async function task(page, X, n, finish) {
  await page.goto(X('sandbox/crm.html'));
  await page.waitForSelector('#rows tr');
  await sleep(finish ? 200 : 1200);
  await choose(page, '#status', 'qualified');
  await sleep(finish ? 0 : 500);
  await page.click('[data-testid=export-leads]');
  await page.waitForURL(/export\.html/);
  if (!finish) return;
  await page.waitForSelector('#format');
  await choose(page, '#format', 'csv');
  await page.click('#filename');
  await page.keyboard.type('qualified-leads-' + n);
  await page.keyboard.press('Tab');
  await page.click('#emails');
  await page.click('#createExport');
  await page.waitForSelector('#result:not([hidden])');
}

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-demo-'));
  const vidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-vid-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME, headless: true, viewport: { width: 1280, height: 800 },
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-first-run'],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const X = (p) => `chrome-extension://${new URL(sw.url()).host}/${p}`;
  const a = await ctx.newPage();
  await task(a, X, 1, true);
  await task(a, X, 2, true);
  await sleep(5000);
  const b = await ctx.newPage();
  await b.bringToFront();
  // Capture frames while the person starts the task and Tabmate finishes it.
  let frames = 0, rec = true;
  const t0 = Date.now();
  const times = [];
  const loop = (async () => {
    while (rec) {
      try { await b.screenshot({ path: path.join(vidDir, 'f' + String(frames).padStart(4, '0') + '.png') }); times.push(Date.now() - t0); frames++; } catch (e) { /* navigating */ }
      await sleep(60);
    }
  })();
  await task(b, X, 3, false);
  await b.waitForFunction(() => document.querySelector('tabmate-pill').getAttribute('data-state') === 'done', null, { timeout: 20000 });
  await sleep(2500);
  rec = false;
  await loop;
  await ctx.close();
  const fps = Math.max(4, Math.round(frames / ((times[times.length - 1] || 1) / 1000)));
  const out = path.join(ROOT, 'docs', 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(vidDir, 'f%04d.png'), '-vf',
    'fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4', out]);
  console.log('saved', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.rmSync(vidDir, { recursive: true, force: true });
})();
