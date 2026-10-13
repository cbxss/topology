import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as k from "../kit/iso.mjs";
import { hiddenBy, labelSpots, prepare, projectionOf, renderView, simSpec, SLOTS, TOPO_CSS } from "../kit/topo.mjs";
import { createSim } from "../kit/topo-sim.mjs";
import { describeFeatures, resolveFeatures } from "../kit/topo-features.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");
const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(`Build a system figure from a spec.

  node build.mjs <spec.mjs | spec.json> [options]

  --light             light theme (default dark)
  --view iso|flat     the view the page opens in (default: spec.view, else iso)
  --out <file>        output path (default: <spec name>.html, or <spec name>-light.html, next to the spec)
  --svg               also write a static <name>-<view>.svg of each view (standalone, themed)
  --features <list>   turn tool features on or off: "trails,-morph" (see kit/topo-features.mjs)
  --no-<feature>      the same, for one feature
  --check [seconds]   run the model headless for that long (default 30) and print what the readout
                      will say, per node, plus warnings: growing lag, drops, idle edges. Writes nothing.`);
  process.exit(argv.length ? 0 : 1);
}
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};

const file = resolve(argv[0]);
const spec = extname(file) === ".json" ? JSON.parse(readFileSync(file, "utf8")) : (await import(pathToFileURL(file).href)).default;
const cliFeatures = [value("--features", ""), ...argv.filter((arg) => arg.startsWith("--no-")).map((arg) => "-" + arg.slice(5))].filter(Boolean).join(",");
const features = resolveFeatures(spec.features, cliFeatures);
const model = prepare(spec);
model.features = features;
const name = basename(file).replace(/\.(spec\.)?(mjs|js|json)$/, "");

if (flag("--check")) {
  check(Number(value("--check", 30)));
  process.exit(process.exitCode ?? 0);
}

const theme = flag("--light") ? "light" : "dark";
const view = value("--view", spec.view || "iso");
const rendered = { iso: renderView(model, "iso"), flat: renderView(model, "flat") };
const strip = (source) => source.replace(/^export /gm, "");
const data = {
  view,
  slots: SLOTS,
  features,
  spec: simSpec(model),
  lens: model.edges.map((edge) => edge.lens.map((n) => Math.round(n * 100) / 100)),
  views: { iso: rendered.iso.data, flat: rendered.flat.data },
};
for (const v of Object.values(data.views)) delete v.P;

const sim = createSim(data.spec);
for (let i = 0; i < 180; i++) sim.step(1 / 60);

const keys = spec.keys || legendOf(model);
const stageHtml = `<style>${TOPO_CSS}</style><div class="tp-views" role="group" aria-label="View">${["iso", "flat"].map((v) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${v === "iso" ? "ISO" : "2D"}</button>`).join("")}</div><div class="tp-stage" tabindex="0" role="application" aria-label="${escapeAttr(model.title)}: hover or arrow keys pick a node, Enter fails or restores it, V switches between isometric and 2D">${rendered.iso.svg.replace("<svg", `<svg${view === "iso" ? "" : " hidden"}`)}${rendered.flat.svg.replace("<svg", `<svg${view === "flat" ? "" : " hidden"}`)}</div>`;
const body = k.plateHtml({
  fig: model.fig,
  title: model.title,
  hint: model.hint || "Hover a node · click to fail it · V for 2D",
  readout: sim.summary(),
  keys,
  caption: model.caption,
  body: stageHtml,
});
const script = strip(readFileSync(join(KIT, "topo-sim.mjs"), "utf8")) + `\nconst DATA = ${JSON.stringify(data)};\n` + readFileSync(join(KIT, "topo-live.js"), "utf8");
const out = resolve(value("--out", join(dirname(file), theme === "light" ? `${name}-light.html` : `${name}.html`)));
writeFileSync(out, k.pageHtml({ title: model.title, theme, body, script, width: Math.max(rendered.iso.width, 650) + 48 }));
console.log("wrote", out);
if (flag("--svg")) {
  for (const v of ["iso", "flat"]) {
    const svgOut = out.replace(/\.html$/, `-${v}.svg`);
    const svg = rendered[v].svg.replace('class="k-svg', `width="${rendered[v].width}" height="${rendered[v].height}" data-theme="${theme}" class="tp k-svg`).replace(/(<svg[^>]*>)/, `$1<style>${k.KIT_CSS}${TOPO_CSS}.k-svg{background:var(--tp-card)}</style>`);
    writeFileSync(svgOut, svg);
    console.log("wrote", svgOut);
  }
}

function legendOf(model) {
  const kinds = new Set(model.edges.map((edge) => edge.kind));
  const sync = model.edges.some((edge) => edge.sync);
  const keys = [{ mark: "lit", label: "Request" }];
  if (sync) keys.push({ mark: "raised", label: "Response" });
  if (model.nodes.some((node) => node.kind === "kafka" || node.kind === "queue")) keys.push({ mark: "blue", label: "Record pulled by a consumer" });
  if (kinds.has("replication")) keys.push({ mark: "green", label: "Replication" });
  if (kinds.has("async") || kinds.has("replication")) keys.push({ mark: "dashed", label: "Async link" });
  keys.push({ mark: "red", label: "Dropped: node down or over capacity" });
  return keys;
}

function escapeAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function check(seconds) {
  const sim = createSim(simSpec(model));
  console.log(`features: ${describeFeatures(features)}`);
  const lagAt = [];
  const sentAt = new Map();
  console.log(`${model.title}: ${model.nodes.length} nodes, ${model.edges.length} edges, ${seconds}s simulated`);
  for (let t = 1; t <= seconds; t++) {
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    lagAt.push([...sim.logs.keys()].map((id) => sim.lagOf(id)));
    if (t === Math.ceil(seconds / 2)) sim.edges.forEach((edge) => sentAt.set(edge.index, edge.sent));
    if (t % Math.max(1, Math.floor(seconds / 6)) === 0) console.log(`  t=${String(t).padStart(3)}s  ${sim.summary()}`);
  }
  console.log("nodes:");
  for (const node of model.nodes) console.log(`  ${sim.statsOf(node.id)}`);
  const warnings = [];
  [...sim.logs.keys()].forEach((id, index) => {
    const mid = lagAt[Math.floor(lagAt.length / 2)]?.[index] ?? 0;
    const end = lagAt[lagAt.length - 1]?.[index] ?? 0;
    if (end > 40 && end > mid * 1.3) warnings.push(`${id}: lag keeps growing (${mid} → ${end}); its consumers are slower than its producers`);
  });
  for (const edge of sim.edges) {
    if (edge.sent === 0) warnings.push(`edge ${edge.from} → ${edge.to} never carried anything`);
    else if (edge.dropped) {
      const target = model.byId.get(edge.to);
      warnings.push(`edge ${edge.from} → ${edge.to}: ${edge.dropped} of ${edge.sent} dropped${target.capacity ? ` (${edge.to} admits ${target.capacity}/s; expected if you meant to show shedding)` : ""}`);
    }
  }
  if (!model.nodes.some((node) => node.emit)) warnings.push("no node has `emit`: nothing will move");
  for (const node of model.nodes) {
    const [x, y] = [node.cx, node.cy];
    for (const other of model.nodes) {
      if (other.index <= node.index) continue;
      const ox = Math.abs(other.cx - x) < (node.w + other.w) / 2;
      const oy = Math.abs(other.cy - y) < (node.d + other.d) / 2;
      if (ox && oy) warnings.push(`nodes ${node.id} and ${other.id} overlap; set \`at\` or \`grid\``);
    }
  }
  for (const edge of model.edges) {
    for (const node of model.nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      const p = node.plan;
      const hit = edge.points.some(([x, y]) => x > p.x + 1 && x < p.x + p.w - 1 && y > p.y + 1 && y < p.y + p.d - 1);
      if (hit) warnings.push(`edge ${edge.from} → ${edge.to} passes under ${node.id}; give it \`bend\`, \`via\` or move a node`);
    }
  }
  // In iso a label lies on the floor beside its node; a nearer, taller node can hide it.
  const { P } = projectionOf(model, "iso");
  for (const node of model.nodes) {
    const spots = labelSpots(node);
    const tries = node.labelAt === "side" ? [spots[1]] : node.labelAt === "front" ? [spots[0]] : spots;
    const blocked = tries.map((spot) => hiddenBy(model, node, spot, P));
    if (blocked.every((list) => list.length)) warnings.push(`label "${node.label}" is hidden behind ${blocked[0].join(", ")} in iso; space the rows (\`grid\`) or move a node`);
  }
  if (warnings.length) {
    console.log("warnings:");
    for (const warning of warnings) console.log(`  ${warning}`);
  } else console.log("check passed");
}
