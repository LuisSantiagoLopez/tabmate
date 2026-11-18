// Renders the extension icons (16/32/48/128) from the Tabmate mark.
const { chromium } = require('playwright');
const path = require('path');
const CHROME = process.env.TABMATE_CHROME || path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const D = 'M145 450H426C488 450 482 372 546 372H630C693 372 685 448 750 448H804C851 448 884 481 884 529V681C884 730 853 762 804 762H339C272 762 225 715 225 647V313C225 283 247 259 276 259C305 259 327 283 327 313V450';
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage();
  for (const size of [16, 32, 48, 128, 512]) {
    const stroke = size <= 16 ? 92 : size <= 32 ? 76 : 62;
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent">
      <svg width="${size}" height="${size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
        <rect x="16" y="16" width="992" height="992" rx="232" fill="#0B2B2A"/>
        <g transform="translate(512 512) scale(0.92) translate(-514 -510)">
          <path d="${D}" fill="none" stroke="#C6FF3D" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      </svg></body></html>`);
    const out = size === 512 ? 'store/icon-512.png' : `extension/icons/icon-${size}.png`;
    await p.screenshot({ path: out, omitBackground: true });
  }
  await b.close();
})();
