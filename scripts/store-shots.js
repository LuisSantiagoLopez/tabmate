// Builds 1280x800 Chrome Web Store screenshots from the test screenshots. Run after `npm test`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.TABMATE_CHROME || path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const F = (f) => 'file://' + path.join(ROOT, 'extension/fonts', f);
const img = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'screenshots', f)).toString('base64');
const SHOTS = [
  ['store-1-learns.png', 'It learns what you repeat.', 'Do a task twice. Tabmate names it and remembers it.', 'pill-learned.png', 'wide'],
  ['store-2-does-it.png', 'Then it does it for you.', 'Start the task and Tabmate takes over. Press Esc any time.', 'pill-running.png', 'wide'],
  ['store-3-safe.png', 'Your secrets stay yours.', 'Passwords and card fields are never recorded. Pay and delete wait for you.', 'pill-needs-you-pay.png', 'wide'],
  ['store-4-popup.png', 'See everything it learned.', 'Turn workflows on or off, run them, and read what Tabmate did.', 'popup.png', 'tall'],
  ['store-5-start.png', 'Try it in one minute.', 'A built-in sandbox CRM shows the whole loop. Nothing leaves your computer.', 'welcome.png', 'wide'],
];
(async () => {
  const b = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  for (const [out, h, sub, shot, kind] of SHOTS) {
    await p.setContent(`<html><head><style>
      @font-face { font-family: IT; src: url(${F('inter-tight-latin-500-normal.woff2')}); }
      @font-face { font-family: IS; src: url(${F('instrument-serif-latin-400-normal.woff2')}); }
      body { margin: 0; width: 1280px; height: 800px; background: #F3F4F1; color: #0B2B2A; font-family: IT, system-ui; display: grid; grid-template-columns: 380px 1fr; align-items: center; overflow: hidden; }
      .t { padding: 0 24px 0 64px; }
      h1 { font: 400 58px/1 IS, Georgia, serif; letter-spacing: -0.02em; margin: 0 0 18px; }
      p { font-size: 19px; line-height: 1.45; color: #56635F; margin: 0; }
      .m { width: 44px; height: 30px; margin-bottom: 36px; }
      .s { height: 800px; display: flex; align-items: center; justify-content: center; background: #0B2B2A; }
      .s img { display: block; border-radius: 14px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.6); }
      .wide img { width: 840px; height: 525px; object-fit: cover; object-position: top center; }
      .tall img { height: 700px; }
    </style></head><body>
      <div class="t"><svg class="m" viewBox="135 249 759 523"><path fill="none" stroke="#0B2B2A" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" d="M145 450H426C488 450 482 372 546 372H630C693 372 685 448 750 448H804C851 448 884 481 884 529V681C884 730 853 762 804 762H339C272 762 225 715 225 647V313C225 283 247 259 276 259C305 259 327 283 327 313V450"/></svg>
      <h1>${h}</h1><p>${sub}</p></div>
      <div class="s ${kind}"><img src="${img(shot)}"></div></body></html>`);
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(ROOT, 'store', out) });
  }
  await b.close();
})();
