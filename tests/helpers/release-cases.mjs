import { readFileSync } from "node:fs";
const original = JSON.parse(readFileSync(new URL("../fixtures/sim-s4-baseline.json", import.meta.url)));
const updates = JSON.parse(readFileSync(new URL("../fixtures/sim-v1-updates.json", import.meta.url)));
const cases = original.cases.map(item => {
  const update = updates.changes.find(change => change.name === item.name && change.features === item.features);
  return { ...item, expected: update?.expected || item.expected, originalExpected: item.expected };
});
export { original, updates, cases };
