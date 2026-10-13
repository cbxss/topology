// Follow one request: level 3 of the disclosure ladder. Inlined after topo-inspect.js when
// the `trace` feature is on. The next request on a route is picked; time slows to a quarter;
// its packets and path stay lit while everything else dims; and a timeline under the card
// lists each step, indented under the call that made it, with its model-time duration.
const tracer = (() => {
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const labelOf = (id) => DATA.spec.nodes.find((node) => node.id === id)?.label || id;
  const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : n >= 10 ? `${n.toFixed(0)}ms` : `${n.toFixed(1)}ms`);
  const panel = document.createElement("section");
  panel.className = "tp-trace";
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `<header><span class="tp-ins-kind">following</span><strong class="tp-tr-name"></strong><span class="tp-tr-stat"></span><button type="button" class="tp-tr-again">Another</button><button type="button" class="tp-ins-close" aria-label="Stop following">×</button></header><div class="tp-tr-body"></div>`;
  stage.after(panel);
  let endpoint = null;
  let active = false;
  let lingering = 0;

  function follow(route) {
    inspector.close();
    endpoint = route || null;
    sim.follow(endpoint, trafficDisplay?.selected);
    active = true;
    lingering = 0;
    timeScale = 0.25;
    stage.setAttribute("data-tracing", "");
    panel.hidden = false;
    render();
  }
  function stop() {
    if (!active && panel.hidden) return;
    active = false;
    sim.unfollow();
    timeScale = 1;
    panel.hidden = true;
    stage.removeAttribute("data-tracing");
    for (const v of viewList) {
      for (const el of v.nodes.values()) el.removeAttribute("data-traced");
      v.edges.forEach((el) => el.removeAttribute("data-traced"));
    }
  }

  function render() {
    const t = sim.tracing;
    if (!t) return;
    const spans = t.spans;
    const root = spans[0];
    panel.querySelector(".tp-tr-name").textContent = t.endpoint || endpoint || "a request";
    panel.querySelector(".tp-tr-stat").textContent = !root ? "waiting for the next one…" : t.done ? `${ms(root.total)}${root.ok === false ? " · failed" : ""}` : "in flight…";
    if (sim.trafficState && root) panel.querySelector(".tp-tr-stat").textContent += t.truncated ? " · truncated (256 spans / 60s limit)" : sim.tracePending() ? (t.done ? " · async pending" : "") : " · journey complete";
    // Light the path: every node with a span, and the edges between parent and child spans.
    const nodes = new Set(spans.map((s) => s.node));
    const edges = new Set();
    for (const s of spans) if (s.parent != null) {
      const from = spans[s.parent]?.node;
      const index = DATA.spec.edges.findIndex((e) => e.from === from && e.to === s.node);
      if (index >= 0) edges.add(index);
    }
    for (const v of viewList) {
      for (const [id, el] of v.nodes) el.toggleAttribute("data-traced", nodes.has(id));
      v.edges.forEach((el, index) => el.toggleAttribute("data-traced", edges.has(index)));
    }
    if (!root) return void (panel.querySelector(".tp-tr-body").innerHTML = "");
    const total = Math.max(...spans.map((s) => (s.start || 0) + (s.total || 0)), root.total || 0, 0.001);
    const order = [];
    const depth = new Map();
    const walk = (parent, d) => spans.filter((s) => s.parent === parent).forEach((s) => (order.push(s), depth.set(s.id, d), walk(s.id, d + 1)));
    walk(null, 0);
    panel.querySelector(".tp-tr-body").innerHTML = (root.context ? `<div class="tp-tr-context">${esc(DATA.traffic?.[root.traffic]?.label || root.traffic || "Unclassified")} · ${esc(JSON.stringify(root.context))}</div>` : "") + order
      .map((s) => {
        const left = ((s.start || 0) / total) * 100;
        const width = s.done ? Math.max(0.8, ((s.total || 0) / total) * 100) : 0.8;
        return `<div class="tp-span"${s.ok === false ? " data-bad" : ""}${s.done ? "" : " data-open"}><span class="tp-span-name" style="padding-left:${depth.get(s.id) * 12}px">${esc(labelOf(s.node))}${s.label && s.parent != null ? ` <small>${esc(s.label)}</small>` : ""}${s.async ? " <small>async</small>" : ""}</span><span class="tp-span-ms">${s.done ? ms(s.total) : "…"}</span><span class="tp-span-bar"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i></span></div>${(s.decisions || []).map(d => `<div class="tp-decision">${esc(d.rule)} → ${esc(d.to || "reject")} · ${esc(d.outcome)}${d.observations.map(o => `<br>${esc(o.field)}: ${o.exists ? esc(JSON.stringify(o.value)) : "missing"} · ${esc(o.op)} ${esc(JSON.stringify(o.expected))} → ${o.result}`).join("")}</div>`).join("")}`;
      })
      .join("");
  }

  let clock = 0;
  hooks.tick.push((dt) => {
    if (!active) return;
    clock += dt;
    if (clock < 0.12) return;
    clock = 0;
    render();
    // Once the request has answered and its async steps have landed, return to normal speed
    // but keep the timeline up until the reader closes it.
    const t = sim.tracing;
    if (t?.truncated || (t?.done && t.spans.every((s) => s.done) && (!sim.trafficState || !sim.tracePending()))) {
      lingering += 0.12;
      if (lingering > 0.6) {
        timeScale = 1;
        active = false;
      }
    }
  });
  hooks.key.push((event) => {
    if (event.key === "Escape" && !panel.hidden) {
      stop();
      return true;
    }
    if ((event.key === "t" || event.key === "T") && focus) {
      follow(sim.routesOf(focus)[0]?.name);
      return true;
    }
    return false;
  });
  hooks.select.push(() => !panel.hidden && stop());
  panel.querySelector(".tp-ins-close").addEventListener("click", stop);
  panel.querySelector(".tp-tr-again").addEventListener("click", () => follow(endpoint));
  window.__topo.tracer = { follow, stop, get active() { return active; } };
  return { follow, stop, get active() { return active; } };
})();
