import test from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";

function fixture(lag = 0) {
  const spec = {
    records: { profiles: { key: "userId", keys: 1, start: 42, fields: {
      enabled: [false], quota: [0], nickname: [null], preferences: [{ digest: ["weekly"] }], version: ["user field"],
    } } },
    nodes: [
      { id: "app", kind: "client", emit: { "PUT /profile": 2 } },
      { id: "api", kind: "service", endpoints: { "PUT /profile": { calls: [{ to: "db", op: "upsert", table: "profiles" }] } } },
      { id: "db", kind: "db", tables: { profiles: { key: "userId" } } },
      { id: "copy", kind: "db", lag },
      { id: "unrelated", kind: "db", tables: { profiles: { key: "userId" } } },
    ],
    edges: [["app", "api"], ["api", "db"], { from: "db", to: "copy", kind: "replication" }],
  };
  const sim = createSim(simSpec(modelOf(spec)));
  for (let i = 0; i < 600; i++) sim.step(1 / 60);
  return sim;
}

test("record projection handles arbitrary fields, absent rows and isolated replication groups", () => {
  const sim = fixture(30);
  assert.equal(sim.recordOf("unknown", "profiles", 42), null);
  assert.equal(sim.recordOf("db", "unknown", 42), null);
  assert.equal(sim.recordOf("db", "profiles", 99).row, null);
  const record = sim.recordOf("copy", "profiles", 42);
  assert.equal(record.keyName, "userId");
  assert.equal(record.row, null);
  assert.deepEqual(record.copies.map(c => c.id), ["db", "copy"]);
  assert.equal(record.copies[1].behind, true);
  assert.deepEqual(record.copies[0].row.fields, {
    enabled: false, quota: 0, nickname: null, preferences: { digest: ["weekly"] }, version: "user field",
  });
  assert.equal(record.latest.key, 42);
});

test("record snapshots cannot mutate stored rows or WAL and remain stable across writes", () => {
  const sim = fixture();
  const record = sim.recordOf("db", "profiles", 42);
  const version = record.row.version;
  record.row.fields.preferences.digest.push("daily");
  record.latest.fields.quota = 999;
  record.copies[0].row.fields.enabled = true;
  const fresh = sim.recordOf("db", "profiles", 42);
  assert.deepEqual(fresh.row.fields.preferences.digest, ["weekly"]);
  assert.equal(fresh.latest.fields.quota, 0);
  assert.equal(fresh.row.fields.enabled, false);
  for (let i = 0; i < 180; i++) sim.step(1 / 60);
  assert.ok(sim.recordOf("db", "profiles", 42).row.version > version);
  assert.equal(record.row.version, version);
});
