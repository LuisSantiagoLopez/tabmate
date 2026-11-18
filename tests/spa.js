// Robustness on a messy React SPA: random ids and classes on every load, shifting DOM paths,
// late rendering, controlled inputs, a custom dropdown, a same-origin iframe, shadow DOM,
// contenteditable, and a Ctrl+Enter shortcut. Learn it twice, Tabmate does it the third time.
const path = require('path');
const H = require('./helpers');
const { sleep, waitFor, pillState, pillText } = H;

module.exports = async function spa() {
  const { results, check } = H.makeChecker('spa');
  const srv = await H.serveDir(path.join(__dirname, 'sites/spa'), { '/vendor/': path.join(H.ROOT, 'node_modules') + '/' });
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const t = await H.launch({ allow: (u) => u.startsWith(BASE) });
  const { ctx, store } = t;
  try {
    console.log('\nReact SPA: dynamic ids, late render, iframe, shadow DOM, contenteditable, shortcut');
    const p = await ctx.newPage();
    const saved = () => p.$$eval('#saved li', (l) => l.map((x) => x.textContent));
    let load = 0;
    async function fresh() {
      await p.goto(BASE + '/?sp=' + [0, 2, 1][load++ % 3]); // a different number of wrapper divs each time
      await p.waitForSelector('text=New contact');
      await waitFor(async () => (await pillState(p)) === 'idle', 5000);
      await sleep(200);
    }
    async function task(name, notes, { firstTwoOnly = false } = {}) {
      await p.click('text=New contact');
      await p.waitForSelector('label:has-text("Full name")', { timeout: 5000 });
      await p.click('label:has-text("Full name") + input');
      await p.keyboard.type(name, { delay: 10 });
      await p.keyboard.press('Tab'); // leave the field: it's recorded on blur
      await sleep(200);
      if (firstTwoOnly) return;
      await p.click('button[aria-haspopup=listbox]');
      await p.click('[role=option]:has-text("Pro")');
      await p.frameLocator('iframe').locator('#agree').click();
      await p.click('tag-box input');
      await p.keyboard.type('vip', { delay: 10 });
      await p.click('.notes');
      await p.keyboard.type(notes, { delay: 5 });
      await p.keyboard.press('Control+Enter');
      await sleep(400);
    }

    await fresh();
    const ids1 = await p.$eval('text=New contact', (b) => b.id);
    await task('Ana Ruiz', 'Met at expo');
    check('the app saved run 1 (React state, iframe, shadow DOM, contenteditable read back)', (await saved())[0] === 'Ana Ruiz · Pro · Met at expo · vip · agreed', (await saved())[0]);
    await fresh();
    const ids2 = await p.$eval('text=New contact', (b) => b.id);
    check('ids really change between loads', ids1 !== ids2, ids1 + ' vs ' + ids2);
    await task('Ben Ortiz', 'Call back Friday');
    await sleep(400);
    const s = await store();
    const wf = (s.workflows || [])[0];
    if (process.env.DUMP) console.log(JSON.stringify(s.history.filter((h) => h.kind !== 'tab' && h.kind !== 'nav').map((h) => [h.kind, h.target && h.target.key, h.item && [h.item.list.key, h.item.inner, h.item.index]])));
    const kinds = wf ? wf.steps.map((x) => x.kind).join(',') : '';
    check('learned the 8-step task across reloads with random ids', wf && kinds === 'click,input,click,click,check,input,input,key', kinds + ' · ' + (wf && wf.name));
    const keys = wf ? wf.steps.map((x) => (x.target ? x.target.key.split(':')[0] : 'page')).join(',') : '';
    check('no step depends on a random id', wf && wf.steps.every((x) => !x.target || !/^id:.*-[a-z0-9]{5}\d{2}$/.test(x.target.key)), keys);
    check('iframe step remembers its frame, shadow step its host', wf && wf.steps[4].target.sel.frame.length === 1 && wf.steps[5].target.sel.shadow.length === 1);
    check('shortcut recorded as Ctrl+Enter', wf && wf.steps[7].keys && wf.steps[7].keys.ctrl && wf.steps[7].keys.key === 'Enter');
    check('contenteditable recorded as text input', wf && wf.steps[6].editable && wf.steps[6].value === 'Call back Friday');
    await sleep(4500);

    await fresh();
    await task('Cara Diaz', '', { firstTwoOnly: true });
    const took = await waitFor(async () => (await pillState(p)) === 'running', 8000, 50);
    check('Tabmate takes over after New contact + name', !!took, await pillText(p));
    const done = await waitFor(async () => (await saved()).length === 3, 40000, 200);
    const last = (await saved())[2];
    check('third run finished on its own with the right values', done && last === 'Cara Diaz · Pro · Call back Friday · vip · agreed', last || (await pillText(p)));
    check('the name typed by the person was kept (controlled input not overwritten)', last && last.startsWith('Cara Diaz'));
    await sleep(300);
    await p.screenshot({ path: path.join(H.SHOTS, 'spa-done.png') });
    const finalState = await waitFor(async () => (await pillState(p)) === 'done', 5000, 50);
    check('pill says done', !!finalState, await pillText(p));

    console.log('\nPrivacy and errors');
    check('no external network requests', t.external.length === 0, t.external.slice(0, 5).join(' '));
    const errs = t.errors.filter((e) => !/favicon\.ico/.test(e));
    check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  } catch (e) {
    check('spa suite crashed', false, e.stack);
  } finally {
    await t.close();
    srv.close();
  }
  return results;
};

if (require.main === module) {
  module.exports().then((r) => {
    const failed = r.filter((x) => !x.ok);
    console.log(`\n${r.length - failed.length}/${r.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
}
