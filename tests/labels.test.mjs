import test from "node:test";
import assert from "node:assert/strict";
import { overlap, textWidth, wrapLabel } from "../kit/labels.mjs";
import { labelPlanOf, modelOf, projectionOf } from "../kit/topo.mjs";
import { buildPage, check } from "../scripts/page.mjs";

const warningsOf = (spec) => check(spec, { seconds: 4, log: () => {} }).warnings;
const planOf = (spec, view) => {
  const model = modelOf(spec);
  const { P, width, height } = projectionOf(model, view);
  return { model, plan: labelPlanOf(model, view, P, width, height) };
};

// Long names, long edge labels, a fan-in: the shape that used to pile text up.
const LONG = {
  title: "Long labels",
  nodes: [
    { id: "web", kind: "client", emit: 4, label: "customer mobile and web apps" },
    { id: "gw", kind: "gateway", label: "public-api-gateway-prod" },
    { id: "pay", kind: "service", label: "payments-reconciler" },
    { id: "ledger", kind: "service", label: "ledger-writer" },
    { id: "pg", kind: "db", label: "customer-accounts-primary-postgres" },
    { id: "pg2", kind: "db", label: "customer-accounts-replica" },
    { id: "q", kind: "queue", label: "settlement-events-queue" },
  ],
  edges: [["web", "gw"], { from: "gw", to: "pay", label: "POST /v2/payments" }, ["gw", "ledger"], { from: "pay", to: "pg", label: "SELECT … FOR UPDATE" },
    ["ledger", "pg"], { from: "pg", to: "pg2", kind: "replication" }, { from: "pay", to: "q", label: "settlement.created" }],
};

test("wrapLabel: short labels stay, long ones break evenly after a separator, longer ones are cut", () => {
  assert.deepEqual(wrapLabel("orders-api"), { lines: ["orders-api"], shortened: false });
  assert.deepEqual(wrapLabel("customer-accounts-primary-postgres").lines, ["customer-accounts-", "primary-postgres"]);
  assert.deepEqual(wrapLabel("public-api-gateway-prod").lines, ["public-api-", "gateway-prod"], "the most even break");
  assert.deepEqual(wrapLabel("customer mobile and web apps").lines, ["customer mobile", "and web apps"], "a space is dropped");
  const cut = wrapLabel("payments-reconciliation-service");
  assert.ok(cut.shortened);
  assert.equal(cut.lines[0], "payments-");
  assert.ok(cut.lines[1].endsWith("…") && cut.lines[1].length <= 18);
  assert.deepEqual(wrapLabel("abcdefghijklmnopqrstuvwxyz", 10).lines, ["abcdefghij", "klmnopqrs…"], "no separator: a hard cut");
});

test("textWidth matches the 2.4-per-character half-width labels have always used at size 8", () => {
  assert.ok(Math.abs(textWidth("abcdefghij", 8) / 2 - 10 * 2.4) < 1);
});

test("long labels: no node label overlaps a node or another label, in either view", () => {
  for (const view of ["iso", "flat"]) {
    const { model, plan } = planOf(LONG, view);
    const boxes = [...plan.nodes.entries()];
    for (const [id, spot] of boxes) {
      assert.ok(!spot.blockers.some((b) => b.type === "node" || b.type === "label" || b.type === "hidden"), `${view}: ${id} is blocked by ${JSON.stringify(spot.blockers)}`);
      for (const node of model.nodes) {
        const box = { x0: node.plan.x, x1: node.plan.x + node.plan.w, y0: node.plan.y, y1: node.plan.y + node.plan.d };
        assert.ok(!overlap(spot.box, box), `${view}: ${id}'s label is on ${node.id}`);
      }
    }
    for (const [index, spot] of plan.edges) {
      if (spot.crowded) continue;
      for (const [id, other] of boxes) assert.ok(!overlap(spot.box, other.box), `${view}: edge ${index}'s label is on ${id}'s`);
    }
    assert.equal(model.byId.get("pg").labelLines.length, 2);
  }
  assert.deepEqual(warningsOf(LONG).filter((w) => /label/.test(w)), []);
});

test("--check names text that can't be kept apart", () => {
  const squeezed = {
    grid: [60, 40],
    nodes: [
      { id: "a", kind: "client", emit: 2, at: [0, 0], label: "first-very-long-name" },
      { id: "b", kind: "service", at: [0.6, 0], label: "second-very-long-name" },
      { id: "c", kind: "db", at: [0.6, 0.9], label: "third-very-long-name" },
    ],
    edges: [{ from: "a", to: "b", label: "a really long edge label here" }, ["b", "c"]],
  };
  const warnings = warningsOf(squeezed);
  assert.ok(warnings.some((w) => /label ".*" (overlaps|is hidden behind)/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /edge label "a really long edge label here" on a → b has no clear spot/.test(w)), warnings.join("\n"));
  const { html } = buildPage(squeezed);
  assert.match(html, /data-elabel="0" data-crowded/, "the crowded edge label waits for focus");
  assert.ok(warningsOf({ nodes: [{ id: "x", kind: "client", emit: 1, label: "payments-reconciliation-service" }] }).some((w) => /is shortened to "payments- \/ reconciliation-se…"/.test(w)));
});

test("labels: wrapped text draws as lines, a shortened one keeps its full name, detail reaches the page", () => {
  const spec = {
    nodes: [
      { id: "a", kind: "client", emit: 1, label: "payments-reconciliation-service", detail: "Matches settlements to ledger entries nightly." },
      { id: "b", kind: "db", label: "customer-accounts-primary" },
    ],
    edges: [{ from: "a", to: "b", detail: "Batched upserts, 500 rows per statement." }],
  };
  const { html } = buildPage(spec);
  assert.match(html, /<title>payments-reconciliation-service<\/title>/);
  assert.match(html, />customer-<\/text>.*?>accounts-primary<\/text>/s, "the most even break");
  assert.match(html, /<title>Batched upserts, 500 rows per statement.<\/title>/);
  assert.ok(html.includes("Matches settlements to ledger entries nightly."), "detail is in the page data for the inspector");
  assert.throws(() => modelOf({ nodes: [{ id: "a", kind: "service", detail: 3 }] }), /a.detail: expected a string/);
});

test("placement is deterministic", () => {
  assert.equal(buildPage(LONG).html, buildPage(LONG).html);
});
