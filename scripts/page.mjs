// Shared by build.mjs and serve.mjs: load a spec (with its layout sidecar), build the page,
// and run the headless check.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as k from "../kit/iso.mjs";
import { hiddenBy, labelSpots, prepare, projectionOf, renderView, simSpec, SLOTS, TOPO_CSS } from "../kit/topo.mjs";
import { createSim, formatCount, formatMs, formatRate, normalizeScenario } from "../kit/topo-sim.mjs";
import { describeFeatures, resolveFeatures } from "../kit/topo-features.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");
const strip = (source) => source.replace(/^export /gm, "");

export const nameOf = (file) => basename(file).replace(/\.(spec\.)?(mjs|js|json)$/, "");
export const layoutFileOf = (file) => join(dirname(file), `${nameOf(file)}.layout.json`);

// Positions dragged in serve mode live in <name>.layout.json next to the spec, so the spec
// itself is never rewritten. They override `at` on the nodes they name.
export async function loadSpec(file) {
  const spec = extname(file) === ".json" ? JSON.parse(readFileSync(file, "utf8")) : (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default;
  const sidecar = layoutFileOf(file);
  if (existsSync(sidecar)) {
    const { at = {} } = JSON.parse(readFileSync(sidecar, "utf8"));
    spec.nodes = spec.nodes.map((node) => (at[node.id] ? { ...node, at: at[node.id] } : node));
  }
  return spec;
}

export function modelOf(spec, featureLayers = []) {
  const features = resolveFeatures(spec.features, ...featureLayers);
  const model = prepare(spec);
  model.features = features;
  return model;
}

export function buildPage(spec, { theme = "dark", view, featureLayers = [], edit = false } = {}) {
  const model = modelOf(spec, featureLayers);
  const features = model.features;
  view ||= spec.view || "iso";
  const rendered = { iso: renderView(model, "iso"), flat: renderView(model, "flat") };
  const data = {
    view,
    slots: SLOTS,
    features,
    edit: edit && features.edit,
    grid: model.grid,
    positions: Object.fromEntries(model.nodes.map((node) => [node.id, node.at || node.auto])),
    spec: simSpec(model),
    lens: model.edges.map((edge) => edge.lens.map((n) => Math.round(n * 100) / 100)),
    views: { iso: rendered.iso.data, flat: rendered.flat.data },
  };
  data.views.flat.k = k.cameraOf(rendered.flat.P).k;
  for (const v of Object.values(data.views)) delete v.P;

  const sim = createSim(data.spec);
  for (let i = 0; i < 180; i++) sim.step(1 / 60);

  const keys = spec.keys || legendOf(model);
  const svgOf = (v) => rendered[v].svg.replace("<svg", `<svg${view === v ? "" : " hidden"}`);
  const stageHtml = `<style>${TOPO_CSS}</style><div class="tp-views" role="group" aria-label="View">${["iso", "flat"].map((v) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${v === "iso" ? "ISO" : "2D"}</button>`).join("")}</div><div class="tp-stage" tabindex="0" role="application" aria-label="${escapeAttr(model.title)}: hover or arrow keys pick a node, Enter fails or restores it, V switches between isometric and 2D">${svgOf("iso")}${svgOf("flat")}</div>`;
  const body = k.plateHtml({
    fig: model.fig,
    title: model.title,
    hint: data.edit ? "Edit: drag nodes in 2D · positions save to the layout file" : model.hint || "Hover a node · click to fail it · V for 2D",
    readout: sim.summary(),
    keys,
    caption: model.caption,
    body: stageHtml,
  });
  let script = strip(readFileSync(join(KIT, "topo-sim.mjs"), "utf8")) + `\nconst DATA = ${JSON.stringify(data)};\n` + readFileSync(join(KIT, "topo-live.js"), "utf8");
  if (features.scenario && spec.scenario) script += "\n" + readFileSync(join(KIT, "topo-story.js"), "utf8");
  if (data.edit) script += "\n" + readFileSync(join(KIT, "topo-edit.js"), "utf8");
  const html = k.pageHtml({ title: model.title, theme, body, script, width: Math.max(rendered.iso.width, 650) + 48 });
  return { html, rendered, model };
}

export function svgOf(rendered, view, theme) {
  return rendered[view].svg
    .replace('class="k-svg', `width="${rendered[view].width}" height="${rendered[view].height}" data-theme="${theme}" class="tp k-svg`)
    .replace(/(<svg[^>]*>)/, `$1<style>${k.KIT_CSS}${TOPO_CSS}.k-svg{background:var(--tp-card)}</style>`);
}

function legendOf(model) {
  const kinds = new Set(model.edges.map((edge) => edge.kind));
  const sync = model.edges.some((edge) => edge.sync);
  const keys = [{ mark: "lit", label: "Request" }];
  if (sync) keys.push({ mark: "raised", label: "Response" });
  if (model.nodes.some((node) => node.kind === "kafka" || node.kind === "queue")) keys.push({ mark: "blue", label: "Record pulled by a consumer" });
  if (kinds.has("replication")) keys.push({ mark: "green", label: "Replication" });
  if (model.edges.some((edge) => edge.retries)) keys.push({ mark: "amber", label: "Retry" });
  if (kinds.has("async") || kinds.has("replication")) keys.push({ mark: "dashed", label: "Async link" });
  keys.push({ mark: "red", label: "Error, refused or dropped" });
  return keys;
}

const escapeAttr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function check(spec, { seconds = 30, featureLayers = [], log = console.log } = {}) {
  const model = modelOf(spec, featureLayers);
  const sim = createSim(simSpec(model));
  const warnings = [];
  const story = model.features.scenario ? normalizeScenario(spec.scenario) : null;
  if (story) seconds = Math.max(seconds, story.length);
  log(`${model.title}: ${model.nodes.length} nodes, ${model.edges.length} edges, ${seconds}s simulated`);
  log(`features: ${describeFeatures(model.features)}`);
  if (story) {
    try {
      storyTimeline(model, story, log, warnings);
    } catch (error) {
      warnings.push(`scenario: ${error.message}`);
    }
  }
  const lagAt = [];
  for (let t = 1; t <= seconds; t++) {
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    lagAt.push([...sim.logs.keys()].map((id) => sim.lagOf(id)));
    if (t % Math.max(1, Math.floor(seconds / 6)) === 0) log(`  t=${String(t).padStart(3)}s  ${sim.summary()}`);
  }
  log(story ? `nodes at ${seconds}s:` : "nodes:");
  for (const node of model.nodes) log(`  ${sim.statsOf(node.id)}`);
  [...sim.logs.keys()].forEach((id, index) => {
    const mid = lagAt[Math.floor(lagAt.length / 2)]?.[index] ?? 0;
    const end = lagAt[lagAt.length - 1]?.[index] ?? 0;
    if (end > 40 && end > mid * 1.3) warnings.push(`${id}: lag keeps growing (${mid} → ${end}); its consumers are slower than its producers`);
  });
  for (const edge of sim.edges) {
    if (edge.sent === 0 && !edge.flag) warnings.push(`edge ${edge.from} → ${edge.to} never carried anything`);
    else if (edge.dropped) {
      const target = model.byId.get(edge.to);
      warnings.push(`edge ${edge.from} → ${edge.to}: ${edge.dropped} of ${edge.sent} dropped${target.capacity ? ` (${edge.to} admits ${target.capacity}/s; expected if you meant to show shedding)` : ""}`);
    }
  }
  if (!model.nodes.some((node) => node.emit)) warnings.push("no node has `emit`: nothing will move");
  warnings.push(...layoutWarnings(model));
  if (warnings.length) {
    log("warnings:");
    for (const warning of warnings) log(`  ${warning}`);
  } else log("check passed");
  return { model, sim, warnings };
}

// The story, phase by phase: the readout just before and 3 s after each step, and each
// phase's settled numbers (averaged over its last 3 s).
function storyTimeline(model, story, log, warnings) {
  const sim = createSim(simSpec(model));
  const per = sim.cfg.per;
  const ids = new Set(model.nodes.map((node) => node.id));
  for (const step of story.steps) {
    for (const id of [].concat(step.fail || [], step.recover || [], Object.keys(step.set || {}))) if (!ids.has(id)) warnings.push(`scenario step at ${step.at}s names unknown node "${id}"`);
    if (step.at > story.length) warnings.push(`scenario step at ${step.at}s is past the story's length (${story.length}s)`);
  }
  const samples = [];
  const marks = story.steps.flatMap((step) => [{ at: step.at - 0.1, label: "before", step }, { at: step.at + 3, label: "+3s", step }]);
  log(`story: ${story.length}s${story.loop ? ", loops" : ""}, ${story.phases.length} phases, ${story.steps.length} steps`);
  const lines = [];
  for (let i = 1; i <= story.length * 60; i++) {
    sim.step(1 / 60);
    const t = i / 60;
    if (i % 15 === 0) {
      const lat = sim.latencyOf();
      samples.push({ t, in: sim.totalIn(), p50: lat.p50, p99: lat.p99, failing: lat.failed / 3, lag: [...sim.logs.keys()].reduce((sum, id) => sum + sim.lagOf(id), 0) });
    }
    for (const mark of marks) if (!mark.done && t >= mark.at) {
      mark.done = true;
      lines.push({ at: mark.at, text: `  ${t.toFixed(1).padStart(5)}s ${mark.label === "before" ? "before" : "  +3s "} ${describeStep(mark.step)}: ${sim.summary()}` });
    }
  }
  const phases = story.phases.length ? story.phases : [{ name: "story", at: 0, end: story.length }];
  for (const phase of phases) {
    const window = samples.filter((s) => s.t > Math.max(phase.at, phase.end - 3) && s.t <= phase.end);
    const mean = (key) => window.reduce((sum, s) => sum + s[key], 0) / Math.max(1, window.length);
    log(`phase ${phase.name} (${phase.at}–${phase.end}s): ${formatRate(mean("in"), per)} in · p50 ${formatMs(mean("p50"))} · p99 ${formatMs(mean("p99"))}${sim.logs.size ? ` · lag ${formatCount(mean("lag"), per)}` : ""} · ${formatRate(mean("failing"), per)} failing`);
    for (const line of lines) if (line.at >= phase.at - 0.2 && line.at < phase.end - 0.2) log(line.text);
  }
  const end = samples[samples.length - 1];
  const start = samples.find((s) => s.t >= 3) || samples[0];
  if (story.loop && end && end.lag > Math.max(20, start.lag * 3)) warnings.push(`the story ends with lag ${formatCount(end.lag, per)} (it began near ${formatCount(start.lag, per)}); it will jump when it loops`);
  if (story.loop && end && end.failing > Math.max(0.5, start.failing * 3)) warnings.push("the story ends still failing; it will jump when it loops");
}

const describeStep = (step) =>
  [step.fail && `fail ${[].concat(step.fail).join(",")}`, step.recover && `recover ${[].concat(step.recover).join(",")}`, step.set && `set ${Object.keys(step.set).join(",")}`, step.flag && `${step.flag} → ${Math.round((step.rollout ?? 1) * 100)}%`, step.kill && `kill ${step.kill}`].filter(Boolean).join(", ") || "say";

export function layoutWarnings(model) {
  const warnings = [];
  for (const node of model.nodes) {
    for (const other of model.nodes) {
      if (other.index <= node.index) continue;
      const ox = Math.abs(other.cx - node.cx) < (node.w + other.w) / 2;
      const oy = Math.abs(other.cy - node.cy) < (node.d + other.d) / 2;
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
  return warnings;
}
