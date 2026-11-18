// First-time user: follows the onboarding exactly like a new person would, with real clicks and typing.
// welcome -> practice (round 1, round 2) -> "I learned it!" -> Tabmate does it alone -> where I work -> Claude -> done.
// Saves a screenshot of every screen to screenshots/onboarding/.
const path = require('path');
const fs = require('fs');
const H = require('./helpers');
const { sleep, waitFor, pillState, typeInto, choose } = H;

const OUT = path.join(H.SHOTS, 'onboarding');

module.exports = async function onboardingSuite() {
  const { results, check } = H.makeChecker('onboarding');
  fs.mkdirSync(OUT, { recursive: true });
  const t = await H.launch({ keepWelcome: true });
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png') });
  const text = (p, sel) => p.locator(sel).first().innerText().then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
  const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
  try {
    console.log('\nWelcome screens');
    const p = await waitFor(() => t.ctx.pages().find((x) => x.url().includes('welcome.html')), 6000);
    check('onboarding opens by itself on install', !!p);
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.waitForSelector('[data-screen="hi"]:not([hidden])');
    await sleep(1900); // let the mark finish drawing
    check('screen 1 headline', (await text(p, '[data-screen="hi"] h1')) === "Hi, I'm Tabmate.", await text(p, '[data-screen="hi"] h1'));
    check('screen 1 says what Tabmate does', (await text(p, '[data-screen="hi"] .lede')) === 'I learn your boring tasks and then do them for you.');
    check('screen 1 has one big button: "Let\'s go"', (await p.locator('[data-screen="hi"] button').count()) === 1 && (await text(p, '[data-screen="hi"] button')) === "Let's go");
    check('5 progress dots, first one active', (await p.locator('#dots li').count()) === 5 && (await p.locator('#dots li').first().getAttribute('class')) === 'now');
    check('no Back button on the first screen', !(await visible(p, '#back')) || (await p.locator('#back').isHidden()) || (await p.$eval('#back', (b) => b.hidden)));
    await shot(p, '01-hi');

    await p.getByRole('button', { name: "Let's go" }).click();
    await p.waitForSelector('[data-screen="try"]:not([hidden])');
    await sleep(700);
    check('screen 2 headline', (await text(p, '[data-screen="try"] h1')) === "Let's try it.");
    check('screen 2 shows the plan: you, you, me', (await text(p, '.plan')) === 'You Do a small task You Do it once more Me I do it alone', await text(p, '.plan'));
    check('screen 2 buttons: "Start the practice" + "Skip for now"', await visible(p, '#startDemo') && (await text(p, '#startDemo')) === 'Start the practice' && (await text(p, '[data-screen="try"] .link')) === 'Skip for now');
    check('second dot is active', (await p.locator('#dots li').nth(1).getAttribute('class')) === 'now');
    await shot(p, '02-try');

    // Keyboard: left arrow goes back, Back button works too.
    await p.keyboard.press('ArrowLeft');
    await sleep(300);
    check('left arrow goes back a screen', await visible(p, '[data-screen="hi"]'));
    await p.keyboard.press('ArrowRight');
    await sleep(300);
    check('right arrow goes forward a screen', await visible(p, '[data-screen="try"]'));

    console.log('\nPractice: round 1');
    await p.click('#startDemo');
    await p.waitForURL(/sandbox\/crm\.html/);
    await p.waitForSelector('.tg-tip.on');
    await sleep(600);
    check('practice bar says "Round 1 of 2"', /Round 1 of 2/.test(await text(p, '.tg-bar__text')), await text(p, '.tg-bar__text'));
    const tip = () => text(p, '.tg-tip__h');
    check('coach mark 1: Pick “Qualified”', (await tip()) === 'Pick “Qualified”', await tip());
    await shot(p, '03-practice-pick');

    async function round(n) {
      if (n > 1) { await p.waitForSelector('.tg-tip.on'); await sleep(500); }
      await choose(p, '#status', 'qualified');
      await sleep(300);
      const t2 = await tip();
      if (n === 1) { check('coach mark 2: Click Export', t2 === 'Click Export', t2); await shot(p, '04-practice-export'); }
      await p.click('[data-testid=export-leads]');
      await p.waitForURL(/export\.html/);
      await p.waitForSelector('.tg-tip.on');
      await sleep(400);
      const t3 = await tip();
      if (n === 1) check('coach mark 3: Pick “CSV”', t3 === 'Pick “CSV”', t3);
      await choose(p, '#format', 'csv');
      await sleep(300);
      const t4 = await tip();
      if (n === 1) { check('coach mark 4: Type a file name', t4 === 'Type a file name', t4); await shot(p, '05-practice-name'); }
      await typeInto(p, '#filename', 'my-list');
      await sleep(300);
      const t5 = await tip();
      if (n === 1) check('coach mark 5: Click Create export', t5 === 'Click Create export', t5);
      await p.click('#createExport');
    }
    await round(1);
    await p.waitForSelector('.tg-veil:not([hidden])');
    await sleep(600);
    check('after round 1: "Nice work!" card', (await text(p, '.tg-card__h')) === 'Nice work!', await text(p, '.tg-card__h'));
    check('card button: "Do it once more"', (await text(p, '.tg-card button')) === 'Do it once more');
    let s = await t.store();
    check('nothing learned after once', (s.workflows || []).length === 0);
    await shot(p, '06-round1-done');

    console.log('\nPractice: round 2');
    await p.getByRole('button', { name: 'Do it once more' }).click();
    await p.waitForURL(/crm\.html/);
    await p.waitForSelector('.tg-bar');
    check('practice bar says "Round 2 of 2"', /Round 2 of 2/.test(await text(p, '.tg-bar__text')), await text(p, '.tg-bar__text'));
    await round(2);
    await p.waitForSelector('.tg-veil:not([hidden])', { timeout: 8000 });
    await sleep(900);
    check('after round 2: "I learned it!"', (await text(p, '.tg-card__h')) === 'I learned it!', await text(p, '.tg-card__h'));
    check('card button: "Watch me do it"', (await text(p, '.tg-card button')) === 'Watch me do it');
    s = await t.store();
    const wf = (s.workflows || [])[0];
    check('learned the 5-step export (coach clicks not recorded)', !!wf && wf.steps.length === 5, wf && wf.steps.map((x) => x.kind + ':' + x.label).join(' | '));
    await shot(p, '07-learned');

    console.log('\nTabmate does it alone');
    const before = s.log.length;
    await p.getByRole('button', { name: 'Watch me do it' }).click();
    const ran = await waitFor(async () => (await pillState(p)) === 'running', 8000, 50);
    check('Tabmate starts by itself', !!ran);
    await waitFor(async () => /export\.html/.test(p.url()) && (await p.$('.tg-bar')), 8000, 50);
    await waitFor(async () => /Doing it for you · [345]\/5/.test(await H.pillText(p)), 8000, 30);
    await sleep(250);
    check('bar says hands off + Esc', /Hands off.*Esc/.test(await text(p, '.tg-bar__text')), await text(p, '.tg-bar__text'));
    await shot(p, '08-doing-it');
    await p.waitForSelector('.tg-veil:not([hidden])', { timeout: 20000 });
    await sleep(800);
    check('"Done! I did it by myself."', (await text(p, '.tg-card__h')) === 'Done! I did it by myself.', await text(p, '.tg-card__h'));
    const result = await text(p, '#result');
    check('the export was made by Tabmate', /my-list\.csv · 4 leads/.test(result), result);
    s = await t.store();
    check('run logged as done', s.workflows[0].runs === 1 && s.log.length > before && s.log.some((l) => l.type === 'done'));
    await shot(p, '09-done-alone');

    console.log('\nWhere I work, Claude, done');
    await p.getByRole('button', { name: 'Next' }).click();
    await p.waitForURL(/welcome\.html#where/);
    await p.waitForSelector('[data-screen="where"]:not([hidden])');
    await sleep(2900); // the toolbar animation is on the pin step
    check('screen 3 headline', (await text(p, '[data-screen="where"] h1')) === 'Where I work.');
    check('screen 3 explains pin and Esc', /puzzle piece/.test(await text(p, '[data-screen="where"]')) && /Press Esc/.test(await text(p, '[data-screen="where"]')));
    check('screen 3 shows live pin state', /^(Not pinned yet|Pinned\. Nice!)$/.test(await text(p, '#pinState')), await text(p, '#pinState'));
    check('third dot is active', (await p.locator('#dots li').nth(2).getAttribute('class')) === 'now');
    await shot(p, '10-where');

    await p.getByRole('button', { name: 'Next' }).click();
    await p.waitForSelector('[data-screen="claude"]:not([hidden])');
    await sleep(700);
    check('screen 4 headline', (await text(p, '[data-screen="claude"] h1')) === 'Do you use Claude?');
    check('Claude steps are folded away', !(await p.$eval('#claudeHow', (d) => d.open)) && !(await visible(p, '#copyCmd')));
    check('main button says "Skip this"', (await text(p, '#claudeNext')) === 'Skip this');
    await shot(p, '11-claude');
    await p.click('#claudeHow summary');
    await sleep(300);
    const cmd = await text(p, '#claudeCmd');
    check('one command: npx -y github:LuisSantiagoLopez/tabmate-mcp install --token …', /^npx -y github:LuisSantiagoLopez\/tabmate-mcp install --token [a-f0-9]{48}$/.test(cmd), cmd);
    check('main button becomes "Next" when open', (await text(p, '#claudeNext')) === 'Next');
    await p.click('#copyCmd');
    await sleep(300);
    check('Copy button reacts', /^(Copied|Select it)$/.test(await text(p, '#copyCmd')), await text(p, '#copyCmd'));
    s = await t.store();
    check('copying turns on the Claude link', s.settings.bridge === true);
    await shot(p, '12-claude-open');

    await p.click('#claudeNext');
    await p.waitForSelector('[data-screen="done"]:not([hidden])');
    await sleep(1100);
    check('screen 5 headline', (await text(p, '[data-screen="done"] h1')) === "You're all set.");
    check('screen 5 button: "Start using Tabmate"', (await text(p, '#finish')) === 'Start using Tabmate');
    check('last dot is active', (await p.locator('#dots li').nth(4).getAttribute('class')) === 'now');
    await shot(p, '13-done');

    await p.click('#back');
    await sleep(300);
    check('Back button goes back', await visible(p, '[data-screen="claude"]'));
    await p.click('#claudeNext');
    await sleep(300);
    const closed = p.waitForEvent('close', { timeout: 4000 }).then(() => true, () => false);
    await p.click('#finish');
    check('"Start using Tabmate" closes the tab', await closed);

    console.log('\nSmall screen');
    const m = await t.ctx.newPage();
    await m.setViewportSize({ width: 390, height: 780 });
    await m.goto(t.X('welcome.html#where'));
    await sleep(900);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('no sideways scroll at 390px', overflow <= 0, overflow + 'px');
    await shot(m, '14-where-390');
    await m.close();

    console.log('\nPrivacy and errors');
    check('no external network requests', t.external.length === 0, t.external.slice(0, 5).join(' '));
    const errs = t.errors.filter((e) => !/favicon\.ico/.test(e));
    check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  } catch (e) {
    check('onboarding suite crashed', false, e.stack);
  } finally {
    await t.close();
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
