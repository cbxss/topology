import test from 'node:test';
import assert from 'node:assert/strict';
import { modelOf, simSpec } from '../kit/topo.mjs';
import { createSim } from '../kit/topo-sim.mjs';
import { envelopeOf, inheritEnvelope } from '../kit/sim/context.mjs';
import { observeSim } from './helpers/sim-observation.mjs';
import { matches } from '../kit/sim/routing.mjs';
const policy = {rules:[{id:'premium',when:{field:'context.tier',eq:'premium'},action:{type:'send',to:'dedicated'}}],fallback:{type:'send',to:'shared'}};
const spec = () => ({traffic:{premium:{context:{tier:'premium'}},standard:{context:{tier:'standard'}}},nodes:[{id:'source',kind:'client',workload:[{traffic:'premium',rate:8},{traffic:'standard',rate:8}]},{id:'router',kind:'service',routing:structuredClone(policy)},{id:'dedicated',kind:'service'},{id:'shared',kind:'service'}],edges:[['source','router'],['router','dedicated'],['router','shared']],sim:{seed:13,jitter:false,speed:4000}});
const make = s => createSim(simSpec(modelOf(s)));
const run = (s, seconds=8) => {for(let i=0;i<seconds*60;i++) s.step(1/60);return s;};

test('strict, reusable context conditions distinguish missing, null, false and zero',()=>{
 const msg={source:'web',context:{tier:'premium',nil:null,no:false,zero:0,'x.y':3}};
 assert.ok(matches({all:[{policy:'p'},{not:{field:'context.absent',exists:true}}]},msg,{p:{field:'context.tier',in:['premium']}}));
 for(const [field,value] of [['nil',null],['no',false],['zero',0]]) assert.ok(matches({field:`context.${field}`,eq:value},msg));
 assert.equal(matches({field:'context.absent',eq:null},msg),false);
 assert.equal(matches({field:'context.zero',eq:'0'},msg),false);
 assert.ok(matches({field:['context','x.y'],gt:2},msg));
});
test('multi-hop classes route independently, preserve immutable context and report decisions',()=>{
 const s=run(make(spec()));
 for(const [id,want] of [['dedicated','premium'],['shared','standard']]) {
  const arrivals=s.trafficState.arrivals.filter(a=>a.node===id);
  assert.ok(arrivals.length); assert.ok(arrivals.every(a=>a.traffic===want));
 }
 const msg=s.packets.find(p=>p.msg)?.msg;
 assert.ok(Object.isFrozen(msg.context));
 assert.throws(()=>{msg.context.tier='changed';},TypeError);
 assert.ok(s.routingOf('router').some(d=>d.rule==='premium'));
 assert.ok(s.trafficOf().every(c=>c.rate>0));
});
test('first match wins and a down target never uses fallback, including retries',()=>{
 const p=spec();p.nodes[2].up=false;p.edges[1]={from:'router',to:'dedicated',retries:2};
 p.nodes[1].routing.rules.push({id:'also-premium',when:{field:'context.tier',eq:'premium'},action:{type:'send',to:'shared'}});
 const s=run(make(p));
 assert.ok(s.edges[1].sent>0);
 assert.ok(s.trafficState.arrivals.filter(a=>a.node==='shared').every(a=>a.traffic==='standard'));
 assert.ok(s.routingOf().some(d=>d.outcome==='target-down'));
 assert.ok(s.latencyOf().failed>0);
});
test('weighted calls retain their selected destination on retries',()=>{
 const p=spec();p.nodes[1].routing={rules:[],fallback:{type:'weighted',targets:[{to:'dedicated',weight:3},{to:'shared',weight:1}]}};
 p.nodes[2].errorRate=1;p.nodes[3].errorRate=1;p.edges[1]={from:'router',to:'dedicated',retries:2};p.edges[2]={from:'router',to:'shared',retries:2};
 const a=run(make(p)),b=run(make(p));
 assert.deepEqual(a.routingOf(),b.routingOf());
 const decisions=a.trafficState.decisions;assert.ok(decisions.some(d=>d.to==='shared'));assert.ok(decisions.some(d=>d.to==='dedicated'));
 for(const call of a.calls) if(call.attempt>0) assert.equal(decisions.find(d=>d.msgId===call.job.msg.id)?.to,call.edge.to);
});
test('conditional endpoint calls advance skipped stages and route table operations',()=>{
 const p=spec();p.nodes[0].workload.forEach(w=>w.endpoint='PUT /x');
 delete p.nodes[1].routing;
 p.records={items:{fields:{status:['saved']}}};
 p.nodes[1].endpoints={'PUT /x':{calls:[{to:'shared',when:{field:'context.never',exists:true},op:'select',table:'items'},{routing:policy,then:true,op:'upsert',table:'items'}]}};
 for(const n of p.nodes.slice(2)){n.kind='db';n.tables={items:{key:'id'}};}
 const s=run(make(p));assert.ok(s.tablesOf('dedicated')[0].count>0);assert.ok(s.tablesOf('shared')[0].count>0);
 assert.ok(s.trafficState.arrivals.filter(a=>a.node==='dedicated').every(a=>a.traffic==='premium'));
});
test('reject fallback and flag-blocked actions are failures',()=>{
 const p=spec();p.flags={allow:{rollout:0}};p.edges[1]={from:'router',to:'dedicated',flag:'allow'};p.nodes[1].routing.fallback={type:'reject'};
 const s=run(make(p));assert.equal(s.nodes.get('shared').handled,0);assert.equal(s.nodes.get('dedicated').handled,0);
 assert.ok(s.routingOf().some(d=>d.outcome==='flag-blocked'));assert.ok(s.routingOf().some(d=>d.outcome==='rejected'));
});
for(const kind of ['kafka','queue']) test(`${kind} retains per-offset context through failure and reclaims dispatched envelopes`,()=>{
 const p=spec();p.nodes[1]={id:'router',kind,partitions:2};
 p.nodes[2]={id:'dedicated',kind:'worker',rate:40,routing:{rules:[],fallback:{type:'send',to:'sink'}}};
 p.nodes[3]={id:'shared',kind:'worker',rate:40};p.nodes.push({id:'sink',kind:'service'});
 p.edges[1]={from:'router',to:'dedicated',group:'a'};p.edges[2]={from:'router',to:'shared',group:'b'};p.edges.push(['dedicated','sink']);
 const s=make(p);s.setUp('dedicated',false);if(kind==='queue') s.setUp('shared',false);run(s,3);
 const log=s.logs.get('router');assert.ok(log.envelopes.some(m=>m.size));
 s.setUp('router',false);const before=s.nodes.get('dedicated').handled;run(s,1);assert.equal(s.nodes.get('dedicated').handled,before);
 s.nodes.get('source').workload.forEach(w=>w.rate=0);s.setUp('router',true);s.setUp('dedicated',true);s.setUp('shared',true);run(s,8);
 assert.ok(s.nodes.get('sink').handled>0);
 assert.ok(s.trafficState.decisions.every(d=>['premium','standard'].includes(d.traffic)));
 assert.equal(log.envelopes.reduce((n,m)=>n+m.size,0),0);
});
test('invalid routing authoring fails before building',()=>{
 const cases=[p=>p.nodes[0].emit=1,p=>p.nodes[0].workload[0].traffic='unknown',p=>p.traffic.premium.color='red',p=>delete p.nodes[1].routing.fallback,p=>p.nodes[1].routing.rules[0].when={field:'context.x',typo:3},p=>p.policies={a:{policy:'b'},b:{policy:'a'}},p=>p.edges.push(['router','dedicated']),p=>p.nodes[1].routing.fallback={type:'weighted',targets:[{to:'shared',weight:0}]}];
 for(const change of cases){const p=spec();change(p);assert.throws(()=>make(p),/spec /);}
});
test('a followed Kafka journey includes consumer spans',()=>{
 const p={traffic:{premium:{context:{tenant:'acme'}}},nodes:[{id:'s',kind:'client',workload:[{traffic:'premium',rate:2}]},{id:'topic',kind:'kafka'},{id:'worker',kind:'worker',rate:30}],edges:[['s','topic'],['topic','worker']],sim:{speed:4000}};
 const s=make(p);s.follow();run(s,3);
 assert.ok(s.tracing.spans.some(span=>span.node==='worker'));
 const worker=s.tracing.spans.find(span=>span.node==='worker');assert.equal(worker.context.tenant,'acme');assert.notEqual(worker.msgId,s.tracing.msgId);assert.ok(worker.parent!=null);
});

test('consumer envelopes preserve records and flag draws without sharing execution state',()=>{
 const parent={id:1,source:'app',origin:'app',rootId:1,endpoint:'PUT /x',traffic:'premium',context:{headers:{region:'eu'}},records:{items:{key:3,fields:{nested:{n:1}}}},draws:{canary:.4},wrote:{items:2}};
 const envelope=envelopeOf(parent,2);
 const a=inheritEnvelope({id:2,source:'topic'},envelope),b=inheritEnvelope({id:3,source:'topic'},envelope);
 a.records.items.fields.nested.n=9;a.draws.canary=.8;
 assert.equal(b.records.items.fields.nested.n,1);assert.equal(b.draws.canary,.4);assert.equal(a.wrote,undefined);
 assert.ok(Object.isFrozen(a.context.headers));assert.equal(a.rootId,1);assert.equal(a.parentId,1);
 assert.ok(matches({field:'request.source',eq:'app'},a));
});
test('replication carries traffic identity and a saved write reaches the replica',()=>{
 const p=spec();p.nodes[0].workload.forEach(w=>w.endpoint='PUT /x');
 p.nodes[1].endpoints={'PUT /x':{calls:[{to:'dedicated',op:'upsert',table:'items'}]}};
 delete p.nodes[1].routing;p.nodes[2]={id:'dedicated',kind:'db',tables:{items:{key:'id'}}};p.nodes[3]={id:'shared',kind:'db',lag:.2};
 p.edges=[['source','router'],['router','dedicated'],{from:'dedicated',to:'shared',kind:'replication'}];p.records={items:{fields:{value:[false,0,null]}}};
 const s=make(p);s.follow(null,['premium']);run(s,2);
 assert.ok(s.tracing.spans.some(x=>x.node==='shared'&&x.traffic==='premium'));
 assert.ok(s.trafficState.paths.some(x=>x.edge===2&&x.traffic==='standard'));
 s.nodes.get('source').workload.forEach(w=>w.rate=0);run(s,3);
 const saved = id => [...s.nodes.get(id).store.get('items').rows.values()].map(({key,version,fields})=>({key,version,fields}));
 assert.deepEqual(saved('dedicated'), saved('shared'));
});
test('pending async traces are bounded by simulation time and span count',()=>{
 const p={traffic:{a:{}},nodes:[{id:'s',kind:'service',workload:[{traffic:'a',rate:1}]},{id:'q',kind:'queue'},{id:'w',kind:'worker',up:false}],edges:[['s','q'],['q','w']],sim:{speed:4000}};
 const s=make(p);s.follow();run(s,62);assert.ok(s.tracePending());assert.ok(s.tracing.truncated);
 const loop={traffic:{a:{}},nodes:[{id:'s',kind:'client',workload:[{traffic:'a',rate:1}]},{id:'a',kind:'service'},{id:'b',kind:'service'}],edges:[{from:'s',to:'a',kind:'async'},{from:'a',to:'b',kind:'async'},{from:'b',to:'a',kind:'async'}],sim:{speed:100000,jitter:false}};
 const l=make(loop);l.follow();run(l,25);assert.equal(l.tracing.spans.length,256);assert.ok(l.tracing.truncated);
});
test('color modes leave every simulation checkpoint unchanged',()=>{
 const p=spec();let expected;
 for(const colorBy of ['traffic','activity','none']) {
  const state=observeSim(run(make({...p,colorBy})));
  if(expected) assert.deepEqual(state,expected);else expected=state;
 }
});

test('paused simulation steps cannot emit or consume randomness',()=>{
 const s=make(spec());const before=observeSim(s);s.step(0);assert.deepEqual(observeSim(s),before);
});
