import test from 'node:test';
import assert from 'node:assert/strict';
import {createSim} from '../kit/topo-sim.mjs';
import {modelOf,simSpec} from '../kit/topo.mjs';
import {observeSim} from './helpers/sim-observation.mjs';
import journey from '../examples/order-journey/order-journey.spec.mjs';
import flagged from '../examples/flagged-projection-rollout/flagged-projection-rollout.spec.mjs';
const spec = () => ({...structuredClone(journey),scenario:undefined,sim:{speed:4000,jitter:false}});
const make = (p=spec(),features=[])=>createSim(simSpec(modelOf(p,features)));
const run = (s,t)=>{for(let i=0;i<t*60;i++)s.step(1/60);return s;};
const refs = s => [...s.entityState.histories.values()].map(h=>h.ref);
const stop = s => s.nodes.get('app').workload.forEach(w=>w.rate=0);
const events = s => [...s.entityState.histories.values()].flatMap(h=>h.events);

test('scoped entity rows, committed snapshots, mapped projections and replicas converge',()=>{
 const s=run(make(),5);stop(s);run(s,3);
 const rows=s.nodes.get('pg').store.get('orders').rows;
 assert.ok(rows.size>3);assert.equal(new Set([...rows.values()].map(r=>r.entity.ref.scope[0])).size,2);
 for(const ref of refs(s)) {
  const e=s.entityOf(ref),primary=e.representations.find(r=>r.authoritative),search=e.representations.find(r=>r.name==='search'),replica=e.representations.find(r=>r.replica);
  assert.ok(primary.row);assert.deepEqual(search.row.fields,{state:primary.row.fields.status,amount:primary.row.fields.total});
  assert.equal(search.sourceRevision,primary.sourceRevision);assert.equal(replica.sourceRevision,primary.sourceRevision);assert.equal(search.behind,false);
 }
 assert.equal(s.entityState.pending.size,0);
 assert.ok(events(s).some(e=>e.outcome==='published'));
});
test('cache gets its own snapshot, expires without packets, and reports incomplete history honestly',()=>{
 const s=run(make(),3);stop(s);run(s,2);const ref=refs(s)[0];
 assert.ok(s.entityOf(ref).representations.find(r=>r.cache).row);
 run(s,8);assert.equal(s.entityOf(ref).representations.find(r=>r.cache).row,null);
 assert.ok(events(s).some(e=>e.outcome==='expired'));
 const snapshot=s.entityOf(ref);snapshot.representations[0].row.fields.status='tamper';
 assert.notEqual(s.entityOf(ref).representations[0].row.fields.status,'tamper');
});
test('optional direct gates skip while required gates fail without fallback',()=>{
 for(const optional of [true,false]) {
  const p=spec();p.flags={enabled:{rollout:0}};
  p.edges=p.edges.map(e=>Array.isArray(e)&&e[0]==='api'&&e[1]==='pg'?{from:'api',to:'pg',flag:'enabled'}:e);
  p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls[0].entityStep.optional=optional;
  // Remove the dependent publication so the result measures only the blocked write.
  p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls.length=1;
  const s=run(make(p),4);assert.equal(s.nodes.get('pg').store.get('orders').rows.size,0);
  assert.ok(events(s).some(e=>e.outcome==='flag-skipped'));
  assert.equal(s.latencyOf().failed>0,!optional);
 }
});
for (const sticky of [true,false]) test(`${sticky ? 'sticky' : 'random'} flag decisions survive queued events and rollback`,()=>{
 const p=spec();p.flags={enabled:{rollout:1,sticky}};
 p.edges=p.edges.map(e=>Array.isArray(e)&&((e[0]==='api'&&e[1]==='pg')||(e[0]==='worker'&&e[1]==='search'))?{from:e[0],to:e[1],flag:'enabled'}:e);
 const s=make(p);s.setUp('worker',false);run(s,3);stop(s);run(s,1);
 s.apply({kill:'enabled'});s.setUp('worker',true);run(s,5);
 assert.ok(s.nodes.get('search').store.get('documents').rows.size>0);
 assert.equal(events(s).filter(e=>e.outcome==='flag-skipped').length,0);
});
test('timeout after commit is visible and cannot publish an unacknowledged result',()=>{
 const p=spec();p.nodes.find(n=>n.id==='pg').ms=100;p.edges=p.edges.map(e=>Array.isArray(e)&&e[0]==='api'&&e[1]==='pg'?{from:'api',to:'pg',timeout:.001,retries:1}:e);
 const s=run(make(p),5);stop(s);run(s,4);
 assert.ok(events(s).some(e=>e.outcome==='committed'));
 assert.equal(s.logs.get('events').appended,0);
 assert.ok(events(s).some(e=>e.outcome==='failed'));assert.equal(s.entityState.pending.size,0);
});
test('source commit followed by publication outage remains committed but unpublished',()=>{
 const p=spec();p.nodes.find(n=>n.id==='events').up=false;
 const s=run(make(p),4);stop(s);run(s,2);
 assert.ok(events(s).some(e=>e.outcome==='committed'));
 assert.ok(events(s).some(e=>e.outcome==='failed'||e.outcome==='publication-failed'));
 assert.equal(events(s).filter(e=>e.outcome==='published').length,0);assert.equal(s.entityState.pending.size,0);
});
test('disabled features remove entity execution without disabling ordinary traffic',()=>{
 for(const feature of ['-entities','-tables','-endpoints']) {
  const s=run(make(spec(),[feature]),3);assert.equal(s.entityState,undefined);assert.ok(s.totalIn()>0);
 }
 const s=run(make(spec(),['-trace']),3);assert.ok(s.entityOf(refs(s)[0]));
 const p=structuredClone(flagged);p.sim={speed:4000,jitter:false};p.flags.search.rollout=0;delete p.scenario;
 assert.ok(events(run(make(p,['-flags']),4)).some(e=>e.step==='index'&&e.outcome==='committed'));
});
test('seeking/replay is deterministic and read-only snapshots cannot consume randomness',()=>{
 const a=run(make(),5),b=run(make(),5);const before=observeSim(a);
 for(const ref of refs(a)) a.entityOf(ref);
 assert.deepEqual(observeSim(a),before);assert.deepEqual(observeSim(a),observeSim(b));
});
test('invalid entity authoring fails at the public boundary',()=>{
 for(const change of [p=>delete p.entities.order.representations.primary.authoritative,p=>p.entities.order.steps.index.input={step:'nope'},p=>p.entities.order.scope=['context.__proto__'],p=>p.entities.order.representations.search.versionPolicy='guess',p=>p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls[0].to='search']) {
  const p=spec();change(p);assert.throws(()=>make(p),/spec/);
 }
 const p=spec();delete p.traffic.north.context.tenant;assert.throws(()=>run(make(p),1),/scope/);
});

test('queued envelopes remain immutable; projection policies handle reordered delivery',()=>{
 for(const policy of ['if-newer','arrival']) {
  const p=spec();p.records.orders.keys=1;p.nodes[0].workload.length=1;p.nodes.find(n=>n.id==='events').partitions=1;
  p.entities.order.representations.search.versionPolicy=policy;
  const s=make(p);s.setUp('worker',false);run(s,4);stop(s);run(s,2);
  const ref=refs(s)[0],log=s.logs.get('events'),envelopes=log.envelopes[0],values=[...envelopes.values()].reverse();
  assert.ok(s.entityOf(ref).queued.length>1);assert.ok(Object.isFrozen(values[0].entityEvent.snapshot.fields));
  [...envelopes.keys()].forEach((k,i)=>envelopes.set(k,values[i]));
  s.setUp('worker',true);run(s,4);
  const e=s.entityOf(ref),projection=e.representations.find(r=>r.name==='search');
  assert.equal(projection.sourceRevision,policy==='if-newer'?e.representations[0].sourceRevision:1);
  assert.equal(e.queued.length,0);
  if(policy==='if-newer') assert.ok(events(s).some(e=>e.outcome==='older-or-duplicate'));
 }
});
test('delete of an absent projection creates a tombstone; recreate advances revision',()=>{
 const p=spec();p.records.orders.keys=1;p.nodes[0].workload.length=1;p.nodes.find(n=>n.id==='events').partitions=1;
 p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls[0].op='delete';
 const s=run(make(p),3);stop(s);run(s,2);const ref=refs(s)[0];
 for(const rep of s.entityOf(ref).representations) assert.equal(rep.row,null);
 const before=s.entityOf(ref).representations[0].sourceRevision;assert.ok(before>0);
 assert.equal(s.entityOf(ref).representations.find(r=>r.name==='search').sourceRevision,before);
 s.nodes.get('api').endpoints['PUT /orders'].calls[0].op='upsert';s.nodes.get('app').workload[0].rate=2;run(s,2);stop(s);run(s,2);
 const e=s.entityOf(ref);assert.ok(e.representations[0].sourceRevision>before);
 assert.ok(e.representations.find(r=>r.name==='search').row);
});
test('cache get and invalidate execute against saved entries',()=>{
 const p=spec();p.records.orders.keys=1;p.nodes[0].workload.length=1;
 p.entities.order.steps.get={kind:'cache-get',target:'cache'};
 p.entities.order.steps.invalidate={kind:'cache-invalidate',target:'cache'};
 p.nodes.find(n=>n.id==='worker').endpoints['PUT /orders'].calls.push(
  {id:'get',to:'redis',then:true,entityStep:{entity:'order',step:'get'}},
  {id:'invalidate',to:'redis',then:true,entityStep:{entity:'order',step:'invalidate'}});
 const s=run(make(p),4);stop(s);run(s,3);
 assert.ok(events(s).some(e=>e.outcome==='cache-hit'));assert.ok(events(s).some(e=>e.outcome==='invalidated'));
 assert.equal(s.entityOf(refs(s)[0]).representations.find(r=>r.cache).row,null);
});
test('history eviction is bounded and leaves stores and causal payloads intact',()=>{
 const p=spec();p.records.orders.keys=1;p.nodes[0].workload.length=1;
 const s=run(make(p),20);stop(s);run(s,2);const ref=refs(s)[0];
 assert.equal(s.entityOf(ref).history.events.length,128);assert.equal(s.entityOf(ref).history.incomplete,true);
 assert.ok(s.entityOf(ref).representations[0].row);
});
test('system namespaces definitions and bindings; explicit sharing requires a parent definition',async()=>{
 const {system,compose}=await import('../kit/patterns.mjs');
 const p=spec(),fragment=system('shop',p,{keepSources:true});
 const composed=compose({sim:p.sim},fragment),s=run(make(composed),3);
 assert.equal(refs(s)[0].type,'shop.order');assert.equal(s.entityOf(refs(s)[0]).owner,'shop.api');
 const shared=system('shop',p,{keepSources:true,sharedEntities:{order:'order'}});
 assert.throws(()=>make(compose({},shared)),/entity|entities/);
 assert.ok(make(compose({entities:{order:fragment.entities['shop.order']}},shared)));
});

test('entity history LRU stays at 256 without evicting saved rows',()=>{
 const p=spec();p.records.orders.keys=400;p.nodes[0].workload=[{traffic:'north',endpoint:'PUT /orders',rate:60}];
 const s=run(make(p),35);stop(s);run(s,4);
 assert.equal(s.entityState.histories.size,256);
 const rows=[...s.nodes.get('pg').store.get('orders').rows.values()];assert.ok(rows.length>256);
 const evicted=rows.find(r=>!s.entityState.histories.has(r.entity.ref.id));assert.ok(evicted);
 assert.equal(s.entityOf(evicted.entity.ref).history.incomplete,true);
 assert.ok(s.entityOf(evicted.entity.ref).representations[0].row);
});

test('read steps return a saved replica snapshot and constants remain JSON values',()=>{
 const p=spec();p.entities.order.representations.reader={node:'replica',table:'orders',versionPolicy:'arrival'};
 p.entities.order.steps.read={kind:'read',target:'reader'};
 p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls.push({id:'read',to:'replica',then:true,op:'select',table:'orders',entityStep:{entity:'order',step:'read'}});
 p.edges.push(['api','replica']);
 const s=run(make(p),4);stop(s);run(s,3);
 assert.ok(events(s).some(e=>e.outcome==='read'&&e.node==='replica'));
 const bad=spec();bad.entities.order.representations.search.fields.bad={value:{fn:()=>1}};
 assert.throws(()=>make(bad),/JSON/);
});
test('a flag first encountered after queue dispatch uses the new rollout',()=>{
 const p=spec();p.flags={projection:{rollout:1}};
 p.edges=p.edges.map(e=>Array.isArray(e)&&e[0]==='worker'&&e[1]==='search'?{from:'worker',to:'search',flag:'projection'}:e);
 const s=make(p);s.setUp('worker',false);run(s,3);stop(s);run(s,1);s.apply({kill:'projection'});s.setUp('worker',true);run(s,4);
 assert.equal(s.nodes.get('search').store.get('documents').rows.size,0);
 assert.ok(events(s).some(e=>e.outcome==='flag-skipped'));
});

test('a false condition skips a dependent step before requiring its input',()=>{
 const p=spec(),calls=p.nodes.find(n=>n.id==='api').endpoints['PUT /orders'].calls;
 calls.splice(0,1);calls[0].when={field:'context.tenant',eq:'absent'};
 const s=run(make(p),4);
 assert.ok(events(s).some(e=>e.outcome==='condition-skipped'));
 assert.equal(events(s).some(e=>e.outcome==='missing-input'),false);
 assert.equal(s.latencyOf().failed,0);
});
