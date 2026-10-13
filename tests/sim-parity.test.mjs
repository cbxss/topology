import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSim} from '../kit/topo-sim.mjs';
import {observeSim,replayCase} from './helpers/sim-observation.mjs';
import {original as baseline, updates, cases} from './helpers/release-cases.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
for(const item of cases) test(`release parity: ${item.name} ${item.features || 'default'}`,()=>{
 let index=0;
 replayCase(createSim,item,(sim,at)=>{
  const expected=item.expected[index++];
  assert.equal(sim.summary(),expected.summary,`summary at ${at}s`);
  assert.equal(sim.summary(),item.originalExpected[index-1].summary,`preserved S4 summary at ${at}s`);
  assert.equal(digest(observeSim(sim)),expected.sha256,`state at ${at}s`);
 });
});
test('parity observation detects rows, packets, events and breaker changes',()=>{
 const item=baseline.cases.find(c=>c.name==='read-your-writes'&&!c.features);
 const sim=createSim(structuredClone(item.spec));
 for(let i=0;i<600;i++) sim.step(1/60);
 for(const mutate of [()=>sim.nodes.get('pg').store.get('profiles').rows.values().next().value.version++,()=>sim.packets.reverse(),()=>sim.events.push({type:'negative-control'}),()=>sim.edges[0].breaker={state:'open'}]) {
  const before=digest(observeSim(sim)); mutate(); assert.notEqual(digest(observeSim(sim)),before);
 }
});

test('public entry point preserves every S4 export', async () => {
  assert.deepEqual(Object.keys(await import('../kit/topo-sim.mjs')), baseline.exports);
});

test('v1 baseline updates are limited to table cases and preserve S4 summaries',()=>{
 assert.equal(updates.changes.length,16);
 for(const update of updates.changes) {
  const original=baseline.cases.find(c=>c.name===update.name && c.features===update.features);
  assert.ok(original?.spec.nodes.some(n=>n.tables));
  assert.deepEqual(update.expected.map(e=>e.summary),original.expected.map(e=>e.summary));
 }
});
