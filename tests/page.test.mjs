import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPage, loadSpec, modelOf } from "../scripts/page.mjs";

const SPEC = `export default { nodes: [{ id: "a", kind: "client", emit: 2 }, { id: "b", kind: "service" }], edges: [["a", "b"]] };`;

test("a layout sidecar overrides positions without touching the spec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-"));
  writeFileSync(join(dir, "x.spec.mjs"), SPEC);
  writeFileSync(join(dir, "x.layout.json"), JSON.stringify({ at: { a: [0, 0], b: [2, 1.5] } }));
  const model = modelOf(await loadSpec(join(dir, "x.spec.mjs")));
  const b = model.byId.get("b");
  assert.deepEqual(b.at, [2, 1.5]);
  assert.equal(b.cy, 1.5 * model.grid[1]);
});

test("feature toggles remove their markup and code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-"));
  writeFileSync(join(dir, "y.spec.mjs"), SPEC);
  const spec = await loadSpec(join(dir, "y.spec.mjs"));
  const on = buildPage(spec, { edit: true }).html;
  const off = buildPage(spec, { edit: true, featureLayers: ["-edit"] }).html;
  assert.ok(on.includes("Drag-to-arrange"));
  assert.ok(!off.includes("Drag-to-arrange"));
  assert.throws(() => buildPage(spec, { featureLayers: ["-nonsense"] }), /unknown feature/);
});
