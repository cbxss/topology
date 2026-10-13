import test from "node:test";
import assert from "node:assert/strict";
import { check, traceText } from "../scripts/page.mjs";
import reads from "../examples/read-your-writes/read-your-writes.spec.mjs";
import retries from "../examples/idempotent-retries/idempotent-retries.spec.mjs";
import lost from "../examples/lost-update/lost-update.spec.mjs";

const phases = (spec) => {
  const lines = [];
  const result = check(spec, { log: (line) => lines.push(line) });
  assert.deepEqual(result.warnings, []);
  return lines.filter((line) => line.startsWith("phase "));
};
const rate = (line, label) => Number(line.match(new RegExp(`([\\d.]+)/s ${label}`))?.[1]);

test("read-your-writes story has stale incident reads, an actual stale trace, and fresh primary read-back", () => {
  const lines = phases(reads);
  assert.ok(rate(lines[1], "stale reads") > 3);
  assert.equal(rate(lines[2], "stale reads"), 0);
  assert.match(traceText(reads, "PUT /profile", { warmup: 14 }).join("\n"), /select .*\(stale\)/);
});

test("retry story commits before retrying, conflicts on insert, and preserves content on upsert", () => {
  const lines = phases(retries);
  assert.ok(rate(lines[1], "conflicts") > 0);
  assert.equal(rate(lines[2], "conflicts"), 0);
  assert.ok(rate(lines[2], "failing") > 0, "upsert does not cure timeouts");
  assert.equal(rate(lines[3], "failing"), 0);
  const trace = traceText(retries, "POST /orders", { warmup: 12 }).join("\n");
  assert.match(trace, /insert v1/);
  assert.match(trace, /conflict/);
});

test("lost-update story stops losing updates after locking", () => {
  const lines = phases(lost);
  assert.ok(rate(lines[0], "lost updates") > 0);
  assert.equal(rate(lines[1], "lost updates"), 0);
  assert.equal(rate(lines[2], "lost updates"), 0);
});
