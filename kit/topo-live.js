// The live page. Inlined after topo-sim.mjs (exports stripped) and `const DATA = …`.
// It steps the sim, draws its packets into the visible view and writes attributes:
// it never re-renders markup per frame.
const stage = document.querySelector(".tp-stage");
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let sim = createSim(DATA.spec);
// Extension points for topo-story.js and topo-edit.js.
const hooks = { tick: [], takeover: [], key: [] };
let paused = false;
const SLOTS = DATA.slots;
const lens = DATA.lens;
const POOL_MAX = 420;
const NS = "http://www.w3.org/2000/svg";

const views = {};
for (const name of ["iso", "flat"]) {
  const svg = stage.querySelector(`.tp-${name}`);
  const v = { name, svg, data: DATA.views[name], layer: svg.querySelector("[data-packets]"), pool: [], leds: new Map(), cells: new Map(), cursors: [], nodes: new Map(), edges: [], labels: new Map(), cellState: new Map(), breakers: new Map(), elabels: new Map(), qcells: new Map(), knobs: new Map(), lanes: new Map(), brokers: new Map(), status: new Map() };
  const all = (selector, fn) => svg.querySelectorAll(selector).forEach(fn);
  all("[data-breaker]", (el) => v.breakers.set(+el.dataset.breaker, el));
  all("[data-elabel]", (el) => v.elabels.set(+el.dataset.elabel, { el, text: el.querySelector("text") }));
  all("[data-qcell]", (el) => v.qcells.set(el.dataset.qcell, el));
  all("[data-flag]", (el) => v.knobs.set(el.dataset.flag, el));
  all("[data-lane]", (el) => v.lanes.set(el.dataset.lane, el));
  all("[data-part^='broker:']", (el) => v.brokers.set(`${el.closest("[data-node]").dataset.node}:${el.dataset.part.slice(7)}`, el));
  svg.querySelectorAll("[data-led]").forEach((el) => v.leds.set(el.dataset.led, el));
  svg.querySelectorAll("[data-cell]").forEach((el) => v.cells.set(el.dataset.cell, el));
  svg.querySelectorAll("[data-cursor]").forEach((el) => {
    const [id, g, p] = el.dataset.cursor.split(":");
    v.cursors.push({ el, id, g: +g, p: +p, at: -1 });
  });
  svg.querySelectorAll("[data-node]").forEach((el) => v.nodes.set(el.dataset.node, el));
  svg.querySelectorAll("[data-edge]").forEach((el) => (v.edges[+el.dataset.edge] = el));
  svg.querySelectorAll("[data-label]").forEach((el) => v.labels.set(el.dataset.label, el));
  views[name] = v;
}
let view = DATA.view;

function packetEl(v) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "tp-pk");
  if (v.data.packet) {
    const { sides, top, outline } = v.data.packet;
    g.innerHTML = `<path class="pk-trail"/><path class="pk-side" d="${sides}"/><path class="pk-top" d="${top}"/><path class="pk-edge" d="${outline}"/>`;
  } else {
    g.innerHTML = `<path class="pk-trail"/><circle r="1.9"/>`;
  }
  g.style.display = "none";
  v.layer.appendChild(g);
  return { g, trail: g.firstChild, kind: "", shown: false, tail: "" };
}

function pointOn(v, packet, back = 0) {
  const pts = v.data.edges[packet.edge];
  const L = lens[packet.edge];
  const total = L[L.length - 1];
  // `back` world units behind the packet, for its trail.
  const t = Math.min(1, Math.max(0, packet.dir > 0 ? packet.t - back / total : 1 - packet.t + back / total));
  const want = t * total;
  let i = 1;
  while (i < L.length - 1 && L[i] < want) i++;
  const span = L[i] - L[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (want - L[i - 1]) / span));
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
}

function drawPackets() {
  if (morphing) return;
  const v = views[view];
  const list = still.matches ? [] : sim.packets;
  const count = Math.min(list.length, POOL_MAX);
  // Dense traffic reads as flow: past 40 packets each one draws a short tail.
  const trails = DATA.features.trails && count > 40;
  while (v.pool.length < count) v.pool.push(packetEl(v));
  for (let i = 0; i < v.pool.length; i++) {
    const slot = v.pool[i];
    if (i >= count) {
      if (slot.shown) {
        slot.g.style.display = "none";
        slot.shown = false;
      }
      continue;
    }
    const packet = list[i];
    const [x, y] = pointOn(v, packet);
    if (!slot.shown) {
      slot.g.style.display = "";
      slot.shown = true;
    }
    if (slot.kind !== packet.kind) {
      slot.g.dataset.kind = packet.kind;
      slot.kind = packet.kind;
    }
    const fade = packet.kind === "drop" ? Math.max(0, 1 - packet.age / 0.6) : 1;
    const grow = packet.kind === "drop" ? 1 + packet.age * 1.4 : 1;
    slot.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})${grow !== 1 ? ` scale(${grow.toFixed(2)})` : ""}`);
    let tail = "";
    if (trails && packet.kind !== "drop") {
      const [tx, ty] = pointOn(v, packet, 11);
      tail = `M0 0L${(tx - x).toFixed(1)} ${(ty - y).toFixed(1)}`;
    }
    if (tail !== slot.tail) {
      slot.tail = tail;
      slot.trail.setAttribute("d", tail);
    }
    slot.g.style.opacity = fade < 1 ? fade.toFixed(2) : "";
  }
}

// LEDs blink when a node handles a message.
const lit = new Map();
function ledFor(event) {
  const node = sim.nodes.get(event.node);
  if (node.kind === "kafka" || node.kind === "queue") return `${event.node}:b${node.handled % (node.brokers || 3)}`;
  if (node.kind === "service" || node.kind === "worker") return `${event.node}:${event.replica}`;
  return `${event.node}:0`;
}
function events(now) {
  for (const event of sim.events) {
    if (event.type === "handle") {
      const id = ledFor(event);
      for (const v of Object.values(views)) {
        const el = v.leds.get(id);
        if (el) {
          el.setAttribute("data-on", "");
          lit.set(el, now + 90);
        }
      }
    } else if (event.type === "flag") {
      const panel = DATA.spec.nodes.find((node) => node.kind === "flags");
      if (panel) for (const v of Object.values(views)) {
        const el = v.leds.get(`${panel.id}:0`);
        if (el) {
          el.setAttribute("data-on", "");
          lit.set(el, now + 600);
        }
      }
    } else if (event.type === "fail" || event.type === "recover") {
      for (const v of Object.values(views)) v.nodes.get(event.node)?.toggleAttribute("data-down", event.type === "fail");
    }
  }
  sim.events.length = 0;
  for (const [el, until] of lit) if (now >= until) {
    el.removeAttribute("data-on");
    lit.delete(el);
  }
}

// Record cells show the last SLOTS offsets of each partition; a cell is bright while the
// first consumer group hasn't committed it. Cursors sit at each group's committed offset.
function drawLogs() {
  const v = views[view];
  for (const [id, log] of sim.logs) {
    for (let p = 0; p < log.partitions; p++) {
      const end = log.end[p];
      const base = end - SLOTS;
      const c0 = log.groups[0] ? log.groups[0].committed[p] : end;
      for (let i = 0; i < SLOTS; i++) {
        const key = `${id}:${p}:${i}`;
        const off = base + i;
        const on = off >= 0 && off >= c0;
        if (v.cellState.get(key) === on) continue;
        v.cellState.set(key, on);
        v.cells.get(key)?.toggleAttribute("data-on", on);
      }
    }
  }
  for (const cursor of v.cursors) {
    const log = sim.logs.get(cursor.id);
    const group = log?.groups[cursor.g];
    if (!group) continue;
    const base = log.end[cursor.p] - SLOTS;
    const s = Math.max(0, Math.min(SLOTS, group.committed[cursor.p] - base));
    if (s === cursor.at) continue;
    cursor.at = s;
    cursor.el.setAttribute("transform", `translate(${(v.data.step[0] * s).toFixed(2)} ${(v.data.step[1] * s).toFixed(2)})`);
  }
}

// Everything else that shows state, at 4 Hz: breakers, edge labels, buffers, flag switches,
// paused partitions and failed brokers. Attributes are only written when they change.
const setOnce = (v, key, el, attr, value) => {
  if (v.status.get(key) === value) return;
  v.status.set(key, value);
  if (attr === "text") el.textContent = value;
  else if (attr === "transform") el.setAttribute("transform", value);
  else if (value === false || value == null) el.removeAttribute(attr);
  else el.setAttribute(attr, value === true ? "" : value);
};
function drawStatus() {
  const v = views[view];
  const per = sim.cfg.per;
  for (const [index, el] of v.breakers) {
    const state = sim.edges[index].breaker?.state || "closed";
    setOnce(v, `br${index}`, el, "data-state", state);
    setOnce(v, `bre${index}`, v.edges[index], "data-breaker", state === "closed" ? false : state);
  }
  for (const [index, { el, text }] of v.elabels) {
    const edge = sim.edges[index];
    const bits = [];
    if (edge.label) bits.push(edge.label);
    else if (DATA.labels === "rate") bits.push(formatRate(edge.flow, per));
    const flagName = edge.flag || edge.unless;
    const flag = flagName && sim.flags.get(flagName);
    if (flag) bits.push(`${edge.unless ? "¬" : ""}${flagName} ${Math.round((edge.unless ? 1 - flag.effective : flag.effective) * 100)}%`);
    const bad = edge.flow > 0.3 && edge.errorRate / edge.flow > 0.1;
    if (bad) bits.push(`${Math.round((100 * edge.errorRate) / edge.flow)}% err`);
    setOnce(v, `el${index}`, text, "text", bits.join(" · "));
    setOnce(v, `elb${index}`, el, "data-bad", bad);
  }
  for (const [key, el] of v.qcells) {
    const [id, i] = key.split(":");
    const node = sim.nodes.get(id);
    const n = Math.min(8, node.queueMax || 1);
    setOnce(v, `q${key}`, el, "data-on", node.waiting.length > 0 && +i < Math.ceil((node.waiting.length / Math.max(1, node.queueMax)) * n));
  }
  for (const [name, el] of v.knobs) {
    const flag = sim.flags.get(name);
    const f = flag ? flag.effective : 0;
    setOnce(v, `k${name}`, el, "transform", `translate(${(v.data.flagStep[0] * f).toFixed(2)} ${(v.data.flagStep[1] * f).toFixed(2)})`);
  }
  for (const [key, el] of v.lanes) {
    const [id, p] = key.split(":");
    const log = sim.logs.get(id);
    setOnce(v, `l${key}`, el, "data-paused", !!log && !sim.readable(log, +p));
  }
  for (const [key, el] of v.brokers) {
    const [id, b] = key.split(":");
    setOnce(v, `b${key}`, el, "data-down", !sim.logs.get(id).brokers[+b]);
  }
}

// Focus: hover or keyboard picks a node; its links and neighbours stay lit.
let focus = null;
let pinned = false;
const neighbours = (id) => {
  const near = new Set([id]);
  const edges = new Set();
  DATA.spec.edges.forEach((edge, index) => {
    if (edge.from === id || edge.to === id) {
      near.add(edge.from);
      near.add(edge.to);
      edges.add(index);
    }
  });
  return { near, edges };
};
function setFocus(id) {
  focus = id;
  const { near, edges } = id ? neighbours(id) : { near: new Set(), edges: new Set() };
  stage.toggleAttribute("data-focus", !!id);
  for (const v of Object.values(views)) {
    for (const [nid, el] of v.nodes) {
      el.toggleAttribute("data-near", near.has(nid));
      el.toggleAttribute("data-sel", nid === id);
    }
    for (const [nid, el] of v.labels) el.toggleAttribute("data-near", near.has(nid));
    v.edges.forEach((el, index) => el.toggleAttribute("data-near", edges.has(index)));
  }
  say(true);
}

// The readout corner: optional sparkline of flow over the last 30 s, then the text.
let readoutText = readout;
let spark = null;
if (readout && DATA.features.sparkline) {
  readout.innerHTML = `<svg class="tp-spark" viewBox="0 0 64 12" aria-hidden="true"><polyline/></svg><span class="tp-readout-text"></span>`;
  spark = readout.querySelector("polyline");
  readoutText = readout.querySelector(".tp-readout-text");
}
function drawSpark() {
  if (!spark) return;
  const hist = focus ? sim.nodes.get(focus)?.hist || [] : sim.hist;
  const top = Math.max(1e-6, ...hist);
  const n = hist.length;
  spark.setAttribute("points", hist.map((value, i) => `${(64 - (n - 1 - i) * (64 / 119)).toFixed(1)},${(11 - (value / top) * 10).toFixed(1)}`).join(" "));
}
let lastSay = 0;
function say(force, now = performance.now()) {
  if (!force && now - lastSay < 250) return;
  lastSay = now;
  const text = focus ? sim.statsOf(focus) : sim.summary();
  if (readoutText && readoutText.textContent !== text) readoutText.textContent = text;
  drawSpark();
  stage.setAttribute("aria-valuetext", text);
}

// Switching views: with the morph feature, the iso camera swings up to look straight down
// (re-rendering the scene each frame), then crossfades into the 2D glyphs; and the reverse.
const CAMERAS = { iso: { azimuth: 56, elevation: 32 }, flat: { azimuth: 90, elevation: 90 } };
let morphing = false;
let morphModel = null;
function setView(name) {
  if (!views[name] || name === view || morphing) return;
  if (DATA.features.morph && typeof TOPO !== "undefined" && DATA.raw && !still.matches) return morphTo(name);
  swap(name);
}

function morphTo(name) {
  morphing = true;
  if (!morphModel) {
    morphModel = TOPO.prepare(DATA.raw);
    morphModel.features = DATA.features;
    if (DATA.features.hops) TOPO.applyHops(morphModel);
    TOPO.renderView(morphModel, "iso");
    morphModel.fastLabels = true;
  }
  const holder = document.createElement("div");
  holder.className = "tp-morph";
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const camera = (t) => {
    const [a, b] = name === "flat" ? [CAMERAS.iso, CAMERAS.flat] : [CAMERAS.flat, CAMERAS.iso];
    const e = ease(t);
    return { azimuth: a.azimuth + (b.azimuth - a.azimuth) * e, elevation: a.elevation + (b.elevation - a.elevation) * e };
  };
  const frame = (t) => (holder.innerHTML = TOPO.renderView(morphModel, "iso", 640, camera(t)).svg);
  const fade = (el, from, to, ms) => el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: "ease-out", fill: "forwards" }).finished;
  frame(0);
  views[view].pool.forEach((slot) => {
    slot.g.style.display = "none";
    slot.shown = false;
  });
  const leaving = views[view].svg;
  stage.appendChild(holder);
  if (name === "flat") leaving.setAttribute("hidden", "");
  const run = (start) => {
    const step = (now) => {
      const t = Math.min(1, (now - start) / 650);
      frame(t);
      if (t < 1) return requestAnimationFrame(step);
      swap(name);
      const arriving = views[name].svg;
      if (name === "flat") {
        // The top-down iso frame and the 2D glyphs share one layout: crossfade between them.
        holder.style.position = "absolute";
        holder.style.inset = "0";
        fade(arriving, 0, 1, 220);
        fade(holder, 1, 0, 220).then(() => holder.remove()).then(() => (morphing = false));
      } else {
        holder.remove();
        morphing = false;
      }
    };
    requestAnimationFrame(step);
  };
  if (name === "iso") {
    // Fade the top-down frame in over the 2D view, then take its place.
    holder.style.position = "absolute";
    holder.style.inset = "0";
    fade(holder, 0, 1, 180).then(() => {
      leaving.setAttribute("hidden", "");
      holder.style.position = "";
      holder.style.inset = "";
      run(performance.now());
    });
  }
  else run(performance.now());
}

function swap(name) {
  views[view].svg.setAttribute("hidden", "");
  views[view].pool.forEach((slot) => {
    slot.g.style.display = "none";
    slot.shown = false;
  });
  view = name;
  views[view].svg.removeAttribute("hidden");
  views[view].cellState.clear();
  views[view].cursors.forEach((cursor) => (cursor.at = -1));
  views[view].status.clear();
  document.querySelectorAll(".tp-views button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === name)));
  drawLogs();
  drawPackets();
}

let frame = 0;
let last = 0;
let visible = false;
let logClock = 0;
let statusClock = 0;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
  last = now;
  if (!paused) sim.step(dt * (window.__topoSpeed ?? 1));
  events(now);
  for (const hook of hooks.tick) hook(dt);
  logClock += dt;
  statusClock += dt;
  if (logClock > 0.05) {
    logClock = 0;
    drawLogs();
  }
  if (statusClock > 0.25) {
    statusClock = 0;
    drawStatus();
  }
  drawPackets();
  say(false, now);
  frame = visible ? requestAnimationFrame(tick) : 0;
}
const run = () => {
  if (!frame && visible) {
    last = 0;
    frame = requestAnimationFrame(tick);
  }
};
new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  run();
}, { rootMargin: "120px 0px" }).observe(stage);

const nodeAt = (target) => target.closest?.("[data-node]")?.dataset.node;
const toggle = (id) => {
  for (const hook of hooks.takeover) hook(id);
  const node = sim.nodes.get(id);
  if (node) sim.setUp(id, !node.up);
  say(true);
};
stage.addEventListener("pointerover", (event) => {
  const id = nodeAt(event.target);
  if (id && id !== focus) {
    pinned = false;
    setFocus(id);
  }
});
stage.addEventListener("pointerleave", () => {
  if (!pinned) setFocus(null);
});
stage.addEventListener("click", (event) => {
  const part = event.target.closest?.("[data-part^='broker:']");
  const id = nodeAt(event.target);
  if (part && id) {
    const b = +part.dataset.part.slice(7);
    for (const hook of hooks.takeover) hook(id);
    sim.setBroker(id, b, !sim.logs.get(id).brokers[b]);
    drawStatus();
    say(true);
  } else if (id) toggle(id);
});
const ring = [...DATA.spec.nodes].map((node) => node.id);
stage.addEventListener("keydown", (event) => {
  const here = focus ? ring.indexOf(focus) : -1;
  if (hooks.key.some((hook) => hook(event))) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    pinned = true;
    setFocus(ring[(here + 1) % ring.length]);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    pinned = true;
    setFocus(ring[(here - 1 + ring.length) % ring.length]);
  } else if ((event.key === "Enter" || event.key === " ") && focus) {
    toggle(focus);
  } else if (event.key === "v" || event.key === "V") {
    setView(view === "iso" ? "flat" : "iso");
  } else if (event.key === "Escape") {
    pinned = false;
    setFocus(null);
  } else return;
  event.preventDefault();
});
document.querySelectorAll(".tp-views button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

// Swap in another sim (a scrub re-simulates from 0) and bring every attribute up to date.
function resetVisuals(next) {
  sim = next;
  for (const v of Object.values(views)) {
    v.pool.forEach((slot) => {
      slot.g.style.display = "none";
      slot.shown = false;
    });
    v.cellState.clear();
    v.cursors.forEach((cursor) => (cursor.at = -1));
    v.status.clear();
    for (const [id, el] of v.nodes) el.toggleAttribute("data-down", !sim.nodes.get(id).up);
  }
  for (const el of lit.keys()) el.removeAttribute("data-on");
  lit.clear();
  sim.events.length = 0;
  drawLogs();
  drawStatus();
  drawPackets();
  say(true);
}

window.__topo = { get sim() { return sim; }, setView, setFocus, toggle, resetVisuals, data: DATA, get kit() { return typeof TOPO !== "undefined" ? TOPO : null; }, get view() { return view; }, get morphing() { return morphing; } };
drawLogs();
drawStatus();
say(true);
