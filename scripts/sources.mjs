// Resolve and check a spec's source refs (kit/provenance.mjs): does each cited file and anchor
// still exist, does a cited number still match the spec, and has the file changed since the
// pinned `rev`? Agent-facing; build.mjs --sources prints it, --json for machines.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noteOf, parseRef, placesOf, refOf, validateProvenance } from "../kit/provenance.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const home = (path) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const isRemote = (repo) => typeof repo === "string" && (/^(https?|ssh|git|file):\/\//.test(repo) || /^git@/.test(repo) || /^[\w-]+(\.[\w-]+)+\/[^/]+\/[^/]/.test(repo));

// The repo a spec lives in: its git top level, else its directory.
export function selfRoot(dir) {
  return tryGit(dir, "rev-parse", "--show-toplevel")?.trim() || dir;
}

const SECONDS = new Set(["timeout", "backoff", "detect", "ttl", "lag", "election", "every", "rebalance"]);
const MILLIS = new Set(["ms", "sidecarMs"]);
const FRACTIONS = new Set(["hit", "errorRate", "p", "burst", "rollout"]);

// A number written in the source, in the spec's units for that field.
function inSpecUnits(field, value, unit) {
  if (SECONDS.has(field)) return unit === "ms" ? value / 1000 : unit === "m" ? value * 60 : value;
  if (MILLIS.has(field)) return unit === "s" ? value * 1000 : value;
  if (FRACTIONS.has(field) && unit === "%") return value / 100;
  return value;
}
const NUMBER = /(-?\d+(?:\.\d+)?)\s*(ms|s|m|%)?(?![\w.])/;

function findAnchor(lines, anchor) {
  if (!anchor) return { index: -1, column: 0 };
  const regex = /^\/(.+)\/([a-z]*)$/.exec(anchor);
  const test = regex ? new RegExp(regex[1], regex[2].replace("g", "")) : null;
  for (let i = 0; i < lines.length; i++) {
    if (test) {
      const match = test.exec(lines[i]);
      if (match) return { index: i, column: match.index + match[0].length };
    } else {
      const at = lines[i].indexOf(anchor);
      if (at >= 0) return { index: i, column: at + anchor.length };
    }
  }
  return null;
}

// Where a source's files are: a local directory, maybe a git work tree, and the revision to read.
function locate(name, source, { base, sourceDirs, mapping, fetch, cacheDir }) {
  const repo = source.repo instanceof URL ? fileURLToPath(source.repo) : source.repo;
  const label = typeof repo === "string" ? repo : String(repo);
  const out = { name, repo: label, rev: source.rev ?? null };
  let root = sourceDirs[name] ?? mapping[label] ?? mapping[name];
  let remote = false;
  if (root) root = resolve(base, home(root));
  else if (name === "self" && !source.given) root = selfRoot(base);
  else if (isRemote(repo)) {
    remote = true;
    if (!fetch) return { ...out, status: "unresolved", reason: `remote; pass --fetch, --source-dir ${name}=<checkout>, or map it in .topology-sources.json` };
    root = join(cacheDir, label.replace(/^\w+:\/\//, "").replace(/^git@/, "").replace(/[:]/g, "/").replace(/\.git$/, ""));
    try {
      if (!existsSync(join(root, ".git")) && !existsSync(join(root, "HEAD"))) {
        mkdirSync(dirname(root), { recursive: true });
        const url = /^[\w-]+(\.[\w-]+)+\//.test(label) ? `https://${label}` : label;
        execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", url, root], { stdio: ["ignore", "pipe", "pipe"] });
      } else git(root, "fetch", "--quiet", "origin");
      if (source.rev && !tryGit(root, "cat-file", "-e", `${source.rev}^{commit}`)) git(root, "fetch", "--quiet", "origin", source.rev);
    } catch (error) {
      return { ...out, status: "unresolved", reason: `fetch failed: ${String(error.stderr || error.message).trim().split("\n")[0]}` };
    }
  } else root = resolve(base, home(repo));
  if (!existsSync(root) || !statSync(root).isDirectory()) return { ...out, status: "unresolved", reason: `no directory ${root}` };
  const isGit = tryGit(root, "rev-parse", "--is-inside-work-tree") !== null || tryGit(root, "rev-parse", "--git-dir") !== null;
  // A remote clone has no checkout: read its default branch unless a rev is pinned.
  const rev = source.rev ?? (remote ? "HEAD" : null);
  if (rev && !isGit) return { ...out, root, status: "unresolved", reason: `rev ${rev} needs a git repo at ${root}` };
  if (rev && !tryGit(root, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`)) return { ...out, root, status: "unresolved", reason: `unknown rev ${rev}` };
  return { ...out, root, status: "ok", git: isGit, read: rev, pinned: !!source.rev, remote };
}

function read(loc, path) {
  if (loc.read) return tryGit(loc.root, "show", `${loc.read}:./${path}`);
  const file = join(loc.root, path);
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
}

function changedSince(loc, path) {
  if (!loc.pinned || !loc.git) return [];
  const head = loc.remote ? "origin/HEAD" : "HEAD";
  const commits = (tryGit(loc.root, "log", "--format=%h %s", `${loc.read}..${head}`, "--", path) || "").split("\n").filter(Boolean);
  const dirty = !loc.remote && (tryGit(loc.root, "status", "--porcelain", "--", path) || "").trim() ? ["(uncommitted changes)"] : [];
  return [...commits, ...dirty];
}

function checkRef(raw, target, locs) {
  const ref = refOf(raw);
  const parsed = parseRef(ref.ref);
  const out = { ref: ref.ref, ...parsed, ...(ref.field ? { field: ref.field } : {}), ...(ref.note ? { note: ref.note } : {}) };
  const loc = locs[parsed.source];
  if (loc.status !== "ok") return { ...out, status: "unresolved", reason: loc.reason };
  const text = read(loc, parsed.path);
  if (text == null) return { ...out, status: "missing-file", reason: `${parsed.path} not found${loc.read && loc.pinned ? ` at ${loc.read}` : ""}` };
  const lines = text.split("\n");
  const found = findAnchor(lines, parsed.anchor);
  if (!found) return { ...out, status: "missing-anchor", reason: `"${parsed.anchor}" not in ${parsed.path}` };
  if (found.index >= 0) {
    out.line = found.index + 1;
    out.snippet = lines.slice(Math.max(0, found.index - 1), found.index + 2).map((line, i) => `${Math.max(1, found.index) + i}: ${line}`.slice(0, 200));
  }
  if (ref.field) {
    const expected = target[ref.field];
    const rest = found.index >= 0 ? [lines[found.index].slice(found.column), lines[found.index + 1] || ""] : [];
    const match = rest.map((line) => NUMBER.exec(line)).find(Boolean);
    if (typeof expected !== "number") out.checked = false;
    else if (!match) return { ...out, status: "mismatch", expected, reason: `no number after the anchor for ${ref.field}` };
    else {
      const value = inSpecUnits(ref.field, Number(match[1]), match[2]);
      out.found = value;
      if (Math.abs(value - expected) > 1e-9 * Math.max(1, Math.abs(expected))) return { ...out, status: "mismatch", expected, reason: `${ref.field} is ${expected} in the spec, ${match[0].trim()} in ${parsed.path}` };
    }
  }
  const commits = changedSince(loc, parsed.path);
  if (commits.length) return { ...out, status: "stale", commits, reason: `${parsed.path} changed since ${loc.read}` };
  return { ...out, status: "ok" };
}

// The whole report. `file` is the spec's path (relative repos and "self" resolve from it).
export function sourcesReport(spec, { file, sourceDirs = {}, fetch = false, cacheDir = join(homedir(), ".cache", "topology", "repos") } = {}) {
  validateProvenance(spec);
  const base = dirname(resolve(file));
  const mapFile = join(base, ".topology-sources.json");
  const mapping = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : {};
  const declared = Object.fromEntries(Object.entries(spec.sources || {}).map(([name, source]) => [name, { ...source, given: true }]));
  const all = { self: { repo: "." }, ...declared };
  const used = new Set(placesOf(spec).flatMap(({ target }) => (target.refs || []).map((raw) => parseRef(refOf(raw).ref).source)));
  const locs = Object.fromEntries(Object.entries(all).filter(([name]) => used.has(name) || declared[name])
    .map(([name, source]) => [name, locate(name, source, { base, sourceDirs, mapping, fetch, cacheDir })]));
  const items = [];
  const unsourced = [];
  const assumed = [];
  for (const place of placesOf(spec)) {
    const refs = (place.target.refs || []).map((raw) => checkRef(raw, place.target, locs));
    const notes = (place.target.notes || []).map(noteOf);
    for (const note of notes) if (note.assumed) assumed.push({ at: place.at, ...note });
    if (refs.length || notes.length) items.push({ at: place.at, refs, notes });
    if (!refs.length && (place.kind === "node" || (place.kind === "edge" && !["config"].includes(place.target.kind)))) unsourced.push(place.at);
  }
  const summary = { ok: 0, stale: 0, mismatch: 0, "missing-file": 0, "missing-anchor": 0, unresolved: 0 };
  for (const item of items) for (const ref of item.refs) summary[ref.status]++;
  const sources = Object.fromEntries(Object.entries(locs).map(([name, { git: _g, read: _r, pinned: _p, remote: _m, ...loc }]) => [name, loc]));
  return { title: spec.title || "System", sources, items, unsourced, assumed, summary };
}

export const failed = (report, strict = false) =>
  report.summary.mismatch + report.summary["missing-file"] + report.summary["missing-anchor"] + (strict ? report.summary.stale + report.summary.unresolved : 0) > 0;

export function printSources(report, log = console.log) {
  const mark = { ok: "ok", stale: "STALE", mismatch: "MISMATCH", "missing-file": "MISSING", "missing-anchor": "MISSING", unresolved: "UNRESOLVED" };
  log(`${report.title}: sources`);
  for (const [name, source] of Object.entries(report.sources))
    log(`  ${name}: ${source.repo}${source.rev ? ` @ ${source.rev}` : ""}${source.root && source.root !== source.repo ? ` → ${source.root}` : ""}${source.status !== "ok" ? `  (unresolved: ${source.reason})` : ""}`);
  for (const item of report.items) {
    log(item.at);
    for (const ref of item.refs) {
      log(`  [${mark[ref.status]}] ${ref.ref}${ref.field ? `  (${ref.field})` : ""}${ref.line ? `  line ${ref.line}` : ""}${ref.note ? `  — ${ref.note}` : ""}`);
      if (ref.status !== "ok" && ref.reason) log(`      ${ref.reason}`);
      for (const commit of ref.commits || []) log(`      ${commit}`);
      for (const line of ref.snippet || []) log(`      | ${line}`);
    }
    for (const note of item.notes) log(`  note${note.assumed ? " (assumed)" : ""}${note.field ? ` [${note.field}]` : ""}: ${note.text}`);
  }
  if (report.assumed.length) log(`assumed: ${report.assumed.map((a) => `${a.at}${a.field ? `.${a.field}` : ""}`).join(", ")}`);
  if (report.unsourced.length) log(`unsourced: ${report.unsourced.join(", ")}`);
  log(Object.entries(report.summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(" · ") || "no refs");
}
