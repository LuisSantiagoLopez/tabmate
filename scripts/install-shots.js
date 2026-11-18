// Real screenshots and short looping GIFs of chrome://extensions for the guided installer on trytabmate.com/download.
// Captured from Chromium with Playwright. The lime cursor and ring are drawn on top of the real page.
// The folder picker in load-unpacked.gif is a drawing (the real one is a system window a browser can't capture).
// Usage: node scripts/install-shots.js [outDir]   (default: ../relay-landing/download/img)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, '..', 'relay-landing', 'download', 'img');
const CHROME = process.env.TABMATE_CHROME || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const W = 1100, HGT = 640, FPS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// Load the extension from a folder called "tabmate", like the one people unzip.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-shots-'));
const EXT = path.join(tmp, 'tabmate');
fs.cpSync(path.join(ROOT, 'extension'), EXT, { recursive: true });

const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.6-6.8L4 20z" fill="#0B2B2A" stroke="#C6FF3D" stroke-width="1.6" stroke-linejoin="round"/></svg>';

async function overlay(page) {
  await page.evaluate((svg) => {
    const c = document.createElement('div');
    c.id = 'tmCursor';
    // chrome://extensions enforces Trusted Types, so drawings go in as data-URL images.
    const img = document.createElement('img');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.width = 34; img.height = 34;
    c.append(img);
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 100000, pointerEvents: 'none', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.35))' });
    const r = document.createElement('div');
    r.id = 'tmRing';
    Object.assign(r.style, { position: 'fixed', zIndex: 99999, pointerEvents: 'none', border: '3px solid #C6FF3D', borderRadius: '14px', opacity: '0' });
    document.body.append(r, c);
  }, CURSOR_SVG);
}
const setCursor = (page, x, y) => page.evaluate(([x, y]) => { const c = document.getElementById('tmCursor'); c.style.transform = `translate(${x - 4}px, ${y - 3}px)`; }, [x, y]);
const setRing = (page, b, glow) => page.evaluate(([b, glow]) => {
  const r = document.getElementById('tmRing');
  if (!b) { r.style.opacity = '0'; return; }
  Object.assign(r.style, { left: b.x - 5 + 'px', top: b.y - 5 + 'px', width: b.width + 10 + 'px', height: b.height + 10 + 'px', opacity: '1', boxShadow: `0 0 0 ${glow}px rgba(198,255,61,.4)` });
}, [b, glow]);

let n = 0;
async function frame(page, dir, times = 1) {
  const buf = await page.screenshot();
  for (let i = 0; i < times; i++) fs.writeFileSync(path.join(dir, String(n++).padStart(4, '0') + '.png'), buf);
}
const ease = (t) => 1 - Math.pow(1 - t, 3);
async function moveTo(page, dir, from, to, steps = 12) {
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await setCursor(page, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await frame(page, dir);
  }
}
async function pulse(page, dir, box, frames = 10) {
  for (let i = 0; i < frames; i++) { await setRing(page, box, 2 + Math.round(6 * Math.abs(Math.sin(i / 3)))); await frame(page, dir); }
}
const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

function gif(dir, name) {
  const pal = path.join(dir, 'pal.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'), '-vf', 'scale=880:-1:flags=lanczos,palettegen=max_colors=96', pal]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.png'), '-i', pal, '-lavfi', 'scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', path.join(OUT, name)]);
}
const newFrames = () => { n = 0; return fs.mkdtempSync(path.join(tmp, 'f-')); };

(async () => {
  const userDir = path.join(tmp, 'profile');
  const opts = { executablePath: CHROME, headless: true, viewport: { width: W, height: HGT }, args: ['--no-first-run'] };

  /* ---------- Step 4: turn on Developer mode ---------- */
  let ctx = await chromium.launchPersistentContext(userDir, opts);
  let p = ctx.pages()[0] || (await ctx.newPage());
  await p.goto('chrome://extensions');
  await sleep(1000);
  await p.screenshot({ path: path.join(OUT, 'ext-page.png') });
  const dev = await p.locator('#devMode').boundingBox();
  let dir = newFrames();
  await overlay(p);
  const start = { x: 560, y: 360 };
  await setCursor(p, start.x, start.y);
  await frame(p, dir, 6);
  await moveTo(p, dir, start, mid(dev), 14);
  await pulse(p, dir, dev, 8);
  await p.click('#devMode');
  await sleep(500);
  await pulse(p, dir, dev, 20);
  await setRing(p, null);
  await frame(p, dir, 6);
  gif(dir, 'devmode.gif');
  await setRing(p, dev, 6);
  await setCursor(p, -100, -100);
  await p.screenshot({ path: path.join(OUT, 'devmode.png') });

  /* ---------- Step 5: Load unpacked, pick the tabmate folder ---------- */
  await setRing(p, null);
  const lu = await p.locator('#loadUnpacked').boundingBox();
  dir = newFrames();
  await setCursor(p, mid(dev).x, mid(dev).y);
  await frame(p, dir, 4);
  await moveTo(p, dir, mid(dev), mid(lu), 14);
  await pulse(p, dir, lu, 10);
  await setRing(p, null);
  // A drawing of the folder picker (the real one is a system window).
  await p.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'tmPicker';
    const draw = (sel) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="330"><foreignObject x="20" y="10" width="520" height="310"><div xmlns="http://www.w3.org/1999/xhtml" style="font:500 14px/1.3 -apple-system,'Segoe UI',system-ui,sans-serif;color:#1f1f1f;width:520px;border-radius:14px;background:#fff;border:1px solid #cfcfcf;overflow:hidden">
      <div style="padding:12px 16px;background:#f3f3f3;border-bottom:1px solid #e3e3e3;font-weight:600">Select the extension folder</div>
      <div style="display:grid;grid-template-columns:130px 1fr;min-height:190px">
        <div style="background:#f7f7f7;padding:12px;color:#666;display:grid;gap:8px;align-content:start"><span>Desktop</span><span style="background:#e4e4e4;border-radius:6px;padding:4px 8px;margin:0 -8px;color:#1f1f1f">Downloads</span><span>Documents</span></div>
        <div style="padding:10px;display:grid;gap:4px;align-content:start">
          <div id="tmFolder" style="${sel ? 'background:#1a73e8;color:#fff;' : ''}display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px"><svg width="22" height="18" viewBox="0 0 22 18"><path d="M1 3a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="#5AA9F7"/></svg>tabmate</div>
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;color:#888"><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1h11l5 5v15H1z" fill="#ddd"/></svg>tabmate.zip</div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e3e3e3"><span style="padding:6px 14px;border-radius:7px;background:#eee">Cancel</span><span id="tmSelect" style="padding:6px 14px;border-radius:7px;background:#1a73e8;color:#fff">Select</span></div></div></foreignObject></svg>`);
    const img = document.createElement('img');
    img.id = 'tmPickerImg';
    img.src = draw(false);
    img.dataset.sel = draw(true);
    d.append(img);
    Object.assign(d.style, { position: 'fixed', inset: '0', display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.18)', zIndex: 99998 });
    document.body.append(d);
  });
  await sleep(300);
  const pick = await p.locator('#tmPickerImg').boundingBox();
  // Spots inside the drawing (20px margin + layout above).
  const folder = { x: pick.x + 20 + 140, y: pick.y + 10 + 52, width: 360, height: 36 };
  const sel = { x: pick.x + 20 + 440, y: pick.y + 10 + 246, width: 64, height: 30 };
  await moveTo(p, dir, mid(lu), mid(folder), 12);
  await p.evaluate(() => { const i = document.getElementById('tmPickerImg'); i.src = i.dataset.sel; });
  await sleep(150);
  await pulse(p, dir, folder, 8);
  await setRing(p, null);
  await moveTo(p, dir, mid(folder), mid(sel), 10);
  await pulse(p, dir, sel, 6);
  await ctx.close();

  // The same page after "Select": Tabmate is loaded.
  ctx = await chromium.launchPersistentContext(userDir, Object.assign({}, opts, { args: ['--no-first-run', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT] }));
  await sleep(800);
  for (const x of ctx.pages()) if (/welcome\.html/.test(x.url())) await x.close();
  p = await ctx.newPage();
  await p.goto('chrome://extensions');
  await sleep(1200);
  const card = await p.locator('extensions-item').first().boundingBox();
  await overlay(p);
  await setCursor(p, mid(sel).x, mid(sel).y);
  await frame(p, dir, 2);
  await pulse(p, dir, card, 26);
  await frame(p, dir, 6);
  gif(dir, 'load-unpacked.gif');
  await setCursor(p, -100, -100);
  await setRing(p, lu, 0);
  await p.screenshot({ path: path.join(OUT, 'load-unpacked.png') });
  await setRing(p, card, 6);
  await p.screenshot({ path: path.join(OUT, 'loaded.png') });
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of ['ext-page.png', 'devmode.gif', 'devmode.png', 'load-unpacked.gif', 'load-unpacked.png', 'loaded.png']) console.log(f, Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + ' KB');
})();
