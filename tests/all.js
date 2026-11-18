// Runs every local suite: unit tests, the core extension suite, cross-site + Claude bridge, and the React SPA.
// Real public sites are separate (they need the internet): npm run test:real
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const extra = process.argv.slice(2);

const suites = [
  { name: 'unit', cmd: [process.execPath, '--test', '--test-reporter=tap', 'tests/unit/learn.test.js', 'tests/unit/mcp.test.js'], parse: tap },
  { name: 'core', cmd: [process.execPath, 'tests/run.js', ...extra], parse: tally },
  { name: 'cross-site + Claude bridge', cmd: [process.execPath, 'tests/cross-site.js', ...extra], parse: tally },
  { name: 'react SPA', cmd: [process.execPath, 'tests/spa.js', ...extra], parse: tally },
];

function tally(out) {
  const m = out.match(/(\d+)\/(\d+) passed\s*$/m);
  return m ? { pass: Number(m[1]), total: Number(m[2]) } : { pass: 0, total: 1 };
}
function tap(out) {
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0);
  const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] || 0);
  return { pass, total: pass + fail || 1 };
}

const summary = [];
for (const s of suites) {
  console.log('\n=== ' + s.name + ' ===');
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 15 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(s.name === 'unit' ? out.split('\n').filter((l) => /^(ok|not ok|# (pass|fail))/.test(l)).join('\n') + '\n' : out);
  const t = s.parse(out);
  summary.push(Object.assign({ suite: s.name, ok: r.status === 0 && t.pass === t.total }, t));
}
const pass = summary.reduce((a, s) => a + s.pass, 0);
const total = summary.reduce((a, s) => a + s.total, 0);
console.log('\n=== summary ===');
for (const s of summary) console.log((s.ok ? 'PASS ' : 'FAIL ') + s.suite + ': ' + s.pass + '/' + s.total);
console.log('\n' + pass + '/' + total + ' passed');
fs.mkdirSync(path.join(ROOT, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'screenshots/test-summary.json'), JSON.stringify({ when: new Date().toISOString(), ext: process.env.TABMATE_EXT || 'extension/', pass, total, summary }, null, 2));
process.exit(summary.every((s) => s.ok) ? 0 : 1);
