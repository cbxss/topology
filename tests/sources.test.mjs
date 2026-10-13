import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compose, importSpec, link, system } from "../kit/patterns.mjs";
import { stripProvenance, validateProvenance } from "../kit/provenance.mjs";
import { buildPage } from "../scripts/page.mjs";
import { failed, sourcesReport } from "../scripts/sources.mjs";

const BUILD = new URL("../scripts/build.mjs", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

// A repo with an app and its infra, committed twice: replicas 3 → 4 in the second commit.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "topo-sources-"));
  const repo = join(dir, "infra");
  mkdirSync(join(repo, "k8s"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  writeFileSync(join(repo, "k8s", "api.yaml"), "kind: Deployment\nspec:\n  replicas: 3\n  timeout: 200ms\n");
  writeFileSync(join(repo, "main.go"), "package main\n\nfunc main() {\n\tserve()\n}\n");
  git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", "first");
  const first = git(repo, "rev-parse", "--short", "HEAD");
  writeFileSync(join(repo, "k8s", "api.yaml"), "kind: Deployment\nspec:\n  replicas: 4\n  timeout: 200ms\n");
  git(repo, "commit", "--quiet", "-am", "scale api to 4");
  const specDir = join(dir, "figs");
  mkdirSync(specDir);
  return { dir, repo, first, specDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const specWith = (sources, nodeRefs, extra = {}) => ({
  title: "Api",
  sources,
  refs: ["infra:main.go"],
  notes: ["The whole thing"],
  nodes: [
    { id: "web", kind: "client", emit: 4, notes: [{ text: "guessed from logs", field: "emit", assumed: true }] },
    { id: "api", kind: "service", replicas: 3, refs: nodeRefs },
    { id: "db", kind: "db" },
  ],
  edges: [["web", "api"], { from: "api", to: "db", timeout: 0.2, refs: [{ ref: "infra:k8s/api.yaml#timeout:", field: "timeout" }] }],
  ...extra,
});

test("sources: ok, missing file and anchor, value mismatch, units", () => {
  const f = fixture();
  try {
    const spec = specWith({ infra: { repo: "../infra" } }, [
      "infra:main.go#func main",
      { ref: "infra:k8s/api.yaml#replicas:", field: "replicas", note: "prod" },
      "infra:nope.go",
      "infra:main.go#func gone",
    ]);
    const report = sourcesReport(spec, { file: join(f.specDir, "api.spec.mjs") });
    const api = report.items.find((i) => i.at === "node api").refs;
    assert.equal(api[0].status, "ok");
    assert.equal(api[0].line, 3);
    assert.ok(api[0].snippet.some((line) => line.includes("func main")));
    assert.equal(api[1].status, "mismatch", "the working tree says 4");
    assert.equal(api[1].found, 4);
    assert.equal(api[2].status, "missing-file");
    assert.equal(api[3].status, "missing-anchor");
    assert.equal(report.items.find((i) => i.at === "edge api>db").refs[0].status, "ok", "200ms is timeout 0.2");
    assert.equal(report.items.find((i) => i.at === "spec").refs[0].status, "ok");
    assert.deepEqual(report.unsourced, ["node web", "node db", "edge web>api"]);
    assert.deepEqual(report.assumed.map((a) => [a.at, a.field]), [["node web", "emit"]]);
    assert.ok(failed(report));
  } finally { f.cleanup(); }
});

test("sources: a pinned rev reads the old file and reports what changed since", () => {
  const f = fixture();
  try {
    const spec = specWith({ infra: { repo: "../infra", rev: f.first } }, [{ ref: "infra:k8s/api.yaml#replicas:", field: "replicas" }]);
    const report = sourcesReport(spec, { file: join(f.specDir, "api.spec.mjs") });
    const [ref] = report.items.find((i) => i.at === "node api").refs;
    assert.equal(ref.found, 3, "read at the pinned commit");
    assert.equal(ref.status, "stale");
    assert.match(ref.commits[0], /scale api to 4/);
    assert.ok(!failed(report), "stale alone passes");
    assert.ok(failed(report, true), "but not under --strict");
  } finally { f.cleanup(); }
});

test("sources: remotes need --fetch, a mapping or --source-dir; self is the spec's repo", () => {
  const f = fixture();
  try {
    const remote = pathToFileURL(f.repo).href; // file:// stands in for a hosted repo
    const spec = specWith({ infra: { repo: remote } }, ["infra:main.go#func main", "self:figs-readme.md"]);
    writeFileSync(join(f.dir, "figs-readme.md"), "hi\n");
    const file = join(f.specDir, "api.spec.mjs");
    const offline = sourcesReport(spec, { file });
    assert.equal(offline.sources.infra.status, "unresolved");
    assert.equal(offline.items.find((i) => i.at === "node api").refs[0].status, "unresolved");
    assert.equal(offline.summary.unresolved, 3, "the spec, node and edge refs into infra");

    const fetched = sourcesReport(spec, { file, fetch: true, cacheDir: join(f.dir, "cache") });
    assert.equal(fetched.items.find((i) => i.at === "node api").refs[0].status, "ok", "read from a blobless clone");
    assert.equal(sourcesReport(spec, { file, sourceDirs: { infra: f.repo } }).items.find((i) => i.at === "node api").refs[0].status, "ok");
    writeFileSync(join(f.specDir, ".topology-sources.json"), JSON.stringify({ [remote]: "../infra" }));
    assert.equal(sourcesReport(spec, { file }).items.find((i) => i.at === "node api").refs[0].status, "ok", "mapped in .topology-sources.json");
    // The spec dir is not a git repo, so self is its directory: figs-readme.md lives one up.
    assert.equal(fetched.items.find((i) => i.at === "node api").refs[1].status, "missing-file");
  } finally { f.cleanup(); }
});

test("sources: shape errors are caught before anything is built", () => {
  const base = { nodes: [{ id: "a", kind: "service" }] };
  assert.throws(() => validateProvenance({ ...base, nodes: [{ id: "a", refs: "x:y" }] }), /expected an array/);
  assert.throws(() => validateProvenance({ ...base, nodes: [{ id: "a", refs: ["nowhere"] }] }), /is not "source:path#anchor"/);
  assert.throws(() => validateProvenance({ ...base, nodes: [{ id: "a", refs: ["infra:x.tf"] }] }), /unknown source infra/);
  assert.throws(() => validateProvenance({ ...base, sources: { infra: {} } }), /expected \{ repo/);
  assert.throws(() => validateProvenance({ ...base, nodes: [{ id: "a", notes: [{ field: "emit" }] }] }), /expected text/);
  assert.doesNotThrow(() => validateProvenance({ ...base, nodes: [{ id: "a", refs: ["self:kit/topo.mjs#export function"] }] }));
});

test("sources: nothing about them reaches the page or the model", () => {
  const spec = specWith({ infra: { repo: "../secret-infra-repo" } }, [{ ref: "infra:k8s/api.yaml#replicas:", field: "replicas", note: "a private remark" }]);
  const { html } = buildPage(spec);
  for (const text of ["secret-infra-repo", "k8s/api.yaml", "a private remark", "guessed from logs", "The whole thing"]) assert.ok(!html.includes(text), `${text} leaked into the page`);
  const bare = stripProvenance(spec);
  assert.ok(!bare.sources && !bare.refs && !bare.notes && bare.nodes.every((n) => !n.refs && !n.notes));
  assert.deepEqual(bare.edges[0], ["web", "api"]);
  assert.equal(spec.nodes[1].refs.length, 1, "the spec itself is untouched");
});

test("sources: system() namespaces sources, and importSpec pins the child's repos", async () => {
  const f = fixture();
  try {
    const child = specWith({ infra: { repo: "../infra" } }, [{ ref: "infra:k8s/api.yaml#replicas:", field: "replicas" }, "self:main.go"]);
    const s = system("app", child);
    assert.deepEqual(Object.keys(s.sources), ["app.infra"]);
    assert.equal(s.nodes.find((n) => n.id === "app.api").refs[0].ref, "app.infra:k8s/api.yaml#replicas:");
    assert.equal(s.nodes.find((n) => n.id === "app.api").refs[1], "self:main.go", "self stays the parent's repo");
    assert.deepEqual(s.groups.at(-1).refs, ["app.infra:main.go"], "spec-level refs ride on the plate");

    const file = join(f.specDir, "child.spec.mjs");
    writeFileSync(file, `export default ${JSON.stringify(child)};`);
    const imported = await importSpec(pathToFileURL(file));
    assert.equal(imported.sources.infra.repo, f.repo, "relative repos become absolute");
    assert.ok(imported.sources.self);
    const parent = compose({ title: "Parent", nodes: [{ id: "u", kind: "client", emit: 2 }] }, system("app", imported), link("u", "app.api"));
    const report = sourcesReport(parent, { file: join(f.dir, "elsewhere", "parent.spec.mjs") });
    assert.equal(report.items.find((i) => i.at === "node app.api").refs[0].status, "mismatch", "resolves from anywhere");
  } finally { f.cleanup(); }
});

test("build.mjs --sources prints, emits JSON and sets the exit code", () => {
  const f = fixture();
  try {
    const file = join(f.specDir, "api.spec.mjs");
    writeFileSync(file, `export default ${JSON.stringify(specWith({ infra: { repo: "../infra" } }, ["infra:main.go#func main"]))};`);
    const text = spawnSync(process.execPath, [BUILD, file, "--sources"], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\[ok\] infra:main.go#func main {2}line 3/);
    assert.match(text.stdout, /unsourced: node web, node db/);
    const json = spawnSync(process.execPath, [BUILD, file, "--sources", "--json"], { encoding: "utf8" });
    assert.equal(JSON.parse(json.stdout).summary.ok, 3);
    writeFileSync(file, `export default ${JSON.stringify(specWith({ infra: { repo: "../infra" } }, ["infra:main.go#gone"]))};`);
    assert.equal(spawnSync(process.execPath, [BUILD, file, "--sources"], { encoding: "utf8" }).status, 1);
  } finally { f.cleanup(); }
});
