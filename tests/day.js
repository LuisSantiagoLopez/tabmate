// A simulated work day. Several sites and tabs, repeated tasks mixed with normal browsing,
// and a browser restart at lunch. Checks that Tabmate learns exactly the repeated tasks,
// takes them over by itself after the restart, leaves one-off work alone, and sums the day up in the popup.
const path = require('path');
const fs = require('fs');
const os = require('os');
const H = require('./helpers');
const { sleep, waitFor, pillState, pillText, pillClick, typeInto, choose } = H;

module.exports = async function daySuite() {
  const { results, check } = H.makeChecker('day');
  const OUT = path.join(H.SHOTS, 'day');
  fs.mkdirSync(OUT, { recursive: true });
  const srvT = await H.serveDir(path.join(__dirname, 'pages'));        // site 1: help desk tickets
  const srvC = await H.serveDir(path.join(__dirname, 'sites/contacts')); // site 2: contacts
  const srvL = await H.serveDir(path.join(__dirname, 'sites/leads'));    // site 3: a lead list (just reading)
  const T = 'http://127.0.0.1:' + srvT.address().port;
  const C = 'http://localhost:' + srvC.address().port;
  const L = 'http://127.0.0.1:' + srvL.address().port;
  const local = (u) => u.startsWith(T) || u.startsWith(C) || u.startsWith(L);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-day-'));
  let t = await H.launch({ allow: local, userDir });
  const errors = [];
  const external = [];
  const collect = () => { errors.push(...t.errors); external.push(...t.external); };

  // Work helpers, done the way a person does them.
  async function ticket(p, title, prio, { startOnly = false } = {}) {
    await p.bringToFront();
    await p.click('#newTicket');
    await typeInto(p, '#title', title);
    if (startOnly) return;
    await choose(p, '#priority', prio);
    await p.click('#save');
    await sleep(200);
  }
  async function exportLeads(p, n, { startOnly = false } = {}) {
    await p.bringToFront();
    await p.goto(t.X('sandbox/crm.html'));
    await p.waitForSelector('#rows tr');
    await sleep(250);
    await choose(p, '#status', 'qualified');
    await p.click('[data-testid=export-leads]');
    await p.waitForURL(/export\.html/);
    if (startOnly) return;
    await p.waitForSelector('#format');
    await sleep(200);
    await choose(p, '#format', 'csv');
    await typeInto(p, '#filename', 'daily-leads-' + n);
    await p.click('#createExport');
    await p.waitForSelector('#result:not([hidden])');
  }
  async function browse(p, url) { // reading, scrolling, one click: normal work Tabmate should leave alone
    await p.bringToFront();
    await p.goto(url);
    await sleep(300);
    await p.mouse.wheel(0, 300);
    await sleep(200);
  }
  const rows = (p) => p.$$eval('#list tr', (r) => r.length);

  try {
    console.log('\nMorning: repeated tasks mixed with normal browsing');
    const tickets = await t.ctx.newPage();
    await tickets.goto(T + '/tickets.html');
    const crm = await t.ctx.newPage();
    const contacts = await t.ctx.newPage();
    await contacts.goto(C + '/');
    await waitFor(async () => (await pillState(tickets)) === 'idle', 6000);
    check('pill is quiet while watching ("Watching")', /Watching/.test(await pillText(tickets)), await pillText(tickets));
    await tickets.screenshot({ path: path.join(OUT, '01-watching.png') });

    // Two tasks, in a different order each round, with reading and one-off typing in between.
    await ticket(tickets, 'Laptop slow', 'high');
    await browse(contacts, L + '/');                       // read the lead list
    await exportLeads(crm, 1);
    await browse(contacts, C + '/');
    await typeInto(contacts, '#name', 'Note to self');     // a one-off
    await sleep(800);
    await exportLeads(crm, 2);
    let s = await t.store();
    const ew = s.workflows.find((w) => w.steps[0].site === t.extId);
    check('learned the export task after doing it twice', !!ew && ew.steps.length === 5, ew ? ew.name + ' · ' + ew.steps.length : JSON.stringify(s.workflows.map((w) => w.name)));
    await sleep(500);
    const learnedText = await pillText(crm);
    check('"Learned" toast names the task', /Learned: Export leads/.test(learnedText), learnedText);
    await crm.screenshot({ path: path.join(OUT, '02-learned-toast.png') });
    await sleep(5000);
    await browse(contacts, L + '/');
    await ticket(tickets, 'VPN down', 'urgent');
    s = await t.store();
    const tw = s.workflows.find((w) => w.site === new URL(T).host);
    check('learned the ticket task after doing it twice, with other work in between', !!tw && tw.steps.length === 4, tw ? tw.name + ' · ' + tw.steps.map((x) => x.kind).join(',') : JSON.stringify(s.workflows.map((w) => w.name)));
    check('learned exactly these two tasks, nothing from browsing', s.workflows.length === 2, s.workflows.map((w) => w.name).join(' | '));

    console.log('\nUndo: a task learned by mistake');
    await contacts.goto(C + '/');
    async function addContact(name) {
      await contacts.bringToFront();
      await typeInto(contacts, '#name', name);
      await typeInto(contacts, '#email', name.toLowerCase().replace(/\W+/g, '') + '@example.test');
      await contacts.click('#addContact');
      await sleep(250);
    }
    await sleep(5000);
    await addContact('Ana Ruiz');
    await addContact('Ben Ode');
    const cw = await waitFor(async () => (await t.store()).workflows.find((w) => w.site === new URL(C).host), 3000);
    await waitFor(async () => (await pillState(contacts)) === 'learned', 3000, 50);
    await sleep(450); // let the toast finish growing
    await contacts.screenshot({ path: path.join(OUT, '03-learned-undo.png') });
    check('a third task got learned (contacts)', !!cw, cw && cw.name);
    await pillClick(contacts, 'b2'); // Undo
    await sleep(500);
    s = await t.store();
    check('"Undo" on the toast forgets it', !s.workflows.some((w) => w.site === new URL(C).host) && s.workflows.length === 2 && /Forgot it/.test(await pillText(contacts)), s.workflows.map((w) => w.name).join(' | ') + ' / ' + (await pillText(contacts)));
    await addContact('Cy Lee');
    s = await t.store();
    check('after Undo it does not relearn from the old steps', !s.workflows.some((w) => w.site === new URL(C).host));

    console.log('\nLunch: browser restart');
    collect();
    await t.close();
    await sleep(800);
    t = await H.launch({ allow: local, userDir });
    s = await t.store();
    check('workflows survive a browser restart', s.workflows.length === 2, s.workflows.map((w) => w.name).join(' | '));

    console.log('\nAfternoon: Tabmate takes over by itself');
    const tk = await t.ctx.newPage();
    await tk.goto(T + '/tickets.html');
    await waitFor(async () => (await pillState(tk)) === 'idle', 6000);
    const before = await rows(tk);
    await ticket(tk, 'Printer jammed', null, { startOnly: true });
    const running = await waitFor(async () => (await pillState(tk)) === 'running', 6000, 40);
    await waitFor(async () => /Doing it for you · [34]\/4/.test(await pillText(tk)), 4000, 30);
    await tk.screenshot({ path: path.join(OUT, '04-doing-it.png') });
    check('starting a learned task: it takes over without asking', !!running);
    const done1 = await waitFor(async () => (await pillState(tk)) === 'done', 12000, 50);
    await sleep(350);
    const doneText = await pillText(tk);
    await tk.screenshot({ path: path.join(OUT, '05-done-saved.png') });
    const last = await tk.$$eval('#list tr', (r) => r[r.length - 1].innerText);
    check('it finished the ticket (priority + save)', done1 && (await rows(tk)) === before + 1 && /Printer jammed\s+urgent/.test(last), last);
    check('calm summary: "Done for you · saved ~N"', /Done for you saved ~\d+ (sec|min)/.test(doneText), doneText);
    await sleep(4300);
    check('the summary goes away by itself', /Watching/.test(await pillText(tk)), await pillText(tk));

    const ct = await t.ctx.newPage();
    await browse(ct, C + '/');
    await typeInto(ct, '#name', 'Just looking');
    const cr = await t.ctx.newPage();
    await exportLeads(cr, 3, { startOnly: true });
    const done2 = await waitFor(async () => (await pillState(cr)) === 'done', 15000, 50);
    const res2 = (await cr.textContent('#result').catch(() => '')) || '';
    check('started the export: it finished it by itself', done2 && /daily-leads-2\.csv · 4 leads/.test(res2), res2);

    await browse(ct, L + '/');
    await browse(tk, T + '/tickets.html');
    await tk.click('#newTicket'); // opens the form, then leaves: not the learned task
    await sleep(2500);
    check('one click that looks like the start does not run anything', (await pillState(tk)) !== 'running');

    s = await t.store();
    const tw2 = s.workflows.find((w) => w.site === new URL(T).host);
    const ew2 = s.workflows.find((w) => w.steps[0].site === t.extId);
    const doneLog = s.log.filter((l) => l.type === 'done');
    check('ran exactly the right tasks, once each', tw2.runs === 1 && ew2.runs === 1 && doneLog.length === 2, 'tickets=' + tw2.runs + ' export=' + ew2.runs + ' done=' + doneLog.length);
    check('still only 2 learned tasks at the end of the day', s.workflows.length === 2);

    console.log('\nThe day in the popup');
    const pop = await t.ctx.newPage();
    await pop.setViewportSize({ width: 368, height: 700 });
    await pop.goto(t.X('popup.html?tab=' + (await t.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url && x.url.startsWith(u)).id, T))));
    await pop.waitForSelector('#todayH');
    await sleep(300);
    const head = (await pop.textContent('#todayH')).replace(/\s+/g, ' ');
    check('popup: "Today Tabmate did 2 tasks for you · saved N"', /^Today Tabmate did 2 tasks for you · saved \d+ (sec|min)$/.test(head), head);
    check('popup lists what it did today', (await pop.$$eval('#todayList li', (l) => l.length)) === 2);
    await pop.screenshot({ path: path.join(OUT, '06-popup-today.png'), fullPage: true });

    collect();
    console.log('\nPrivacy and errors');
    check('no requests outside the three local sites', external.length === 0, external.slice(0, 5).join(' '));
    const errs = errors.filter((e) => !/favicon\.ico/.test(e));
    check('no console errors all day', errs.length === 0, errs.slice(0, 5).join(' | '));
  } catch (e) {
    check('day suite crashed', false, e.stack);
  } finally {
    await t.close().catch(() => {});
    fs.rmSync(userDir, { recursive: true, force: true });
    srvT.close(); srvC.close(); srvL.close();
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
