// The component catalog: every node kind and every pattern, drawn in iso and 2D, with the
// spec that makes it. Each pattern tile is built by evaluating the very snippet it shows.
//
//   node scripts/catalog.mjs [--light] [--stdout] [--out file]
//
// Default output: examples/catalog/catalog.html (or catalog-light.html).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../kit/iso.mjs";
import * as patterns from "../kit/patterns.mjs";
import { modelOf, renderView, TOPO_CSS } from "../kit/topo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const theme = argv.includes("--light") ? "light" : "dark";

const KINDS = [
  ["client", {}, "A user or a caller: a laptop. Usually a source, with `emit`."],
  ["lb", {}, "A load balancer: round-robins over healthy targets, noticing a dead one after `detect` seconds."],
  ["gateway", { capacity: 12 }, "An API gateway: round-robin like an LB; with `capacity` it sheds the excess (429s)."],
  ["service", { replicas: 3 }, "A stack of 1U servers, one per replica (up to 4), each with its own LED."],
  ["worker", { replicas: 2 }, "A background worker: a service with a fan on top. Consumes from logs and queues."],
  ["cache", {}, "Memory chips on a board. Cache-aside: callers check it first, misses go on (`p`)."],
  ["redis", {}, "Redis: a low memory-tile stack, with shared cache behavior."],
  ["elasticache", {}, "ElastiCache: an enclosed memory stack; shared cache behavior, no managed-service control plane."],
  ["dynamodb", { tables: { items: { key: "itemId" } } }, "DynamoDB: a rectangular cell cabinet with synthetic tables and record inspection; no AWS API emulation."],
  ["db", { role: "primary" }, "Stacked disks with a role on top. Replicas follow through `replication` edges."],
  ["storage", {}, "Object storage: a bucket of disks, wider at the top."],
  ["kafka", { partitions: 3, brokers: 3 }, "A topic: one lane of record cells per partition, a cursor per consumer group; with `brokers`, clickable broker units."],
  ["queue", {}, "A queue: one lane; its consumers compete for messages."],
  ["cdn", { hit: 0.9 }, "An edge PoP with a globe: serves `hit`, sends misses to its origin."],
  ["dns", { ttl: 30 }, "A DNS tower: routes like an LB, but clients keep stale answers for `ttl` seconds."],
  ["external", { ms: 300 }, "A third-party API, outlined dashed. Give it a realistic `ms`."],
  ["scheduler", { emit: { every: 5, burst: 10 } }, "A clock: emits `burst` requests every `every` seconds."],
  ["flags", {}, "A flag service: one switch per flag, its knob at the rollout. Drives `flag`/`unless` edges."],
  ["box", {}, "Anything else: a plain block."],
  ["service", { replicas: 2, sidecar: true }, "Any service with `sidecar: true`: a proxy box on its side that adds `sidecarMs`.", "service + sidecar"],
  ["service", { replicas: 2, capacity: 10, queue: 6 }, "With `capacity` and `queue`, a buffer of cells on top fills (amber) when it's over capacity.", "service + buffer"],
];

const PATTERNS = [
  ["kafkaTopic", "A topic and its consumer groups, each consumer a worker, wired with its group.", `compose({},
  { nodes: [{ id: "api", kind: "service", emit: 10 }] },
  kafkaTopic("orders", {
    partitions: 6,
    groups: { billing: { consumers: 2, rate: 8 }, search: { consumers: 1, rate: 20 } },
  }),
  link("api", "orders"),
)`],
  ["region", "Load balancer → API → database on a region plate, with an optional cache in front and a replica behind. \`in\` is the LB, \`out\` the API.", `compose({},
  { nodes: [{ id: "users", kind: "client", emit: 12 }] },
  region("us", { label: "us-east-1", cache: { hit: 0.85 }, replica: true }),
  link("users", "us-lb"),
)`],
  ["cacheAside", "Every request checks the cache; the misses (1 − hit) go to the database.", `compose({},
  { nodes: [{ id: "users", kind: "client", emit: 10 },
            { id: "api", kind: "service" }, { id: "pg", kind: "db" }] },
  link("users", "api"),
  cacheAside("api", { db: "pg", hit: 0.9 }),
)`],
  ["replicatedDb", "A primary and its streaming replicas.", `compose({},
  { nodes: [{ id: "api", kind: "service", emit: 8 }] },
  replicatedDb("pg", { replicas: 2 }),
  link("api", "pg"),
)`],
  ["queueWorkers", "A queue and the workers competing for it.", `compose({},
  { nodes: [{ id: "api", kind: "service", emit: 15 }] },
  queueWorkers("jobs", { workers: 3, rate: 6 }),
  link("api", "jobs"),
)`],
  ["canary", "A router splits traffic by a feature flag, pushed from a flag service. \`out\` is [v1, v2].", `compose({},
  { nodes: [{ id: "users", kind: "client", emit: 12 },
            { id: "lb", kind: "lb", route: "all" }] },
  link("users", "lb"),
  canary("checkout", { router: "lb", rollout: 0.25 }),
)`],
];

// Reuse the example sources so the catalog cannot drift from the runnable stories.
for (const [name, note] of [
  ["order-journey", "Follow one scoped order through primary commits, events, projection, replica and cache expiration."],
  ["flagged-projection-rollout", "Optional projection rollout with captured flag decisions and an honest divergent copy."],
  ["tenant-routing", "Immutable context selects service and database; traffic colors reveal tenant isolation."],
  ["event-routing", "Kafka retains mixed event context through backlog and downstream consumer routing."],
  ["orders-api", "Endpoint mixes: inspect per-route latency, synthetic rows and WAL."],
  ["read-your-writes", "Sequential write/read calls expose stale replica reads, then primary read-back."],
  ["idempotent-retries", "Retries keep a record key: INSERT conflicts, UPSERT preserves row content."],
  ["lost-update", "Hot-key read-modify-write races; row locks trade lost updates for waiting."],
]) {
  const {default: spec} = await import(new URL(`../examples/${name}/${name}.spec.mjs`, import.meta.url));
  PATTERNS.push([name, note, JSON.stringify(spec, null, 2)]);
}

const fmt = (value) => (typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(fmt).join(", ")}]` : value && typeof value === "object" ? `{ ${Object.entries(value).map(([key, v]) => `${key}: ${fmt(v)}`).join(", ")} }` : String(value));
const code = (text) => `<pre class="cat-code"><code>${k.escape(text)}</code></pre>`;
const views = (spec, width, maxScale) => {
  const model = modelOf(spec, ["-labels"]);
  return ["iso", "flat"].map((view) => `<div class="cat-view" data-view="${view}">${renderView(model, view, width, undefined, { maxScale }).svg}</div>`).join("");
};

const kindTiles = KINDS.map(([kind, props, note, title = kind]) => {
  const node = { id: title.replace(/ \+ /g, "-"), kind, ...props, label: title.split(" ")[0] };
  const spec = { nodes: [node], edges: [], ...(kind === "flags" ? { flags: { "new-checkout": { rollout: 0.3 }, "dark-mode": { rollout: 1 } } } : {}) };
  const snippet = fmt({ id: kind === "flags" ? "flagd" : "…", kind, ...props });
  return `<article class="cat-tile"><h3>${k.escape(title)}</h3><div class="cat-views">${views(spec, 300, 3.4)}</div><p>${k.escape(note).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>${code(snippet)}</article>`;
}).join("");

const patternTiles = PATTERNS.map(([name, note, source]) => {
  const spec = new Function(...Object.keys(patterns), `return ${source};`)(...Object.values(patterns));
  return `<article class="cat-tile cat-wide"><h3>${name}</h3><div class="cat-views">${views(spec, 520)}</div><p>${k.escape(note).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>${code(source)}</article>`;
}).join("");

const CSS = `
.cat-head{margin:0 0 28px}
.cat-head h1{margin:0 0 8px;font:600 13px/1 var(--tp-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--tp-strong)}
.cat-head p{margin:0;max-width:720px;color:var(--tp-text)}
.cat-section{margin:44px 0 16px;font:600 11px/1 var(--tp-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--tp-muted)}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px}
.cat-tile{background:var(--tp-card);box-shadow:0 0 0 1px var(--tp-lo);padding:16px 16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.cat-wide{grid-column:span 2}
@media (max-width:760px){.cat-wide{grid-column:auto}}
.cat-tile h3{margin:0;font:600 12px/1 var(--tp-mono);letter-spacing:.06em;color:var(--tp-strong)}
.cat-views{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:center}
.cat-view{min-width:0}
.cat-tile p{margin:0;font-size:12.5px;line-height:1.5;color:var(--tp-text)}
.cat-tile p code,.cat-head code{font:11.5px var(--tp-mono);color:var(--tp-strong)}
.cat-code{margin:0;padding:10px 12px;background:var(--tp-page);box-shadow:0 0 0 1px var(--tp-faint);overflow-x:auto;font:11px/1.55 var(--tp-mono);color:var(--tp-text)}
`;

const body = `<style>${TOPO_CSS}${CSS}</style><header class="cat-head"><h1>Topology · components</h1><p>Every node kind, and every pattern in <code>kit/patterns.mjs</code>, in iso and 2D. A kind goes in a spec as a node; a pattern is a function that returns a fragment of nodes, edges and groups, which <code>compose()</code> joins into a spec and <code>link()</code> wires to the rest. Each pattern figure below is built from the code under it.</p></header>
<h2 class="cat-section">Node kinds</h2><div class="cat-grid">${kindTiles}</div>
<h2 class="cat-section">Patterns</h2><div class="cat-grid">${patternTiles}</div>`;

const html = k.pageHtml({ title: "Topology components", theme, body, width: 1180 });
if (argv.includes("--stdout")) process.stdout.write(html);
else {
  const at = argv.indexOf("--out");
  const out = resolve(at >= 0 ? argv[at + 1] : join(ROOT, "examples", "catalog", theme === "light" ? "catalog-light.html" : "catalog.html"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log("wrote", out);
}
