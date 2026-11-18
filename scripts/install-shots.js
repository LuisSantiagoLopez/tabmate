// Screenshots for the install steps on trytabmate.com/download.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'install');
const EXT = path.join(ROOT, 'extension');
const CHROME = process.env.TABMATE_CHROME || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

async function ring(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.evaluate((b) => {
    const d = document.createElement('div');
    d.className = 'tm-ring';
    Object.assign(d.style, { position: 'fixed', left: b.x - 8 + 'px', top: b.y - 8 + 'px', width: b.width + 16 + 'px', height: b.height + 16 + 'px',
      border: '3px solid #C6FF3D', borderRadius: '12px', boxShadow: '0 0 0 6px rgba(198,255,61,.35)', zIndex: 99999, pointerEvents: 'none' });
    document.body.appendChild(d);
  }, box);
}
const clearRings = (page) => page.evaluate(() => document.querySelectorAll('.tm-ring').forEach((n) => n.remove()));

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-inst-'));
  let ctx = await chromium.launchPersistentContext(userDir, { executablePath: CHROME, headless: true, viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2, args: ['--no-first-run'] });
  let p = ctx.pages()[0] || (await ctx.newPage());
  await p.goto('chrome://extensions');
  await sleep(800);
  await ring(p, '#devMode');
  await p.screenshot({ path: path.join(OUT, 'step-2-devmode.png') });
  await clearRings(p);
  await p.click('#devMode');
  await sleep(600);
  await ring(p, '#loadUnpacked');
  await p.screenshot({ path: path.join(OUT, 'step-3-load-unpacked.png') });
  await ctx.close();

  ctx = await chromium.launchPersistentContext(userDir, { executablePath: CHROME, headless: true, viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2,
    args: ['--no-first-run', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] });
  p = await ctx.newPage();
  await p.goto('chrome://extensions');
  await sleep(1000);
  await ring(p, 'extensions-item');
  await p.screenshot({ path: path.join(OUT, 'step-4-loaded.png') });
  await ctx.close();
  fs.rmSync(userDir, { recursive: true, force: true });
  console.log('saved to', OUT);
})();
