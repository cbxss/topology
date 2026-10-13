// Where a spec's claims come from: `sources` (named repos), and `refs` and `notes` on the spec,
// its nodes, edges and groups. Agent-facing only: scripts/sources.mjs resolves and checks the
// refs, and stripProvenance() removes all of it before a page is built, so none of it is drawn
// or shipped in the HTML.
//
//   sources: { infra: { repo: "../infra", rev: "a1b2c3d" } },     // "self" is always defined
//   refs: ["infra:k8s/api.yaml#replicas:", { ref: "self:src/api.go#func main", field: "replicas", note: "…" }],
//   notes: ["…", { text: "≈400/s from the dashboard", field: "emit", assumed: true }],

const KEYS = ["refs", "notes"];
const fail = (path, message) => { throw new Error(`spec ${path}: ${message}`); };

// "<source>:<path>[#anchor]". The anchor is a literal substring, or /regex/flags.
export function parseRef(text) {
  const match = /^([^:#\s]+):([^#]+)(?:#(.*))?$/.exec(text);
  if (!match) return null;
  return { source: match[1], path: match[2], anchor: match[3] || null };
}

export const refOf = (ref) => (typeof ref === "string" ? { ref } : ref);
export const noteOf = (note) => (typeof note === "string" ? { text: note } : note);

// Everything that can carry refs and notes, with a readable name.
export function placesOf(spec) {
  const edgeName = (edge) => (Array.isArray(edge) ? `${edge[0]}>${edge[1]}` : `${edge.from}>${edge.to}`);
  return [
    { at: "spec", kind: "spec", target: spec },
    ...(spec.nodes || []).map((node) => ({ at: `node ${node.id}`, kind: "node", id: node.id, target: node })),
    ...(spec.edges || []).map((edge) => ({ at: `edge ${edgeName(edge)}`, kind: "edge", id: edgeName(edge), target: Array.isArray(edge) ? {} : edge })),
    ...(spec.groups || []).map((group) => ({ at: `group ${group.id}`, kind: "group", id: group.id, target: group })),
  ];
}

export function validateProvenance(spec) {
  if (spec.sources != null) {
    if (typeof spec.sources !== "object" || Array.isArray(spec.sources)) fail("sources", "expected an object of name → { repo, rev }");
    for (const [name, source] of Object.entries(spec.sources)) {
      if (!/^[^:#\s]+$/.test(name)) fail(`sources.${name}`, "a source name cannot contain ':', '#' or spaces");
      if (!source || typeof source !== "object" || !(typeof source.repo === "string" ? source.repo : source.repo instanceof URL)) fail(`sources.${name}`, "expected { repo: path, URL or remote, rev? }");
      if (source.rev != null && (typeof source.rev !== "string" || !source.rev)) fail(`sources.${name}.rev`, "expected a commit, tag or branch");
    }
  }
  const known = new Set(["self", ...Object.keys(spec.sources || {})]);
  for (const { at, target } of placesOf(spec)) {
    for (const key of KEYS) if (target[key] != null && !Array.isArray(target[key])) fail(`${at}.${key}`, "expected an array");
    for (const raw of target.refs || []) {
      const ref = refOf(raw);
      if (!ref || typeof ref.ref !== "string") fail(`${at}.refs`, "expected \"source:path#anchor\" or { ref, field, note }");
      const parsed = parseRef(ref.ref);
      if (!parsed) fail(`${at}.refs`, `"${ref.ref}" is not "source:path#anchor"`);
      if (!known.has(parsed.source)) fail(`${at}.refs`, `unknown source ${parsed.source} in "${ref.ref}"`);
      if (ref.field != null && typeof ref.field !== "string") fail(`${at}.refs`, "field must be a string");
    }
    for (const raw of target.notes || []) {
      const note = noteOf(raw);
      if (!note || typeof note.text !== "string" || !note.text) fail(`${at}.notes`, "expected text or { text, field, assumed }");
    }
  }
  return spec;
}

// A copy of the spec without sources, refs or notes anywhere.
export function stripProvenance(spec) {
  const clean = (object) => {
    if (!object || Array.isArray(object) || !KEYS.some((key) => key in object)) return object;
    const { refs: _r, notes: _n, ...rest } = object;
    return rest;
  };
  const { sources: _, ...rest } = clean(spec);
  for (const key of ["nodes", "edges", "groups"]) if (Array.isArray(rest[key])) rest[key] = rest[key].map(clean);
  return rest;
}
