import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";
import { buildPage, check } from "../scripts/page.mjs";

const run = (sim, seconds) => { for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60); return sim; };
const simOf = spec => createSim(simSpec(modelOf(spec)));
const fixture = (calls = [{to:"db", op:"upsert", table:"items"}]) => ({
  sim: { seed: 5, jitter: false },
  records: { items: { keys: 1, fields: { value: ["saved"] } } },
  nodes: [
    {id:"app", kind:"client", emit:{PUT:5}},
    {id:"api", kind:"service", endpoints:{PUT:{calls}, DELETE:{calls:[{to:"db",op:"delete",table:"items"}]}}},
    {id:"db", kind:"db", tables:{items:{}}},
    {id:"replica", kind:"db"},
  ],
  edges:[["app","api"],["api","db"],{from:"db",to:"replica",kind:"replication"}],
});

test("skipped, asynchronous and empty first stages complete correctly", () => {
  for (const async of [false, true]) {
    const spec = fixture([{to:"replica", p: async ? 1 : 0}, {to:"db", op:"upsert", table:"items", then:true}]);
    spec.edges.push({from:"api",to:"replica",sync:!async});
    const sim = run(simOf(spec), 10);
    assert.equal(sim.tablesOf("db")[0].count, 1);
    assert.equal(sim.latencyOf("app").failed, 0);
  }
  const sim = run(simOf(fixture([])), 3);
  assert.equal(sim.latencyOf("app").failed, 0);
  assert.ok(sim.nodes.get("api").service.length > 0);
});

test("database fail/restore releases dead lock holders and waiters", () => {
  const spec = fixture();
  Object.assign(spec.nodes[2], {locks:true, ms:1000});
  const sim = run(simOf(spec), 2);
  assert.equal(sim.nodes.get("db").locked.size, 1);
  sim.setUp("db", false);
  assert.equal(sim.nodes.get("db").locked.size, 0);
  sim.setUp("db", true);
  run(sim, 4);
  sim.apply({set:{app:{emit:0}}});
  run(sim, 30);
  assert.ok(sim.nodes.get("db").wal.lsn > 0);
  assert.equal(sim.nodes.get("db").jobs.size, 0);
  assert.equal(sim.nodes.get("db").locked.size, 0);
});

test("replica retries writes missed during downtime and drains the acknowledgement backlog", () => {
  const sim = simOf(fixture());
  sim.setUp("replica", false);
  run(sim, 8); // exceed retained inspection history
  sim.apply({set:{app:{emit:0}}});
  run(sim, 3);
  const primary = sim.nodes.get("db");
  assert.ok(primary.wal.lsn > 24);
  sim.setUp("replica", true);
  run(sim, 10);
  assert.equal(sim.tablesOf("replica")[0].behind, 0);
  assert.deepEqual(sim.recordOf("replica","items",1000).row.fields, sim.recordOf("db","items",1000).row.fields);
  assert.equal(sim.recordOf("replica","items",1000).row.version, sim.recordOf("db","items",1000).row.version);
  assert.ok([...primary.wal.pending.values()].every(p => p.size === 0));
});

test("delayed delete and recreation apply in LSN order with monotonic versions", () => {
  const sim = run(simOf(fixture()), 4);
  sim.apply({set:{app:{emit:0}}}); run(sim, 3);
  const version = sim.recordOf("db","items",1000).row.version;
  sim.apply({set:{app:{emit:{DELETE:1}},replica:{lag:4}}}); run(sim,1);
  sim.apply({set:{app:{emit:0}}}); run(sim,1);
  sim.apply({set:{app:{emit:{PUT:1}},replica:{lag:0}}}); run(sim,1);
  sim.apply({set:{app:{emit:0}}}); run(sim,8);
  const primary = sim.recordOf("db","items",1000).row;
  const replica = sim.recordOf("replica","items",1000).row;
  assert.ok(primary.version > version);
  assert.equal(replica.version, primary.version);
  assert.deepEqual(replica.fields, primary.fields);
  assert.equal(sim.tablesOf("replica")[0].behind, 0);
  const applied = sim.nodes.get("replica").wal.recent.map(e => e.lsn);
  assert.deepEqual(applied, [...applied].sort((a,b) => a-b));
});

for (const kind of ["queue", "kafka"]) test(`failed ${kind} stops serving its backlog until restored`, () => {
  const sim = simOf({nodes:[{id:"p",kind:"client",emit:20},{id:"q",kind},{id:"c",kind:"worker",rate:1}],edges:[["p","q"],["q","c"]]});
  run(sim,5); sim.setUp("p",false); sim.setUp("q",false);
  const before = sim.lagOf("q"); run(sim,10);
  assert.equal(sim.lagOf("q"), before);
  sim.setUp("q",true); run(sim,5);
  assert.ok(sim.lagOf("q") < before);
});

test("invalid author input fails build and check before simulation", () => {
  for (const change of [
    s => s.nodes[1].endpoints.PUT.calls[0].op = "selcet",
    s => s.nodes[1].endpoints.PUT.calls[0].table = "missing",
    s => s.nodes[1].endpoints.PUT.calls[0].to = "missing",
    s => s.records.items.fields.value = [],
    s => s.records.items.fields.value = "not samples",
    s => s.records.items.keys = 0,
    s => s.nodes[0].emit = Infinity,
    s => s.nodes[0].kind = "redsi",
    s => s.nodes[1].id = "app",
    s => s.scenario = {steps:[{at:1,fail:"missing"}]},
  ]) {
    const spec = fixture(); change(spec);
    assert.throws(() => buildPage(spec), /spec /);
    assert.throws(() => check(spec,{log:()=>{}}), /spec /);
  }
});

test("fatal CLI check errors exit nonzero; intentional workload warnings remain nonfatal", () => {
  const dir = mkdtempSync(join(tmpdir(),"topo-cli-"));
  try {
    const file = join(dir,"bad.spec.json");
    const spec = fixture(); spec.scenario = {steps:[{at:1,set:{db:{unsupported:1}}}]};
    writeFileSync(file,JSON.stringify(spec));
    const bad = spawnSync(process.execPath,["scripts/build.mjs",file,"--check"],{encoding:"utf8"});
    assert.notEqual(bad.status,0);
    assert.match(bad.stderr,/can't set/);
    spec.scenario = undefined;
    Object.assign(spec.nodes[2],{capacity:0.1});
    writeFileSync(file,JSON.stringify(spec));
    const warning = spawnSync(process.execPath,["scripts/build.mjs",file,"--check"],{encoding:"utf8"});
    assert.equal(warning.status,0,warning.stderr);
    assert.match(warning.stdout,/warnings:/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("malformed dev-server URLs return 400 and leave the server usable", {timeout:15000}, async () => {
  const child = spawn(process.execPath,["scripts/serve.mjs","examples/data-stores","--port","0"],{stdio:["ignore","pipe","pipe"]});
  try {
    const base = await new Promise((resolve,reject) => {
      let output = "";
      child.stdout.on("data",chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if(match) resolve(match[0]); });
      child.on("error",reject); child.on("exit",code => reject(new Error(`server exited ${code}`)));
    });
    for (const path of ["/s/%","/layout/%"]) {
      const response = await fetch(base+path,{method:path.startsWith("/layout")?"POST":"GET"});
      assert.equal(response.status,400);
    }
    assert.equal((await fetch(base+"/")).status,200);
  } finally { child.kill(); await new Promise(resolve => child.exitCode != null ? resolve() : child.once("exit",resolve)); }
});

test("phase summaries expose async drops separately from client-visible failures", () => {
  const lines = [];
  check({
    nodes:[{id:"p",kind:"client",emit:5},{id:"q",kind:"queue"},{id:"w",kind:"worker",rate:10}],
    edges:[["p","q"],["q","w"]],
    scenario:{length:12,loop:false,phases:[{name:"up",at:0},{name:"down",at:3}],steps:[{at:3,fail:"q"}]},
  },{log:line=>lines.push(line)});
  const down = lines.find(line=>line.startsWith("phase down"));
  assert.match(down,/0.0\/s failing/);
  assert.match(down,/[1-9][\d.]*\/s dropped/);
});
