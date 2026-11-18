// Cross-site workflows, variables and loops, and the Claude bridge (MCP) end to end.
// Site A (one port) has a table of leads. Site B (another port) is a CRM form.
// The person copies name + email of a lead from A into B and clicks "Add contact", twice.
// Then new leads arrive. On the third lead, Tabmate takes over and does every new row.
// Then Claude (an MCP client) runs the same workflow for leads that arrive later.
const path = require('path');
const fs = require('fs');
const H = require('./helpers');
const { Client } = require('../mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');

const { sleep, waitFor, pillState, pillText } = H;

module.exports = async function crossSite() {
  const { results, check } = H.makeChecker('cross-site');
  const srvA = await H.serveDir(path.join(__dirname, 'sites/leads'));
  const srvB = await H.serveDir(path.join(__dirname, 'sites/contacts'));
  const A = 'http://127.0.0.1:' + srvA.address().port;
  const B = 'http://127.0.0.1:' + srvB.address().port;
  const BRIDGE = /^(ws|http):\/\/127\.0\.0\.1:478(2[1-9]|30)\//;
  const t = await H.launch({ allow: (u) => u.startsWith(A) || u.startsWith(B) || BRIDGE.test(u) });
  const { ctx, sw, store } = t;
  const bridgeHits = [];
  ctx.on('request', (r) => { if (BRIDGE.test(r.url())) bridgeHits.push(r.url()); });
  let client = null;
  try {
    console.log('\nCross-site: learn a copy-and-paste task across two sites');
    const pa = await ctx.newPage();
    await pa.goto(A + '/');
    const pb = await ctx.newPage();
    await pb.goto(B + '/');
    await waitFor(async () => (await pillState(pa)) === 'idle' && (await pillState(pb)) === 'idle', 6000);

    const contacts = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('contacts') || '[]'));
    const leads = () => pa.$$eval('#leads tbody tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent)));
    async function copyCell(row, col) {
      await pa.bringToFront();
      await pa.click(`#leads tbody tr:nth-child(${row}) td:nth-child(${col})`, { clickCount: 3 });
      await pa.keyboard.press('ControlOrMeta+C');
      await sleep(200);
    }
    async function pasteInto(sel) {
      await pb.bringToFront();
      await pb.click(sel);
      await pb.keyboard.press('ControlOrMeta+A');
      await pb.keyboard.press('ControlOrMeta+V');
      await sleep(250);
    }
    async function doRow(row, { firstTwoOnly = false } = {}) {
      await copyCell(row, 1);
      await pasteInto('#name');
      if (firstTwoOnly) return;
      await copyCell(row, 2);
      await pasteInto('#email');
      await pb.click('#addContact');
      await sleep(300);
    }

    await doRow(1);
    let s = await store();
    check('nothing learned after one row', (s.workflows || []).length === 0);
    const pasted = await contacts(pb);
    check('real copy and paste worked in the browser', pasted[0] && pasted[0].name === 'Maya Chen' && pasted[0].email === 'maya@lumen.test', JSON.stringify(pasted));
    await doRow(2);
    await sleep(400);
    s = await store();
    const wf = (s.workflows || [])[0];
    check('learned one workflow after two rows', s.workflows.length === 1 && wf.steps.length === 5, wf && wf.name + ' · ' + wf.steps.map((x) => x.kind).join(','));
    check('workflow spans two sites in order', wf && wf.sites.length === 2 && wf.sites[0] === new URL(A).host && wf.sites[1] === new URL(B).host, wf && wf.sites.join(' -> '));
    check('steps know which tab they ran in', wf && wf.steps.map((x) => x.tabRef).join('') === '01011', wf && wf.steps.map((x) => x.tabRef).join(''));
    check('copy steps are recorded (selection + clipboard event)', wf && wf.steps.filter((x) => x.kind === 'copy').length === 2 && wf.steps.every((x) => x.kind !== 'copy' || x.value === null), 'copy values not stored in the workflow');
    const vars = wf ? wf.steps.filter((x) => x.var).map((x) => x.label + '<-' + x.var.from + '#' + x.var.step) : [];
    check('typed values that changed became variables filled from copied text', vars.join(',') === 'Name<-copy#0,Email<-copy#2', vars.join(','));
    check('it saw a list handled row by row (loop)', wf && wf.loop && wf.lists[wf.source].stride === 1, wf && JSON.stringify(wf.lists[wf.source] && { mode: wf.lists[wf.source].mode, stride: wf.lists[wf.source].stride }));
    check('name says it crosses sites', wf && / for each row from 127\.0\.0\.1:\d+ to 127\.0\.0\.1:\d+$/.test(wf.name), wf && wf.name);
    await sleep(4800);

    // New leads arrive (4 more). The person starts on the first new one.
    await pa.evaluate(() => window.addLeads(4));
    await sleep(300);
    const activeSeen = new Set();
    const spy = setInterval(async () => {
      try { const u = await sw.evaluate(async () => { const [x] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return x && x.url; }); if (u) activeSeen.add(new URL(u).origin); } catch (e) { /* closing */ }
    }, 150);
    await doRow(3, { firstTwoOnly: true });
    const took = await waitFor(async () => (await pillState(pa)) === 'running' || (await pillState(pb)) === 'running', 8000, 50);
    check('Tabmate takes over on the third row', !!took);
    await waitFor(async () => (await pillState(pb)) === 'running' && /row [2-9]/.test(await pillText(pb)), 30000, 100);
    await sleep(250);
    await pb.screenshot({ path: path.join(H.SHOTS, 'pill-running-cross-site.png') });
    const filled = await waitFor(async () => (await contacts(pb)).length === 6 && (await store()).log.some((l) => l.type === 'done'), 90000, 300);
    clearInterval(spy);
    const got = await contacts(pb);
    const rows = await leads();
    const exact = got.length === 6 && got.every((c, i) => c.name === rows[i][0] && c.email === rows[i][1]);
    check('all new rows processed on the third run (4 of 4, values from each row)', filled && exact, got.map((c) => c.name + '/' + c.email).join('; '));
    check('replay switched between the two sites tabs', activeSeen.has(A) && activeSeen.has(B), [...activeSeen].join(' '));
    s = await store();
    const doneLog = s.log.find((l) => l.type === 'done');
    check('activity log counts the rows', doneLog && /4 rows/.test(doneLog.text), doneLog && doneLog.text);
    check('processed rows are remembered', s.workflows[0].doneKeys.length === 6, s.workflows[0].doneKeys.length);
    check('did not learn from its own actions', s.workflows.length === 1);
    await sleep(4000);

    /* ---------- popup shows the cross-site workflow ---------- */
    console.log('\nPopup: cross-site workflow and Connect to Claude');
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 368, height: 820 });
    await pop.goto(t.X('popup.html'));
    await pop.waitForSelector('.flow');
    const route = await pop.$eval('.flow__route', (r) => ({ sites: r.dataset.sites, text: r.textContent }));
    check('popup shows the route site A → site B and "each new row"', route.sites === '2' && route.text.includes('→') && /each new row/.test(route.text), route.text);
    check('popup shows "Not connected" and the setup command with a token', /Not connected/.test(await pop.textContent('#claudeState')) && /^npx tabmate-mcp install --token [a-f0-9]{48}$/.test(await pop.textContent('#claudeCmd')), await pop.textContent('#claudeCmd'));
    check('bridge is off by default (no local connections before you ask)', !bridgeHits.length && !(await store()).settings.bridge, bridgeHits.length + ' bridge requests');

    /* ---------- MCP end to end ---------- */
    console.log('\nClaude bridge: MCP client -> tabmate-mcp -> extension');
    await pop.click('#copyCmd'); // copying the command turns the bridge on
    await sleep(300);
    s = await store();
    check('copying the command turns on "Claude can run my workflows"', s.settings.bridge === true);
    client = new Client({ name: 'claude-code-test', version: '1.0.0' });
    const stderr = [];
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(H.ROOT, 'mcp/bin/tabmate-mcp.js')],
      env: Object.assign({}, process.env, { TABMATE_TOKEN: s.bridgeToken }), stderr: 'pipe',
    });
    await client.connect(transport);
    if (transport.stderr) transport.stderr.on('data', (d) => stderr.push(String(d)));
    await sw.evaluate(() => bridgeSync()); // same as the 30-second alarm, sooner
    const connected = await waitFor(async () => /Connected to Claude/.test(await pop.textContent('#claudeState')), 15000, 200);
    await pop.screenshot({ path: path.join(H.SHOTS, 'popup-connected.png'), fullPage: true });
    check('popup says "Connected to Claude" once paired', connected, await pop.textContent('#claudeState'));
    const tools = await waitFor(async () => { const r = await client.listTools(); return r.tools.length >= 3 ? r.tools : null; }, 8000, 300);
    const wfTool = (tools || []).find((x) => !['list_workflows', 'run_workflow'].includes(x.name));
    check('MCP lists list_workflows, run_workflow and one tool per workflow', tools && tools.some((x) => x.name === 'list_workflows') && tools.some((x) => x.name === 'run_workflow') && !!wfTool, (tools || []).map((x) => x.name).join(', '));
    check('workflow tool has a description and input schema', wfTool && /Repeats for every new row/.test(wfTool.description) && wfTool.inputSchema.type === 'object' && 'max_rows' in wfTool.inputSchema.properties, wfTool && wfTool.description);
    const listed = await client.callTool({ name: 'list_workflows', arguments: {} });
    check('list_workflows returns the learned workflow', !listed.isError && listed.content[0].text.includes(wfTool.name), listed.content[0].text.slice(0, 120));

    // Two more leads arrive. Tab B is closed: Tabmate must open it.
    await pb.close();
    await pa.evaluate(() => window.addLeads(2));
    const before = ctx.pages().length;
    const res = await client.callTool({ name: 'run_workflow', arguments: { workflow: wfTool.name } }, undefined, { timeout: 120000 });
    const text = res.content[0].text;
    const pb2 = ctx.pages().find((p) => p.url().startsWith(B));
    const after = pb2 ? await contacts(pb2) : [];
    const rows2 = await leads();
    check('run_workflow through MCP processed only the 2 new rows', !res.isError && /Done: .* \(2 rows\)/.test(text) && after.length === 8 && after[7].name === rows2[7][0] && after[6].email === rows2[6][1], text.split('\n')[0] + ' · contacts=' + after.length);
    check('replay opened the closed site B in a new tab', !!pb2 && ctx.pages().length === before + 1, pb2 && pb2.url());
    const again = await client.callTool({ name: wfTool.name, arguments: {} }, undefined, { timeout: 60000 });
    check('per-workflow tool works, and says when there is nothing new', !again.isError && /Nothing new/.test(again.content[0].text), again.content[0].text.split('\n')[0]);
    const unknown = await client.callTool({ name: 'run_workflow', arguments: { workflow: 'nope' } });
    check('unknown workflow is a clear error', unknown.isError && /No learned workflow/.test(unknown.content[0].text));

    // Turning the bridge off disconnects Claude.
    await pop.click('#bridgeOn');
    const off = await waitFor(async () => /Not connected/.test(await pop.textContent('#claudeState')), 5000, 200);
    const r2 = await client.callTool({ name: 'run_workflow', arguments: { workflow: wfTool.name } }, undefined, { timeout: 60000 }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    check('turning it off disconnects Claude and runs are refused', off && r2.isError && /not connected/i.test(r2.content[0].text), r2.content[0].text.slice(0, 80));
    check('MCP server wrote nothing to stderr', !stderr.join('').trim(), stderr.join('').slice(0, 200));

    console.log('\nPrivacy and errors');
    const ext = t.external;
    check('only local requests (two test sites + 127.0.0.1 bridge)', ext.length === 0, ext.slice(0, 5).join(' '));
    const errs = t.errors.filter((e) => !/favicon\.ico/.test(e));
    check('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  } catch (e) {
    check('cross-site suite crashed', false, e.stack);
  } finally {
    if (client) await client.close().catch(() => {});
    await t.close();
    srvA.close();
    srvB.close();
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
