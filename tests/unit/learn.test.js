// Unit tests for extension/lib/learn.js (pure logic). Run: node --test tests/unit
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../extension/lib/shared.js');
const L = require('../../extension/lib/learn.js');

const A = 'a.test', B = 'b.test';
let clock = 1000;
const list = { key: 'css:#leads > tbody:nth-of-type(1)', sel: {} };
function copy(row, col, value, count = 6) {
  return { kind: 'copy', site: A, tab: 1, path: '/', url: 'http://a.test/', label: 'Copy', value, ts: clock++,
    target: { key: 'css:row' + row + 'col' + col }, item: { list, itemSel: 'tr', index: row, count, cell: 'td:nth-of-type(' + col + ')', isRow: true, generic: true, rowKey: 'row' + row, cells: [] } };
}
function input(id, value, extra) {
  return Object.assign({ kind: 'input', site: B, tab: 2, path: '/', url: 'http://b.test/', label: id, value, ts: clock++, target: { key: 'id:' + id } }, extra || {});
}
function click(id, site = B) {
  return { kind: 'click', site, tab: site === B ? 2 : 1, path: '/', url: 'http://' + site + '/', label: id, value: null, ts: clock++, target: { key: 'id:' + id } };
}
const lead = (r, name, mail) => [copy(r, 1, name), input('name', name), copy(r, 2, mail), input('email', mail), click('add')];

test('signature ignores typed values and the row of a list item', () => {
  assert.equal(L.signature(input('name', 'x')), L.signature(input('name', 'y')));
  assert.equal(L.signature(copy(0, 1, 'a')), L.signature(copy(5, 1, 'b')));
  assert.notEqual(L.signature(copy(0, 1, 'a')), L.signature(copy(0, 2, 'a')));
  assert.notEqual(L.signature(click('add', A)), L.signature(click('add', B)), 'site is part of it');
});

test('two rows handled by hand become one looping cross-site workflow with copy variables', () => {
  const acts = lead(0, 'Maya', 'm@x').concat(lead(1, 'Diego', 'd@x'));
  const wfs = [];
  for (let i = 1; i <= acts.length; i++) L.detect(acts.slice(0, i), wfs, clock);
  assert.equal(wfs.length, 1);
  const wf = wfs[0];
  assert.equal(wf.steps.length, 5);
  assert.deepEqual(wf.sites, [A, B]);
  assert.equal(wf.loop, true);
  assert.equal(wf.lists[list.key].stride, 1);
  assert.deepEqual(wf.steps.map((s) => s.var && s.var.from + s.var.step), [undefined, 'copy0', undefined, 'copy2', undefined]);
  assert.deepEqual(wf.steps.map((s) => s.tabRef), [0, 1, 0, 1, 1]);
  assert.equal(wf.steps[0].value, null, 'copied page text is not stored in the workflow');
  assert.deepEqual(wf.doneKeys, ['row0', 'row1']);
});

test('a rotation of a known workflow is not learned again (it crosses sites)', () => {
  const acts = lead(0, 'Maya', 'm@x').concat(lead(1, 'Diego', 'd@x'), [copy(2, 1, 'Ava')]);
  const wfs = [];
  for (let i = 1; i <= acts.length; i++) L.detect(acts.slice(0, i), wfs, clock);
  assert.equal(wfs.length, 1);
});

test('variables: template around copied text, cell of the row, and ask with last value', () => {
  const e = [copy(0, 1, 'Maya'), input('greet', 'Hi Maya!'), input('note', 'one'), click('go')];
  const x = [copy(1, 1, 'Diego'), input('greet', 'Hi Diego!'), input('note', 'two'), click('go')];
  e[0].item.cells = ['Maya', 'NYC']; x[0].item.cells = ['Diego', 'LA'];
  const e2 = e.concat([]), x2 = x.concat([]);
  e2.splice(3, 0, input('city', 'NYC')); x2.splice(3, 0, input('city', 'LA'));
  const wf = L.buildWorkflow(e2, x2, clock);
  assert.deepEqual(wf.steps[1].var, { from: 'copy', step: 0, prefix: 'Hi ', suffix: '!' });
  assert.deepEqual(wf.steps[2].var, { from: 'ask' });
  assert.equal(wf.steps[2].param, 'note');
  assert.deepEqual(wf.steps[3].var, { from: 'cell', step: 0, col: 1 });
  const run = { copies: { 0: 'Ava' }, cells: { 0: ['Ava', 'Rome'] }, inputs: {} };
  assert.equal(L.valueFor(wf.steps[1], run), 'Hi Ava!');
  assert.equal(L.valueFor(wf.steps[2], run), 'two', 'ask defaults to the last value');
  assert.equal(L.valueFor(wf.steps[2], { inputs: { note: 'three' } }), 'three', 'caller input wins');
  assert.equal(L.valueFor(wf.steps[3], run), 'Rome');
  assert.equal(L.valueFor(wf.steps[1], { copies: {} }), null, 'missing copied text is reported, not guessed');
});

test('list modes: same row is fixed, newest row is last, rows that move the wrong way are rejected', () => {
  const f = L.inferLists([copy(2, 1, 'a')], [copy(2, 1, 'b')]);
  assert.equal(f[list.key].mode, 'fixed');
  const last = L.inferLists([copy(0, 1, 'a', 1)], [copy(1, 1, 'b', 2)]);
  assert.equal(last[list.key].mode, 'last');
  const bad = L.inferLists([copy(0, 1, 'a'), copy(0, 2, 'b')], [copy(1, 1, 'c'), copy(3, 2, 'd')]);
  assert.equal(bad, null);
});

test('trigger: the first steps of a learned workflow start it; a fixed row must match', () => {
  const acts = lead(0, 'Maya', 'm@x').concat(lead(1, 'Diego', 'd@x'));
  const wfs = [];
  for (let i = 1; i <= acts.length; i++) L.detect(acts.slice(0, i), wfs, clock);
  clock += 10;
  const t = L.triggered(acts.concat([copy(2, 1, 'Ava'), input('name', 'Ava')]), wfs);
  assert.ok(t);
  assert.equal(t.index, 2);
  wfs[0].enabled = false;
  assert.equal(L.triggered(acts.concat([copy(3, 1, 'Noah'), input('name', 'Noah')]), wfs), null, 'off means off');
  const fixed = { enabled: true, steps: [copy(2, 1, null), input('n', 'x'), click('go')], lists: { [list.key]: { mode: 'fixed' } }, updatedAt: 0 };
  assert.equal(L.triggered([copy(4, 1, 'z')], [fixed]), null);
  assert.ok(L.triggered([copy(2, 1, 'z')], [fixed]));
});

test('nextRow skips rows already done, both directions', () => {
  assert.equal(L.nextRow(['a', 'b', 'c', 'd'], null, 1, ['a', 'b']), 2);
  assert.equal(L.nextRow(['a', 'b', 'c'], 2, 1, []), -1);
  assert.equal(L.nextRow(['a', 'b', 'c'], null, -1, ['c']), 1);
  const wf = { doneKeys: [] };
  for (let i = 0; i < 600; i++) L.rememberDone(wf, 'k' + i);
  assert.equal(wf.doneKeys.length, 500);
});

test('MCP tool shape: unique names, no reserved names, sensitive fields not exposed', () => {
  const wf = { name: 'List workflows', site: A, sites: [A], steps: [input('name', 'Ana', { param: 'name' }), input('pw', null, { sensitive: true, label: 'Password' }), click('go')] };
  const taken = new Set();
  const t1 = L.toTool(wf, taken);
  const t2 = L.toTool(wf, taken);
  assert.equal(t1.name, 'run_list_workflows');
  assert.notEqual(t1.name, t2.name);
  assert.deepEqual(Object.keys(t1.inputSchema.properties), ['name']);
  assert.match(t1.description, /Password\) is private/);
  assert.ok(/^[a-z0-9_]{1,64}$/.test(t1.name));
});

test('old saved workflows are upgraded in place', () => {
  const old = { site: A, steps: [{ kind: 'input', label: 'Title', value: 'x' }, { kind: 'click', label: 'Save' }] };
  const wf = L.migrate(old);
  assert.equal(wf.steps[0].site, A);
  assert.equal(wf.steps[0].tabRef, 0);
  assert.equal(wf.steps[0].param, 'title');
  assert.deepEqual(wf.sites, [A]);
});
