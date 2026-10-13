import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {check, buildPage, traceText} from '../scripts/page.mjs';
const text = readFileSync(new URL('../references/spec.md', import.meta.url), 'utf8');
const source = text.split('<!-- tested: endpoint-table-recipe -->')[1].match(/```js\n([\s\S]*?)\n```/)[1];
const recipe = () => Function(source.replace('export default', 'return'))();

test('documented recipe builds both themes and demonstrates stale reads then fresh read-back', () => {
  const spec = recipe();
  const lines = [];
  const {warnings} = check(spec, {log: line => lines.push(line)});
  assert.deepEqual(warnings, []);
  const phase = name => lines.find(line => line.startsWith(`phase ${name} `));
  assert.match(phase('behind'), /[1-9][\d.]*\/s stale reads/);
  assert.match(phase('fixed'), /0.0\/s stale reads/);
  assert.match(traceText(spec, 'PUT /profile', {warmup: 14}).join('\n'), /select .*\(stale\)/);
  for (const theme of ['dark', 'light']) {
    const {html} = buildPage(spec, {theme});
    assert.ok(html.includes('Enter inspects it, F fails or restores it'));
    assert.ok(html.includes('Save a profile, then read it'));
  }
});

test('authoring exercise adapts documented fields without importing engine internals', () => {
  const spec = recipe();
  spec.title = 'Save notification preferences';
  spec.records.profiles.fields = {email: ['on', 'off'], digest: ['daily', 'weekly']};
  spec.records.profiles.keys = 12;
  spec.nodes[0].emit['PUT /profile'] = 4;
  const lines = [];
  assert.deepEqual(check(spec, {log: line => lines.push(line)}).warnings, []);
  assert.match(lines.find(line => line.startsWith('phase fixed ')), /0.0\/s stale reads/);
  assert.ok(buildPage(spec).html.includes('notification preferences'));
});

test('documented routing recipe builds and sends classes only to their selected service', () => {
  const source = text.split('<!-- tested: routing-recipe -->')[1].match(/```js\n([\s\S]*?)\n```/)[1];
  const spec = Function(source.replace('export default', 'return'))();
  const {sim, warnings} = check(spec, {log: () => {}});
  assert.deepEqual(warnings, []);
  for (const [node, traffic] of [['dedicated', 'premium'], ['shared', 'standard']]) {
    const arrivals = sim.trafficState.arrivals.filter(a => a.node === node);
    assert.ok(arrivals.length > 0);
    assert.ok(arrivals.every(a => a.traffic === traffic));
  }
  for (const theme of ['dark', 'light']) assert.ok(buildPage(spec, {theme}).html.includes('tp-traffic'));
});
