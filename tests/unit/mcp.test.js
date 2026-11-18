// Unit tests for the tabmate-mcp package: config install and the local link security.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('../../mcp/node_modules/ws');
const { install, uninstall } = require('../../mcp/lib/install');
const { ExtensionLink, hmac } = require('../../mcp/lib/link');

const TOKEN = 'ab'.repeat(24);
const LAUNCH = { command: '/usr/bin/node', args: ['/x/tabmate-mcp.js'] };
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tabmate-home-'));
const desktopFile = (home) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

test('install adds Tabmate to both configs, keeps other servers, and backs up first', () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(desktopFile(home)), { recursive: true });
  fs.writeFileSync(desktopFile(home), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { github: { command: 'gh' } } }));
  const r = install({ token: TOKEN, home, platform: 'darwin', env: {}, launch: LAUNCH });
  assert.deepEqual(r.map((x) => x.status), ['added', 'added']);
  const d = JSON.parse(fs.readFileSync(desktopFile(home), 'utf8'));
  assert.deepEqual(d.mcpServers.other, { command: 'x' });
  assert.equal(d.theme, 'dark');
  assert.deepEqual(d.mcpServers.tabmate, { command: LAUNCH.command, args: LAUNCH.args, env: { TABMATE_TOKEN: TOKEN } });
  const c = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(c.numStartups, 7);
  assert.deepEqual(c.mcpServers.github, { command: 'gh' });
  assert.equal(c.mcpServers.tabmate.type, 'stdio');
  assert.ok(r.every((x) => x.backup && fs.existsSync(x.backup)), 'backups written');
  assert.equal(JSON.parse(fs.readFileSync(r[0].backup, 'utf8')).mcpServers.tabmate, undefined, 'backup is the old file');
  const again = install({ token: TOKEN, home, platform: 'darwin', env: {}, launch: LAUNCH });
  assert.deepEqual(again.map((x) => x.status), ['updated', 'updated']);
  const un = uninstall({ home, platform: 'darwin', env: {} });
  assert.deepEqual(un.map((x) => x.status), ['removed', 'removed']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(desktopFile(home), 'utf8')).mcpServers), ['other']);
});

test('install skips apps that are not installed and never touches unreadable JSON', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.claude.json'), '{ broken');
  const r = install({ token: TOKEN, home, platform: 'darwin', env: {}, launch: LAUNCH });
  assert.equal(r[0].status, 'skipped');
  assert.equal(r[1].status, 'error');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ broken');
  assert.ok(!fs.existsSync(desktopFile(home)));
});

test('install needs a real token', () => {
  assert.throws(() => install({ token: 'short', home: tmpHome(), platform: 'linux', env: {}, launch: LAUNCH }), /token/);
  assert.throws(() => new ExtensionLink({ token: '' }), /token/);
});

const EXT_ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
async function startLink(port) {
  const link = new ExtensionLink({ token: TOKEN, ports: [port] });
  await link.listen();
  return link;
}
function connect(port, headers) {
  return new WebSocket('ws://127.0.0.1:' + port + '/tabmate', { headers: Object.assign({ Origin: EXT_ORIGIN }, headers) });
}
const once = (ws, ev) => new Promise((r) => ws.once(ev, (...a) => r(a)));

test('link listens on 127.0.0.1 only and answers the probe', async () => {
  const link = await startLink(47901);
  assert.equal(link.server.address().address, '127.0.0.1');
  const get = (host) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 47901, path: '/tabmate-mcp', agent: false, headers: host ? { Host: host } : {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
  assert.equal((await get()).body, 'tabmate-mcp');
  assert.equal((await get('evil.test:47901')).status, 404, 'DNS-rebinding Host is refused');
  link.close();
});

test('link refuses web page origins, foreign hosts and wrong paths', async () => {
  const link = await startLink(47902);
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { Host: 'evil.test:47902' }]) {
    const ws = connect(47902, headers);
    const [err] = await once(ws, 'error');
    assert.match(String(err.message), /403/);
  }
  const ws = new WebSocket('ws://127.0.0.1:47902/other', { headers: { Origin: EXT_ORIGIN } });
  const [err] = await once(ws, 'error');
  assert.match(String(err.message), /403/);
  link.close();
});

test('link needs the pairing token proof, and proves itself back', async () => {
  const link = await startLink(47903);
  const bad = connect(47903);
  const [hello] = await once(bad, 'message');
  assert.equal(JSON.parse(hello).t, 'hello');
  bad.send(JSON.stringify({ t: 'auth', mac: hmac('wrong'.repeat(8), 'x'), nonce: 'n'.repeat(32) }));
  const [code] = await once(bad, 'close');
  assert.equal(code, 4003);
  assert.equal(link.connected, false);

  const good = connect(47903);
  const [h] = await once(good, 'message');
  const mine = 'c'.repeat(32);
  good.send(JSON.stringify({ t: 'auth', mac: hmac(TOKEN, 'tabmate-ext:' + JSON.parse(h).nonce), nonce: mine }));
  const [ok] = await once(good, 'message');
  assert.equal(JSON.parse(ok).mac, hmac(TOKEN, 'tabmate-srv:' + mine), 'server proves it has the token');
  assert.equal(link.connected, true);
  good.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'req') good.send(JSON.stringify({ t: 'res', id: m.id, result: { echo: m.method } })); });
  assert.deepEqual(await link.request('list', {}), { echo: 'list' });
  good.close();
  await once(good, 'close');
  link.close();
});

test('link times out a silent connection', async () => {
  const link = await startLink(47904);
  const ws = connect(47904);
  const [code] = await once(ws, 'close');
  assert.equal(code, 4001);
  link.close();
});
