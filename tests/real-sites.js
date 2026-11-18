// Real public sites (no login): do a task twice by hand, then start it a third time and let Tabmate finish.
// Needs the internet. Results go to screenshots/real-sites.json. Run: npm run test:real
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { sleep, waitFor, pillState, pillText, pillClick, typeInto } = H;

const CASES = [
  {
    name: 'the-internet.herokuapp.com: open Checkboxes, tick 1, untick 2',
    async run(p, store) {
      const home = 'https://the-internet.herokuapp.com/';
      async function once({ startOnly = false } = {}) {
        await p.goto(home, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitFor(async () => (await pillState(p)) !== null, 8000);
        await p.click('a[href="/checkboxes"]');
        await p.waitForURL(/checkboxes/);
        await p.waitForSelector('#checkboxes input');
        await sleep(400);
        if (startOnly) return;
        await p.click('#checkboxes input:nth-of-type(1)');
        await p.click('#checkboxes input:nth-of-type(2)');
        await sleep(400);
      }
      await once();
      await once();
      const wf = (await store()).workflows[0];
      if (!wf || wf.steps.length !== 3) return { ok: false, detail: 'learned: ' + (wf ? wf.steps.map((s) => s.kind).join(',') : 'nothing') };
      await sleep(4800);
      await once({ startOnly: true });
      await waitFor(async () => (await pillState(p)) === 'done', 20000, 100);
      const boxes = await p.$$eval('#checkboxes input', (b) => b.map((x) => x.checked));
      return { ok: boxes[0] === true && boxes[1] === false, detail: 'checked=' + JSON.stringify(boxes) + ' pill=' + (await pillText(p)) };
    },
  },
  {
    name: 'the-internet.herokuapp.com: log in (password waits for you)',
    async run(p, store) {
      // After the first login, typing into this page in the same headless tab goes nowhere
      // (same without Tabmate). Each visit gets a fresh tab, like opening the bookmark again.
      const fill = async (sel, text) => {
        await p.focus(sel);
        await p.keyboard.press('ControlOrMeta+A');
        await p.keyboard.type(text, { delay: 5 });
      };
      async function once(user, { startOnly = false } = {}) {
        const old = p;
        p = await old.context().newPage();
        await old.close();
        await p.goto('https://the-internet.herokuapp.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await p.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 }).catch(() => {});
        await waitFor(async () => (await pillState(p)) !== null, 8000);
        await sleep(800);
        await fill('#username', user);
        await p.keyboard.press('Tab');
        await sleep(200);
        if (startOnly) return;
        await fill('#password', 'SuperSecretPassword!');
        await p.keyboard.press('Enter');
        await p.waitForURL(/secure/, { timeout: 20000 });
        await sleep(400);
      }
      await once('tomsmith');
      await once('tomsmith');
      const s = await store();
      const wf = s.workflows[0];
      if (!wf) return { ok: false, detail: 'nothing learned' };
      if (JSON.stringify(s).includes('SuperSecretPassword!')) return { ok: false, detail: 'password was stored' };
      await sleep(4800);
      await once('tomsmith', { startOnly: true });
      const needs = await waitFor(async () => /Needs you/.test(await pillText(p)), 15000, 100);
      if (!needs) return { ok: false, detail: 'no Needs you: ' + (await pillText(p)) + ' · steps ' + wf.steps.map((x) => x.kind).join(',') };
      const typed = await p.inputValue('#password');
      await p.fill('#password', 'SuperSecretPassword!');
      await pillClick(p, 'b1');
      const ok = await waitFor(async () => /secure/.test(p.url()), 15000, 200);
      const flash = ok ? await p.textContent('#flash').catch(() => '') : '';
      return { ok: !!ok && typed === '' && /logged into a secure area/i.test(flash), detail: 'steps ' + wf.steps.map((x) => x.kind).join(',') + ' · Tabmate typed into password: ' + (typed !== '') + ' · ' + p.url() };
    },
  },
  {
    name: 'demoqa.com/text-box: fill the form and submit',
    async run(p, store) {
      async function once(name, email, { startOnly = false } = {}) {
        await p.goto('https://demoqa.com/text-box', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await p.waitForSelector('#userName', { timeout: 30000 });
        await waitFor(async () => (await pillState(p)) !== null, 8000);
        await sleep(800);
        await typeInto(p, '#userName', name);
        await typeInto(p, '#userEmail', email);
        if (startOnly) return;
        await typeInto(p, '#currentAddress', '1 Main St');
        await typeInto(p, '#permanentAddress', '2 Side Ave');
        await p.click('#submit');
        await p.waitForSelector('#output #name', { timeout: 10000 });
        await sleep(400);
      }
      await once('Ana Test', 'ana@example.com');
      await once('Ben Test', 'ben@example.com');
      const wf = (await store()).workflows[0];
      if (!wf || wf.steps.length !== 5) return { ok: false, detail: 'learned: ' + (wf ? wf.steps.map((s) => s.kind + ':' + s.label).join(',') : 'nothing') };
      await sleep(4800);
      await once('Cara Test', 'cara@example.com', { startOnly: true });
      await waitFor(async () => (await pillState(p)) === 'done' || (await pillState(p)) === 'error', 30000, 200);
      const out = await p.textContent('#output').catch(() => '');
      return { ok: /Cara Test/.test(out) && /cara@example\.com/.test(out) && /2 Side Ave/.test(out), detail: (out || '').replace(/\s+/g, ' ').slice(0, 140) + ' · pill=' + (await pillText(p)) };
    },
  },
  {
    name: 'todomvc.com React: add a todo (Enter key) and tick it',
    async run(p, store) {
      const url = 'https://todomvc.com/examples/react/dist/';
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      const input = '.new-todo, #todo-input';
      await p.waitForSelector(input);
      await waitFor(async () => (await pillState(p)) !== null, 8000);
      async function once(text, { startOnly = false } = {}) {
        await p.click(input);
        await p.keyboard.type(text, { delay: 10 });
        if (startOnly) { await p.keyboard.press('Tab'); return; }
        await p.keyboard.press('Enter');
        await sleep(300);
        await p.click('.todo-list li:last-child .toggle');
        await sleep(400);
      }
      await once('Buy milk');
      await once('Call mom');
      const wf = (await store()).workflows[0];
      if (!wf) return { ok: false, detail: 'nothing learned' };
      await sleep(4800);
      await once('Pay rent', { startOnly: true });
      await waitFor(async () => (await pillState(p)) === 'done' || (await pillState(p)) === 'error', 20000, 100);
      const items = await p.$$eval('.todo-list li', (l) => l.map((x) => x.textContent.trim() + (x.classList.contains('completed') ? ' [x]' : '')));
      return { ok: items.length === 3 && items[2] === 'Pay rent [x]' && items[0].endsWith('[x]'), detail: JSON.stringify(items) + ' · ' + wf.steps.map((s) => s.kind).join(',') + ' · pill=' + (await pillText(p)) };
    },
  },
];

(async () => {
  const out = [];
  // Public sites can be slow or flaky: each case gets up to 3 tries in a fresh browser.
  const TRIES = Number(process.env.TABMATE_REAL_TRIES || 3);
  for (const c of CASES) {
    console.log('\n' + c.name);
    let r;
    let tries = 0;
    while (tries < TRIES) {
      tries++;
      const t = await H.launch({ allow: () => true });
      try {
        const p = await t.ctx.newPage();
        r = await c.run(p, t.store);
        await p.screenshot({ path: path.join(H.SHOTS, 'real-' + c.name.split(':')[0].replace(/[^a-z0-9]+/gi, '-') + '-' + out.length + '.png') }).catch(() => {});
      } catch (e) {
        r = { ok: false, detail: 'crashed: ' + e.message.split('\n')[0] };
      }
      const swErrors = t.errors.filter((e) => e.startsWith('service worker'));
      if (swErrors.length) r = { ok: false, detail: r.detail + ' · extension errors: ' + swErrors.join(' | ') };
      await t.close();
      if (r.ok) break;
      console.log('  try ' + tries + ' failed: ' + r.detail);
    }
    console.log((r.ok ? '  PASS ' : '  FAIL ') + r.detail + (tries > 1 ? ' (try ' + tries + ')' : ''));
    out.push({ site: c.name, ok: r.ok, tries, detail: r.detail });
  }
  const passed = out.filter((x) => x.ok).length;
  console.log(`\n${passed}/${out.length} real sites passed`);
  fs.writeFileSync(path.join(H.SHOTS, 'real-sites.json'), JSON.stringify({ when: new Date().toISOString(), results: out }, null, 2));
  process.exit(passed === out.length ? 0 : 1);
})();
