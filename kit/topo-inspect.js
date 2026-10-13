// The inspector: level 2 of the disclosure ladder. Inlined after topo-live.js. Clicking a
// node opens one panel under the stage for it: its numbers, a Fail/Restore button and, when
// the spec declares them, its routes, tables and record details. Hovering a node that
// has routes shows a compact card (level 1). Esc closes the panel; one panel at a time.
const inspector = (() => {
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const specOf = new Map(DATA.spec.nodes.map((node) => [node.id, node]));
  const per = () => sim.cfg.per;
  const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : n >= 10 ? `${n.toFixed(0)}ms` : `${n.toFixed(1)}ms`);
  const rate = (n) => formatRate(n, per());

  const panel = document.createElement("section");
  panel.className = "tp-inspect";
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `<header><span class="tp-ins-kind"></span><strong class="tp-ins-name"></strong><span class="tp-ins-stat"></span><button type="button" class="tp-ins-follow" hidden>Follow a request</button><button type="button" class="tp-ins-fail"></button><button type="button" class="tp-ins-close" aria-label="Close">×</button></header><div class="tp-ins-body"></div>`;
  stage.after(panel);
  const $ = (sel) => panel.querySelector(sel);
  const tip = document.createElement("div");
  tip.className = "tp-tip";
  tip.hidden = true;
  stage.appendChild(tip);

  let open = null;
  const written = new Map();
  const write = (key, el, html) => {
    if (written.get(key) === html) return;
    written.set(key, html);
    el.innerHTML = html;
  };

  // Sections, in order; each returns markup or "" for this node. Later milestones add more.
  const sections = [
    function routes(id) {
      const list = sim.routesOf(id);
      const declared = specOf.get(id)?.endpoints || {};
      if (!list.length && !Object.keys(declared).length) return "";
      const names = [...new Set([...list.map((r) => r.name), ...Object.keys(declared)])];
      const byName = new Map(list.map((r) => [r.name, r]));
      const rows = names.map((name) => {
        const r = byName.get(name) || { rate: 0, p50: 0, p99: 0, errors: 0, count: 0 };
        const calls = (declared[name]?.calls || []).map((c) => `${specOf.get(c.to)?.label || c.to}${c.op ? ` ${c.op}${c.table ? ` ${c.table}` : ""}` : ""}${c.p != null && c.p < 1 ? ` (${Math.round(c.p * 100)}%)` : ""}`).join(", ");
        return `<button type="button" class="tp-route" data-route="${esc(name)}"${routeFilter === name ? " data-on" : ""}><span class="tp-route-name">${esc(name)}${calls ? `<small>→ ${esc(calls)}</small>` : ""}</span><span>${rate(r.rate)}</span><span>${r.count ? ms(r.p50) : "—"}</span><span>${r.count ? ms(r.p99) : "—"}</span><span${r.errors ? " data-bad" : ""}>${r.errors ? rate(r.errors) : "·"}</span></button>`;
      });
      return `<div class="tp-routes"><div class="tp-route tp-route-head"><span>route</span><span>rate</span><span>p50</span><span>p99</span><span>errors</span></div>${rows.join("")}</div><p class="tp-ins-note">Pick a route to follow only its packets.</p>`;
    },
    function tables(id) {
      const list = sim.tablesOf(id);
      if (!list.length) return "";
      // Replicas of this primary, to show how far behind each one is.
      const replicas = DATA.spec.edges.filter((e) => e.from === id && e.kind === "replication").map((e) => e.to);
      return list
        .map((t) => {
          const bits = [`<b>${esc(t.name)}</b> ${t.count} rows`, t.primary ? `${rate(t.applied)} applied` : `${rate(t.writes)} writes`];
          if (t.inserts || t.updates) bits.push(`${rate(t.inserts)} inserts · ${rate(t.updates)} updates`);
          if (t.conflicts) bits.push(`<i>${rate(t.conflicts)} conflicts</i>`);
          if (t.stale) bits.push(`<em>${rate(t.stale)} stale reads</em>`);
          if (t.lost) bits.push(`<i>${rate(t.lost)} lost updates</i>`);
          if (t.lockWaits) bits.push(`${rate(t.lockWaits)} lock waits`);
          const field = (r) => Object.entries(r.fields).map(([name, value]) => `${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ");
          const rows = t.rows.map((r) => `<button type="button" class="tp-row" data-table="${esc(t.name)}" data-key="${esc(r.key)}" aria-label="Inspect ${esc(t.name)} ${esc(t.key)} ${esc(r.key)}"${r.age != null && r.age < 0.7 ? " data-fresh" : ""}${r.behind ? ` data-behind title="behind the primary"` : ""}><b>${esc(r.key)}</b><span>${r.version == null ? "gone" : `v${r.version}`}</span><span>${esc(field(r))}</span></button>`).join("");
          // WAL: the newest entries; amber ones haven't reached every replica yet.
          const shipped = replicas.length ? Math.min(...replicas.map((rid) => sim.tablesOf(rid).find((x) => x.name === t.name)?.wal.applied ?? 0)) : Infinity;
          const cells = t.wal.recent.map((e) => `<i title="lsn ${e.lsn} ${e.op} ${esc(e.key)} v${e.version}"${e.lsn > shipped ? " data-pending" : ""}></i>`).join("");
          const lagNotes = t.primary
            ? [`${t.behind} ${t.behind === 1 ? "entry" : "entries"} behind ${esc(specOf.get(t.primary)?.label || t.primary)}${specOf.get(id)?.lag ? ` (applies ${specOf.get(id).lag}s late)` : ""}`]
            : replicas.map((rid) => {
                const r = sim.tablesOf(rid).find((x) => x.name === t.name);
                return `${esc(specOf.get(rid)?.label || rid)} ${r ? r.behind : "?"} behind`;
              });
          return `<div class="tp-table"><div class="tp-table-head">${bits.join(" · ")}</div><div class="tp-rows">${rows || '<div class="tp-row"><span>no rows yet</span></div>'}</div>${cells ? `<div class="tp-wal"><span>WAL</span>${cells}</div>` : ""}<p class="tp-wal-note">lsn ${t.wal.lsn}${lagNotes.length ? ` · ${lagNotes.join(" · ")}` : ""}</p></div>`;
        })
        .join("");
    },
  ];

  function render() {
    if (!open) return;
    const node = sim.nodes.get(open);
    const spec = specOf.get(open);
    write("kind", $(".tp-ins-kind"), esc(spec.component || spec.kind));
    write("name", $(".tp-ins-name"), esc(spec.label || open));
    write("stat", $(".tp-ins-stat"), esc(sim.statsOf(open).replace(/^[^·]*·\s*/, "")));
    write("fail", $(".tp-ins-fail"), node.up ? "Fail" : "Restore");
    // Following needs requests through this node: offered once it has seen some.
    $(".tp-ins-follow").hidden = !(DATA.features.trace && typeof tracer !== "undefined" && (node.flow > 0 || node.emit));
    write("body", $(".tp-ins-body"), sections.map((section) => section(open)).join(""));
    panel.toggleAttribute("data-down", !node.up);
  }

  function show(id) {
    open = id;
    written.clear();
    panel.hidden = false;
    tip.hidden = true;
    render();
  }
  function close() {
    open = null;
    panel.hidden = true;
    routeFilter = null;
    recordFilter = null;
  }

  hooks.select.push((id) => (open === id ? close() : show(id)));
  hooks.key.push((event) => {
    if (event.key !== "Escape" || !open) return false;
    close();
    return true;
  });
  let clock = 0;
  hooks.tick.push((dt) => {
    clock += dt;
    if (clock < 0.25) return;
    clock = 0;
    render();
    if (!tip.hidden && focus) drawTip(focus);
  });
  $(".tp-ins-close").addEventListener("click", close);
  $(".tp-ins-follow").addEventListener("click", () => {
    const id = open;
    tracer.follow(routeFilter || sim.routesOf(id)[0]?.name);
  });
  $(".tp-ins-fail").addEventListener("click", () => {
    if (open) toggle(open);
    render();
  });
  panel.addEventListener("click", (event) => {
    const row = event.target.closest(".tp-route[data-route]");
    if (!row) return;
    recordFilter = null;
    routeFilter = routeFilter === row.dataset.route ? null : row.dataset.route;
    written.delete("body");
    render();
  });

  // Level 1: a compact card over a hovered node that has routes. Nothing for plain nodes.
  function drawTip(id) {
    const list = sim.routesOf(id).slice(0, 4);
    if (!list.length || open === id) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = list.map((r) => `<div><b>${esc(r.name)}</b> ${rate(r.rate)}${r.count ? ` · p99 ${ms(r.p99)}` : ""}${r.errors ? ` · <i>${rate(r.errors)} err</i>` : ""}</div>`).join("");
    const el = views[view].nodes.get(id);
    if (!el) return;
    const box = el.getBoundingClientRect();
    const host = stage.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(host.width - 220, box.left - host.left + box.width / 2 - 110))}px`;
    tip.style.top = `${Math.max(0, box.top - host.top - 8)}px`;
    tip.hidden = false;
  }
  hooks.focus.push((id) => (id ? drawTip(id) : (tip.hidden = true)));

  window.__topo.inspector = { show, close, get open() { return open; } };
  return { show, close, sections, render, get open() { return open; } };
})();
