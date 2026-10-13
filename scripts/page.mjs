// Shared by build.mjs and serve.mjs: load a spec (with its layout sidecar), build the page,
// and run the headless check.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as k from "../kit/iso.mjs";
import { labelPlanOf, modelOf, projectionOf, renderView, simSpec, SLOTS, TOPO_CSS } from "../kit/topo.mjs";
import { createSim, formatCount, formatMs, formatRate, isLog, normalizeScenario, targetOf } from "../kit/topo-sim.mjs";
import { bundleSim } from "./sim-bundle.mjs";
import { describeFeatures } from "../kit/topo-features.mjs";
import { stripProvenance, validateProvenance } from "../kit/provenance.mjs";

export { modelOf };

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");

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

// Sources, refs and notes are for agents (build.mjs --sources); no page or model sees them.
const figureOf = (spec) => stripProvenance(validateProvenance(spec));

export function buildPage(spec, { theme = "dark", view, featureLayers = [], edit = false } = {}) {
  spec = figureOf(spec);
  const model = modelOf(spec, featureLayers);
  const features = model.features;
  view ||= spec.view || "iso";
  const rendered = { iso: renderView(model, "iso"), flat: renderView(model, "flat") };
  const data = {
    view,
    ...(spec.traffic ? { traffic: spec.traffic, colorBy: spec.colorBy || "traffic" } : {}),
    slots: SLOTS,
    features,
    edit: edit && features.edit,
    labels: model.labels,
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
  const shown = (v) => rendered[v].svg.replace("<svg", `<svg${view === v ? "" : " hidden"}`);
  const stageHtml = `<style>${TOPO_CSS}${spec.traffic ? readFileSync(join(KIT, "traffic.css"), "utf8") : ""}</style><div class="tp-views" role="group" aria-label="View">${["iso", "flat"].map((v) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${v === "iso" ? "ISO" : "2D"}</button>`).join("")}</div><div class="tp-stage" tabindex="0" role="application" aria-label="${k.escape(model.title)}: hover or arrow keys pick a node, Enter inspects it, F fails or restores it, V switches between isometric and 2D">${shown("iso")}${shown("flat")}</div>`;
  const body = k.plateHtml({
    fig: model.fig,
    title: model.title,
    hint: data.edit ? "Edit: drag nodes in 2D · positions save to the layout file" : model.hint || "Hover a node · click to inspect · V for 2D",
    readout: sim.summary(),
    keys,
    caption: model.caption,
    body: stageHtml,
  });
  if (features.morph) data.raw = spec;
  let script = bundleSim() + `\nconst DATA = ${JSON.stringify(data)};\n`;
  // The morph re-renders the iso scene in the page, so it needs the kit and the renderers,
  // each wrapped in its own scope so none of their names meet the live code's.
  if (features.morph) script += scoped("iso.mjs", "k") + scoped("components.mjs", "PRODUCTS") + scoped("routing-validation.mjs", "ROUTING_VALIDATION") + scoped("entity-validation.mjs", "ENTITY_VALIDATION") + scoped("validate.mjs", "VALIDATION", "const { validateRouting } = ROUTING_VALIDATION; const { validateEntities } = ENTITY_VALIDATION;") + scoped("labels.mjs", "LABELS") + scoped("topo.mjs", "TOPO", "const { COMPONENTS, baseKind, isoComponent, flatComponent } = PRODUCTS; const { validateSpec } = VALIDATION; const { CHAR, anchorFor, lineAt, localBox, placeLabels, planBox, wrapLabel } = LABELS;");
  script += readFileSync(join(KIT, "topo-live.js"), "utf8") + "\n" + readFileSync(join(KIT, "topo-inspect.js"), "utf8");
  if (spec.traffic) script += "\n" + readFileSync(join(KIT, "topo-traffic.js"), "utf8");
  if (features.tables) script += "\n" + readFileSync(join(KIT, "topo-records.js"), "utf8");
  if (model.entities) script += "\n" + readFileSync(join(KIT, "topo-entities.js"), "utf8");
  if (features.trace) script += "\n" + readFileSync(join(KIT, "topo-trace.js"), "utf8");
  if (model.scenario) script += "\n" + readFileSync(join(KIT, "topo-story.js"), "utf8");
  if (data.edit) script += "\n" + readFileSync(join(KIT, "topo-edit.js"), "utf8");
  const html = k.pageHtml({ title: model.title, theme, body, script, width: Math.max(rendered.iso.width, 650) + 48 });
  return { html, rendered, model };
}

function scoped(file, name, bindings = "") {
  const source = readFileSync(join(KIT, file), "utf8").replace(/^import .*$/gm, "");
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
  return `const ${name} = (() => {\n${bindings}\n${source.replace(/^export /gm, "")}\nreturn { ${names.join(", ")} };\n})();\n`;
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
  if (model.nodes.some(isLog)) keys.push({ mark: "blue", label: "Record pulled by a consumer" });
  if (kinds.has("replication")) keys.push({ mark: "green", label: "Replication" });
  if (model.edges.some((edge) => edge.retries)) keys.push({ mark: "amber", label: "Retry" });
  if (kinds.has("async") || kinds.has("replication")) keys.push({ mark: "dashed", label: "Async link" });
  keys.push({ mark: "red", label: "Error, refused or dropped" });
  return keys;
}


// Run the model headless and print what the readout will say. With a scenario: the story
// phase by phase (each phase's settled numbers, the readout just before and 3 s after each
// step), all from one run.
export function check(spec, { seconds = 30, featureLayers = [], log = console.log } = {}) {
  spec = figureOf(spec);
  const model = modelOf(spec, featureLayers);
  const sim = createSim(simSpec(model));
  sim.quiet = true;
  const per = sim.cfg.per;
  const warnings = [];
  if (spec.entities && !model.entities) warnings.push('entity execution disabled: entities requires endpoints and tables');
  if (spec.entities && !model.features.flags) warnings.push('modeled flag gates removed: alternative entity branches may both execute');
  const story = model.features.scenario ? normalizeScenario(model.scenario) : null;
  if (story) seconds = Math.max(seconds, story.length);
  log(`${model.title}: ${model.nodes.length} nodes, ${model.edges.length} edges, ${seconds}s simulated`);
  log(`features: ${describeFeatures(model.features)}`);
  if (story) {
    log(`story: ${story.length}s${story.loop ? ", loops" : ""}, ${story.phases.length} phases, ${story.steps.length} steps`);
    warnings.push(...storyWarnings(model, story));
  }
  const marks = (story?.steps || []).flatMap((step) => [{ at: step.at - 0.1, label: "before", step }, { at: step.at + 3, label: "  +3s ", step }]).sort((a, b) => a.at - b.at);
  const samples = [];
  const lines = [];
  const progress = [];
  const lagAt = [];
  const tableRates = () => {
    const totals = { stale: 0, conflicts: 0, lost: 0 };
    for (const node of sim.nodes.values()) {
      // Operation counters are node-wide: count each database once, not once per table.
      const table = sim.tablesOf(node.id)[0];
      if (table) for (const key of Object.keys(totals)) totals[key] += table[key];
    }
    return totals;
  };
  const totalLag = () => [...sim.logs.keys()].reduce((sum, id) => sum + sim.lagOf(id), 0);
  let next = 0;
  try {
    for (let i = 1; i <= seconds * 60; i++) {
      sim.step(1 / 60);
      const t = i / 60;
      if (i % 15 === 0) {
        const lat = sim.latencyOf();
        samples.push({ t, in: sim.totalIn(), p50: lat.count ? lat.p50 : null, p99: lat.count ? lat.p99 : null, failing: lat.failed / 3, dropped: [...sim.nodes.values()].reduce((sum, node) => sum + node.dropRate, 0), ...tableRates(), lag: totalLag() });
      }
      while (next < marks.length && t >= marks[next].at) {
        const mark = marks[next++];
        lines.push({ at: mark.at, text: `  ${t.toFixed(1).padStart(5)}s ${mark.label} ${describeStep(mark.step)}: ${sim.summary()}` });
      }
      if (i % 60 === 0) {
        const sec = i / 60;
        lagAt.push([...sim.logs.keys()].map((id) => sim.lagOf(id)));
        if (sec % Math.max(1, Math.floor(seconds / 6)) === 0) progress.push(`  t=${String(sec).padStart(3)}s  ${sim.summary()}`);
      }
    }
  } catch (error) {
    throw new Error(`simulation at ${sim.time.toFixed(2)}s: ${error.message}`, { cause: error });
  }
  if (story) reportStory(story, samples, lines, per, sim.logs.size > 0, [...sim.nodes.values()].some((node) => node.store), log, warnings);
  progress.forEach((line) => log(line));
  log(story ? `nodes at ${seconds}s:` : "nodes:");
  for (const node of model.nodes) {
    log(`  ${sim.statsOf(node.id)}`);
    for (const route of sim.routesOf(node.id)) if (route.rate > 0) log(`      ${route.name}  ${formatRate(route.rate, per)} · p50 ${formatMs(route.p50)} · p99 ${formatMs(route.p99)}${route.errors ? ` · ${formatRate(route.errors, per)} errors` : ""}`);
  }
  for (const c of sim.trafficOf()) log(`  traffic ${c.label}: ${c.rate.toFixed(1)}/s source emissions`);
  for (const d of sim.routingOf()) log(`  routing ${d.node} / ${d.rule} → ${d.to || "reject"}: ${d.count} ${d.outcome} (last ${sim.cfg.window}s)`);
  const colors = Object.values(spec.traffic || {}).map((c, i) => c.color || ["cyan", "blue", "violet", "magenta", "teal", "lime"][i % 6]);
  if (colors.length > 6 || new Set(colors).size < colors.length) warnings.push("traffic classes reuse colors; use labels and class filters to distinguish them");
  if (sim.entityState) {
    const counts = new Map();
    for (const h of sim.entityState.histories.values()) for (const e of h.events) counts.set(e.outcome,(counts.get(e.outcome)||0)+1);
    log(`  entity history (retained): ${[...counts].map(([k,v])=>`${k} ${v}`).join(' · ')}; ${sim.entityState.pending.size} pending calls`);
  }
  // An endpoint's calls ride edges: each must have one.
  for (const node of model.nodes) for (const [name, endpoint] of Object.entries(node.endpoints || {})) for (const call of endpoint.calls || [])
    if (!call.routing && !model.edges.some((edge) => edge.from === node.id && edge.to === call.to)) warnings.push(`endpoint ${name} on ${node.id} calls ${call.to}, but there is no edge ${node.id} → ${call.to}`);
  [...sim.logs.keys()].forEach((id, index) => {
    const mid = lagAt[Math.floor(lagAt.length / 2)]?.[index] ?? 0;
    const end = lagAt[lagAt.length - 1]?.[index] ?? 0;
    if (end > 40 && end > mid * 1.3) warnings.push(`${id}: lag keeps growing (${mid} → ${end}); its consumers are slower than its producers`);
  });
  // Drops onto something the story fails on purpose are the point, not a warning.
  const ids = new Set(model.nodes.map((node) => node.id));
  const failedByStory = new Set((story?.steps || []).flatMap((step) => [].concat(step.fail || [])).map((id) => {
    const target = targetOf(id, ids);
    return target.type === "broker" ? target.node : id;
  }));
  for (const edge of sim.edges) {
    if (edge.dropped && failedByStory.has(edge.to)) continue;
    if (edge.sent === 0 && !edge.flag && !edge.unless && edge.kind !== "config") warnings.push(`edge ${edge.from} → ${edge.to} never carried anything`);
    else if (edge.dropped) {
      const target = model.byId.get(edge.to);
      warnings.push(`edge ${edge.from} → ${edge.to}: ${edge.dropped} of ${edge.sent} dropped${target.capacity ? ` (${edge.to} admits ${target.capacity}/s; expected if you meant to show shedding)` : ""}`);
    }
  }
  if (!model.nodes.some((node) => node.emit || node.workload)) warnings.push("no node has `emit` or `workload`: nothing will move");
  warnings.push(...layoutWarnings(model));
  if (warnings.length) {
    log("warnings:");
    for (const warning of warnings) log(`  ${warning}`);
  } else log("check passed");
  return { model, sim, warnings };
}

// One request on `endpoint` followed end to end, as text: each span indented under the call
// that made it, with its model-time duration and a bar drawn to scale.
export function traceText(spec, endpoint, { featureLayers = [], warmup = 5 } = {}) {
  spec = figureOf(spec);
  const model = modelOf(spec, featureLayers);
  const sim = createSim(simSpec(model));
  sim.quiet = true;
  for (let i = 0; i < warmup * 60; i++) sim.step(1 / 60);
  sim.follow(endpoint);
  let after = 0;
  for (let i = 0; i < 60 * 60 && after < 90; i++) {
    sim.step(1 / 60);
    if (sim.tracing.truncated || (sim.tracing.done && (!sim.trafficState || !sim.tracePending()))) after++;
  }
  const { spans } = sim.tracing;
  if (!spans.length) return [`no request on ${endpoint || "any route"} started within a minute`];
  const label = (id) => model.byId.get(id)?.label || id;
  const total = Math.max(...spans.map((s) => (s.start || 0) + (s.total || 0)), 0.001);
  const width = 28;
  const depth = (s) => (s.parent == null ? 0 : depth(spans[s.parent]) + 1);
  const order = [];
  const walk = (parent) => spans.filter((s) => s.parent === parent).forEach((s) => (order.push(s), walk(s.id)));
  walk(null);
  const lines = [`${spans[0].label || endpoint || "request"}: ${formatMs(spans[0].total ?? 0)}${spans[0].ok === false ? " (failed)" : ""}`];
  if (sim.trafficState) lines.push(`  traffic: ${spans[0].traffic || "unclassified"} · context: ${JSON.stringify(spans[0].context)}${sim.tracing.truncated ? " · truncated" : sim.tracePending() ? " · pending" : ""}`);
  for (const s of order) {
    const from = Math.round(((s.start || 0) / total) * width);
    const len = Math.max(1, Math.round(((s.total || 0) / total) * width));
    const bar = " ".repeat(from) + "█".repeat(len);
    const name = `${"  ".repeat(depth(s))}${label(s.node)}${s.label && s.parent != null ? `  ${s.label}` : ""}${s.async ? "  (async)" : ""}`;
    lines.push(`  ${name.padEnd(46)} ${(s.done ? formatMs(s.total) : "…").padStart(7)}  ${bar}`);
    for (const d of s.decisions || []) lines.push(`    ${d.rule} → ${d.to || "reject"}: ${d.outcome} · ${JSON.stringify(d.observations)}`);
  }
  return lines;
}

function storyWarnings(model, story) {
  const warnings = [];
  const ids = new Set(model.nodes.map((node) => node.id));
  for (const step of story.steps) {
    for (const id of [].concat(step.fail || [], step.recover || [], Object.keys(step.set || {}))) {
      const target = targetOf(id, ids);
      const known = target.type === "edge" ? model.edges.some((edge) => edge.from === target.from && edge.to === target.to) : ids.has(target.type === "broker" ? target.node : id);
      if (!known) warnings.push(`scenario step at ${step.at}s names unknown node or edge "${id}"`);
    }
    if (step.at > story.length) warnings.push(`scenario step at ${step.at}s is past the story's length (${story.length}s)`);
  }
  return warnings;
}

function reportStory(story, samples, lines, per, hasLogs, hasTables, log, warnings) {
  const phases = story.phases.length ? story.phases : [{ name: "story", at: 0, end: story.length }];
  const within = (from, to) => samples.filter((s) => s.t > from && s.t <= to);
  const mean = (list, key) => {
    const values = list.map((s) => s[key]).filter((n) => n != null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const ms = (n) => (n == null ? "—" : formatMs(n));
  for (const phase of phases) {
    const window = within(Math.max(phase.at, phase.end - 3), phase.end);
    log(`phase ${phase.name} (${phase.at}–${phase.end}s): ${formatRate(mean(window, "in"), per)} in · p50 ${ms(mean(window, "p50"))} · p99 ${ms(mean(window, "p99"))}${hasLogs ? ` · lag ${formatCount(mean(window, "lag"), per)}` : ""} · ${formatRate(mean(window, "failing"), per)} failing · ${formatRate(mean(window, "dropped"), per)} dropped${hasTables ? ` · ${formatRate(mean(window, "stale"), per)} stale reads · ${formatRate(mean(window, "conflicts"), per)} conflicts · ${formatRate(mean(window, "lost"), per)} lost updates` : ""}`);
    for (const line of lines) if (line.at >= phase.at - 0.2 && line.at < phase.end - 0.2) log(line.text);
  }
  // Compare the story's last second with the first phase's settled state.
  if (!story.loop) return;
  const settled = within(Math.max(phases[0].at + 1, phases[0].end - 3), phases[0].end);
  const tail = within(story.length - 1, story.length);
  if (!tail.length) return;
  const [lag0, lag1] = [mean(settled, "lag") ?? 0, mean(tail, "lag") ?? 0];
  const [fail0, fail1] = [mean(settled, "failing") ?? 0, mean(tail, "failing") ?? 0];
  if (lag1 > Math.max(20, lag0 * 3)) warnings.push(`the story ends with lag ${formatCount(lag1, per)} (it settled near ${formatCount(lag0, per)}); it will jump when it loops`);
  if (fail1 > Math.max(0.5, fail0 * 1.5)) warnings.push(`the story ends failing ${formatRate(fail1, per)} (it settled near ${formatRate(fail0, per)}); it will jump when it loops`);
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
  // Text: the same placement the figure draws (kit/labels.mjs via labelPlanOf), in both views.
  const nameOf = (id) => model.byId.get(id)?.label ?? id;
  const edgeName = (index) => `${model.edges[index].from} → ${model.edges[index].to}`;
  for (const view of ["iso", "flat"]) {
    const where = view === "iso" ? "in iso" : "in 2D";
    const { P, width, height } = projectionOf(model, view);
    const plan = labelPlanOf(model, view, P, width, height);
    for (const node of model.nodes) {
      const spot = plan.nodes.get(node.id);
      if (spot.hiddenBy.length && spot.blockers.some((b) => b.type === "hidden")) warnings.push(`label "${node.label}" is hidden behind ${spot.hiddenBy.join(", ")} ${where}; space the rows (\`grid\`) or move a node`);
      for (const b of spot.blockers) {
        if (b.type === "node") warnings.push(`label "${node.label}" overlaps ${b.id} ${where}; space the columns (\`grid\`), move a node or shorten the label`);
        if (b.type === "label") warnings.push(`label "${node.label}" overlaps ${b.id.startsWith("g:") ? `the ${b.id.slice(2)} plate's label` : `label "${nameOf(b.id.slice(2))}"`} ${where}; space the columns (\`grid\`) or shorten one`);
        if (b.type === "outside") warnings.push(`label "${node.label}" runs off the card ${where}`);
      }
    }
    for (const [index, spot] of plan.edges) if (spot.crowded) {
      const text = model.edges[index].label;
      warnings.push(`${text ? `edge label "${text}"` : "the rate label"} on ${edgeName(index)} has no clear spot ${where}; it shows only while the edge is in focus`);
    }
  }
  for (const node of model.nodes) if (node.labelShortened) warnings.push(`label "${node.label}" is shortened to "${node.labelLines.join(" / ")}"; keep \`label\` to a name and put the rest in \`detail\``);
  return warnings;
}
