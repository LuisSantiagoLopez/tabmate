// The guided installer on trytabmate.com/download, as a first-time visitor sees it.
// Desktop (1440 wide): all 6 steps, the real download, Copy, the GIFs, keyboard and Back.
// Phone (390 wide, iPhone): the "runs on desktop Chrome" screen and the email form.
// Usage: node tests/download-page.js [baseUrl] [--save-zip=/abs/path.zip] [--real-insert]
//   --real-insert sends one real row to the waitlist (source "mobile-download"); otherwise the request is checked and stubbed.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { sleep } = H;

const BASE = (process.argv.slice(2).find((a) => /^https?:/.test(a)) || 'https://trytabmate.com').replace(/\/$/, '');
const SAVE = (process.argv.find((a) => a.startsWith('--save-zip=')) || '').split('=')[1];
const REAL_INSERT = process.argv.includes('--real-insert');
const OUT = path.join(H.SHOTS, 'download');
const CHROME = process.env.TABMATE_CHROME || path.join(require('os').homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

(async () => {
  const { results, check } = H.makeChecker('download page');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: !H.HEADED });
  const text = (p, sel) => p.locator(sel).first().innerText().then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const errors = [];
  try {
    /* ---------------- desktop ---------------- */
    console.log('\nDesktop 1440 (' + BASE + '/download)');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const bad = [];
    p.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) bad.push(r.status() + ' ' + r.url()); });
    await p.goto(BASE + '/download', { waitUntil: 'networkidle' });
    check('Web Store note at the top', (await text(p, '#soon')) === 'Coming soon to the Chrome Web Store (1-click install).', await text(p, '#soon'));
    check('step 1: "Download Tabmate" + "Step 1 of 6"', (await text(p, '[data-step="1"] h1')) === 'Download Tabmate' && (await text(p, '#count')) === 'Step 1 of 6');
    check('6 progress dots', (await p.locator('#dots button').count()) === 6);
    check('one big download button', (await text(p, '#dl')) === 'Download Tabmate');
    check('meta says version 0.3.0', /Version 0\.3\.0/.test(await text(p, '[data-step="1"] .meta')), await text(p, '[data-step="1"] .meta'));
    await p.screenshot({ path: path.join(OUT, 'desktop-1-download.png') });

    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('#dl')]);
    const zipPath = SAVE || path.join(OUT, 'tabmate.zip');
    await dl.saveAs(zipPath);
    const size = fs.statSync(zipPath).size;
    check('download is tabmate.zip and not empty', dl.suggestedFilename() === 'tabmate.zip' && size > 50000, dl.suggestedFilename() + ' ' + size + ' bytes');
    await p.waitForSelector('[data-step="2"]:not([hidden])', { timeout: 4000 }).catch(() => {});
    check('clicking download moves to step 2 by itself', (await text(p, '[data-step="2"] h1')) === 'Open the file' && (await text(p, '#count')) === 'Step 2 of 6');
    check('step 2 picks Mac on a Mac, says double-click', /Double-click tabmate\.zip/.test(await text(p, '[data-step="2"] [data-for="mac"]')) && (await p.getAttribute('[data-os="mac"]', 'aria-pressed')) === 'true');
    await sleep(1600);
    await p.screenshot({ path: path.join(OUT, 'desktop-2-open-mac.png') });
    await p.click('[data-os="win"]');
    check('Windows tab says Extract All', /Extract All/.test(await text(p, '[data-step="2"] [data-for="win"]')) && await p.locator('[data-for="mac"]').isHidden());
    await p.screenshot({ path: path.join(OUT, 'desktop-2-open-windows.png') });
    await p.click('[data-os="mac"]');

    await p.click('#next');
    await sleep(500);
    check('step 3: Open Chrome\'s extensions page', (await text(p, '[data-step="3"] h1')) === 'Open Chrome\'s extensions page');
    await p.click('#copyUrl');
    await sleep(300);
    const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('Copy puts chrome://extensions on the clipboard', clip === 'chrome://extensions' && (await text(p, '#copyUrl')) === 'Copied!', clip + ' / ' + (await text(p, '#copyUrl')));
    await sleep(2500);
    await p.screenshot({ path: path.join(OUT, 'desktop-3-copy.png') });

    await p.keyboard.press('ArrowRight');
    await sleep(800);
    check('right arrow goes to step 4: Developer mode', (await text(p, '[data-step="4"] h1')) === 'Turn on Developer mode');
    const gif4 = await p.$eval('[data-step="4"] img', (i) => ({ src: i.currentSrc, w: i.naturalWidth }));
    check('step 4 shows the real Developer mode GIF', /devmode\.gif$/.test(gif4.src) && gif4.w > 0, JSON.stringify(gif4));
    await p.screenshot({ path: path.join(OUT, 'desktop-4-devmode.png') });

    await p.click('#next');
    await sleep(800);
    check('step 5: Click Load unpacked', (await text(p, '[data-step="5"] h1')) === 'Click Load unpacked');
    const gif5 = await p.$eval('[data-step="5"] img', (i) => ({ src: i.currentSrc, w: i.naturalWidth }));
    check('step 5 shows the Load unpacked GIF', /load-unpacked\.gif$/.test(gif5.src) && gif5.w > 0, JSON.stringify(gif5));
    check('step 5 says pick the tabmate folder', /tabmate/.test(await text(p, '[data-step="5"] .do')) && /not the zip/.test(await text(p, '[data-step="5"] .note')));
    await p.screenshot({ path: path.join(OUT, 'desktop-5-load.png') });

    await p.click('#next');
    await sleep(2800);
    check('step 6: Done! Now pin it.', (await text(p, '[data-step="6"] h1')) === 'Done! Now pin it.' && (await text(p, '#count')) === 'Step 6 of 6');
    check('no Next on the last step', await p.locator('#next').isHidden());
    await p.screenshot({ path: path.join(OUT, 'desktop-6-pin.png') });
    await p.click('#prev');
    await sleep(400);
    check('Back works', (await text(p, '#count')) === 'Step 5 of 6');
    await p.click('#dots li:nth-child(1) button');
    await sleep(400);
    check('dots jump to a step', (await text(p, '#count')) === 'Step 1 of 6');
    check('no sideways scroll at 1440', (await overflow(p)) <= 0);
    check('no missing files', bad.length === 0, bad.join(' | '));
    await ctx.close();

    /* ---------------- phone ---------------- */
    console.log('\nPhone 390 (iPhone)');
    const iphone = Object.assign({}, devices['iPhone 13'], { viewport: { width: 390, height: 844 } });
    const mctx = await browser.newContext(iphone);
    const m = await mctx.newPage();
    m.on('pageerror', (e) => errors.push(e.message));
    let posted = null;
    await m.route('**/rest/v1/siteport_waitlist', async (route) => {
      posted = { body: JSON.parse(route.request().postData() || '{}'), headers: route.request().headers() };
      if (REAL_INSERT) return route.continue();
      return route.fulfill({ status: 201, body: '' });
    });
    await m.goto(BASE + '/download', { waitUntil: 'networkidle' });
    check('phone sees "Tabmate runs on desktop Chrome."', await m.locator('#mobile').isVisible() && (await text(m, '#mobile h1')) === 'Tabmate runs on desktop Chrome.' && await m.locator('#installer').isHidden());
    check('Web Store note shows on phones too', await m.locator('#soon').isVisible());
    check('no sideways scroll at 390', (await overflow(m)) <= 0, String(await overflow(m)));
    await m.screenshot({ path: path.join(OUT, 'phone-1-desktop-only.png'), fullPage: true });
    await m.fill('#memail', 'not-an-email');
    await m.click('#mform button');
    check('bad email shows a clear error', /Enter an email like/.test(await text(m, '#merr')) && posted === null);
    const email = REAL_INSERT ? 'qa+mobile-download-' + Date.now() + '@trytabmate.com' : 'person@example.com';
    await m.fill('#memail', email);
    await m.click('#mform button');
    await m.waitForSelector('#mdone:not([hidden])', { timeout: 15000 }).catch(() => {});
    check('email saved with source "mobile-download"', posted && posted.body.email === email && posted.body.source === 'mobile-download', JSON.stringify(posted && posted.body));
    check('thank-you message shows', await m.locator('#mdone').isVisible(), await text(m, '#mdone'));
    await m.screenshot({ path: path.join(OUT, 'phone-2-sent.png'), fullPage: true });
    await m.click('#showSteps');
    await sleep(300);
    check('"Show me the steps anyway" opens the installer', await m.locator('#installer').isVisible());
    for (let i = 1; i <= 6; i++) {
      const o = await overflow(m);
      if (o > 0) { check('no sideways scroll at 390 on step ' + i, false, o + 'px'); break; }
      if (i === 6) check('no sideways scroll at 390 on any step', true);
      if (i === 3) await m.screenshot({ path: path.join(OUT, 'phone-3-step3.png'), fullPage: true });
      if (i < 6) { await m.click('#next'); await sleep(300); }
    }
    await mctx.close();
    check('no page errors', errors.length === 0, errors.join(' | '));
    if (REAL_INSERT) console.log('  real row sent: ' + email);
  } catch (e) {
    check('download page suite crashed', false, e.stack);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
