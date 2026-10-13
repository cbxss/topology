// The live page. Inlined after topo-sim.mjs (exports stripped) and `const DATA = …`.
// It steps the sim, draws its packets into the visible view and writes attributes:
// it never re-renders markup per frame.
const stage = document.querySelector(".tp-stage");
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const sim = createSim(DATA.spec);
const SLOTS = DATA.slots;
const lens = DATA.lens;
const POOL_MAX = 420;
const NS = "http://www.w3.org/2000/svg";

const views = {};
for (const name of ["iso", "flat"]) {
  const svg = stage.querySelector(`.tp-${name}`);
  const v = { name, svg, data: DATA.views[name], layer: svg.querySelector("[data-packets]"), pool: [], leds: new Map(), cells: new Map(), cursors: [], nodes: new Map(), edges: [], labels: new Map(), cellState: new Map() };
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
    g.innerHTML = `<path class="pk-side" d="${sides}"/><path class="pk-top" d="${top}"/><path class="pk-edge" d="${outline}"/>`;
  } else {
    g.innerHTML = `<circle r="1.9"/>`;
  }
  g.style.display = "none";
  v.layer.appendChild(g);
  return { g, kind: "", shown: false };
}

function pointOn(v, packet) {
  const pts = v.data.edges[packet.edge];
  const L = lens[packet.edge];
  const total = L[L.length - 1];
  const t = Math.min(1, Math.max(0, packet.dir > 0 ? packet.t : 1 - packet.t));
  const want = t * total;
  let i = 1;
  while (i < L.length - 1 && L[i] < want) i++;
  const span = L[i] - L[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (want - L[i - 1]) / span));
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
}

function drawPackets() {
  const v = views[view];
  const list = still.matches ? [] : sim.packets;
  const count = Math.min(list.length, POOL_MAX);
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
    slot.g.style.opacity = fade < 1 ? fade.toFixed(2) : "";
  }
}

// LEDs blink when a node handles a message.
const lit = new Map();
function ledFor(event) {
  const node = sim.nodes.get(event.node);
  if (node.kind === "kafka" || node.kind === "queue") return `${event.node}:b${node.handled % 3}`;
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

let lastSay = 0;
function say(force, now = performance.now()) {
  if (!force && now - lastSay < 250) return;
  lastSay = now;
  const text = focus ? sim.statsOf(focus) : sim.summary();
  if (readout && readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuetext", text);
}

function setView(name) {
  if (!views[name] || name === view) return;
  views[view].svg.setAttribute("hidden", "");
  views[view].pool.forEach((slot) => {
    slot.g.style.display = "none";
    slot.shown = false;
  });
  view = name;
  views[view].svg.removeAttribute("hidden");
  views[view].cellState.clear();
  views[view].cursors.forEach((cursor) => (cursor.at = -1));
  document.querySelectorAll(".tp-views button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === name)));
  drawLogs();
  drawPackets();
}

let frame = 0;
let last = 0;
let visible = false;
let logClock = 0;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
  last = now;
  sim.step(dt * (window.__topoSpeed ?? 1));
  events(now);
  logClock += dt;
  if (logClock > 0.05) {
    logClock = 0;
    drawLogs();
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
  const id = nodeAt(event.target);
  if (id) toggle(id);
});
const ring = [...DATA.spec.nodes].map((node) => node.id);
stage.addEventListener("keydown", (event) => {
  const here = focus ? ring.indexOf(focus) : -1;
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

window.__topo = { sim, setView, setFocus, toggle, get view() { return view; } };
drawLogs();
say(true);
