const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

// Read-only projections and bounded reporting histories. No routing or RNG draws.
function attachReporting(sim) {
  const { cfg, nodes } = sim;
  // A database's tables for the inspector: recent rows, counts, rates, the WAL and lag.
  sim.tablesOf = (id) => {
    const node = nodes.get(id);
    if (!node?.store) return [];
    const window = Math.min(cfg.window, Math.max(sim.time, 0.25));
    const rate = (list) => list.length / window;
    const st = node.tableStats;
    return [...node.store.values()].map((table) => {
      const primary = node.primary?.store.get(table.name);
      return {
        name: table.name,
        key: table.key,
        count: table.rows.size,
        rows: table.touched.slice(0, table.show).map((key) => {
          const row = table.rows.get(key);
          const newest = primary?.rows.get(key)?.version;
          return { key, version: row?.version ?? null, fields: row?.fields || {}, age: row ? sim.time - row.at : null, behind: newest != null && (row?.version ?? 0) < newest };
        }),
        writes: rate(st.writes),
        inserts: rate(st.inserts),
        updates: rate(st.updates),
        conflicts: rate(st.conflicts),
        stale: rate(st.stale),
        misses: rate(st.misses),
        lockWaits: rate(st.lockWaits),
        lost: rate(st.lost),
        applied: rate(st.applied),
        wal: { lsn: node.wal.lsn, applied: node.wal.applied, recent: node.wal.recent.slice(-16) },
        primary: node.primary?.id ?? null,
        behind: node.primary ? node.primary.wal.lsn - node.wal.applied : 0,
      };
    });
  };
  // Full saved record, independent of the recent-row window used by tablesOf.
  // Return a detached snapshot so inspectors and other consumers cannot edit storage.
  sim.recordOf = (id, table, key) => {
    const node = nodes.get(id);
    const store = node?.store?.get(table);
    if (!store) return null;
    const primary = node.primary || node;
    const newest = primary.store?.get(table)?.rows.get(key);
    const latestWrite = copy => copy.wal?.recent.findLast(entry => entry.table === table && entry.key === key) ?? null;
    const copies = [...nodes.values()].filter(copy => copy.primary === primary);
    copies.unshift(primary);
    return structuredClone({
      node: id, label: node.label || id, table, keyName: store.key, key,
      row: store.rows.get(key) ?? null,
      latest: latestWrite(primary),
      copies: copies.map(copy => {
        const row = copy.store?.get(table)?.rows.get(key) ?? null;
        return {
          id: copy.id, label: copy.label || copy.id, row, latest: latestWrite(copy),
          behind: copy !== primary && (row?.version ?? null) !== (newest?.version ?? null),
        };
      }),
    });
  };
  // Per-route numbers at a node: [{ name, rate, p50, p99, errors }], busiest first.
  sim.routesOf = (id) => {
    const node = nodes.get(id);
    if (!node) return [];
    const window = Math.min(cfg.window, Math.max(sim.time, 0.25));
    return [...node.routes.values()]
      .map((route) => {
        const samples = (route.roots.length ? route.roots.filter((r) => r.ok) : route.service).map((s) => s.ms).sort((a, b) => a - b);
        return { name: route.name, rate: route.recent.length / window, p50: quantile(samples, 0.5), p99: quantile(samples, 0.99), errors: route.errors.length / window, count: samples.length, endToEnd: route.roots.length > 0 };
      })
      .sort((a, b) => b.rate - a.rate);
  };
  sim.trafficOf = (id) => {
    const state = sim.trafficState;
    if (!state) return [];
    const window = Math.min(cfg.window, Math.max(sim.time, 0.25));
    const samples = id ? state.arrivals.filter(e => e.node === id) : state.emitted;
    const keys = new Set([...Object.keys(state.definitions), ...samples.map(e => e.traffic)]);
    return [...keys].map(key => ({ id: key, label: state.definitions[key]?.label || key || "Unclassified", rate: samples.filter(e => e.traffic === key).length / window }));
  };
  sim.routingOf = id => {
    const rows = new Map();
    for (const d of sim.trafficState?.decisions || []) if (!id || d.node === id) {
      const key = JSON.stringify([d.node, d.rule, d.to, d.outcome]);
      if (!rows.has(key)) rows.set(key, { node: d.node, rule: d.rule, to: d.to, outcome: d.outcome, count: 0 });
      rows.get(key).count++;
    }
    return [...rows.values()];
  };
  sim.latencyOf = (id) => latencyOf(id ? [nodes.get(id)] : [...nodes.values()]);
  sim.statsOf = (id) => statsOf(sim, id);
  sim.summary = () => summaryOf(sim);
}

function reportTick(sim, dt) {
  const { cfg, nodes, edges } = sim;
  const now = sim.time;
  const window = Math.min(cfg.window, Math.max(now, 0.25));
  const trim = (list, keep = cfg.window) => {
    let old = 0;
    while (old < list.length && (list[old].at ?? list[old]) < now - keep) old++;
    if (old) list.splice(0, old);
  };
  if (sim.trafficState) for (const name of ["emitted", "arrivals", "paths", "decisions"]) trim(sim.trafficState[name]);
  for (const node of nodes.values()) {
    trim(node.recent);
    trim(node.recentDrops);
    trim(node.recentErrors);
    trim(node.service, 3);
    trim(node.roots, 3);
    if (node.tableStats) for (const list of Object.values(node.tableStats)) trim(list);
    for (const route of node.routes.values()) {
      trim(route.recent);
      trim(route.errors);
      trim(route.service, 3);
      trim(route.roots, 3);
    }
    node.flow = node.recent.length / window;
    node.dropRate = node.recentDrops.length / window;
    node.errorRateSeen = node.recentErrors.length / window;
  }
  for (const edge of edges) {
    trim(edge.recent);
    trim(edge.recentErrors);
    edge.flow = edge.recent.length / window;
    edge.errorRate = edge.recentErrors.length / window;
  }
  sim.histClock += dt;
  if (sim.histClock >= 0.25) {
    sim.histClock = 0;
    for (const node of nodes.values()) {
      node.hist.push(node.flow);
      if (node.hist.length > 120) node.hist.shift();
    }
    sim.hist.push(sim.totalIn());
    if (sim.hist.length > 120) sim.hist.shift();
  }
}

// p50 / p99 of completed requests started at these sources, over the last 3 s of model time.
function latencyOf(sources) {
  const samples = [];
  let failed = 0;
  for (const node of sources) for (const root of node?.roots || []) {
    if (root.ok) samples.push(root.ms);
    else failed++;
  }
  samples.sort((a, b) => a - b);
  return { p50: quantile(samples, 0.5), p99: quantile(samples, 0.99), count: samples.length, failed };
}

const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 10 ? n.toFixed(0) : n.toFixed(1));
const formatRate = (n, per = 1) => `${fmt(n * per)}/s`;
const formatCount = (n, per = 1) => fmt(n * per).replace(/\.0$/, "");
const formatMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 10 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(1)}ms`);

function statsOf(sim, id) {
  const node = sim.nodes.get(id);
  if (!node) return "";
  const per = sim.cfg.per;
  const name = node.label || node.id;
  if (!node.up) return `${name} · down${node.dropRate ? ` · ${formatRate(node.dropRate, per)} refused` : ""}`;
  const log = sim.logs.get(id);
  if (log) {
    const parts = log.groups.map((group) => {
      const lag = sim.lagOf(id, group.name);
      const live = [...group.assign.values()].filter((list) => list.length).length;
      return `${log.groups.length > 1 ? group.name + " " : ""}lag ${formatCount(lag, per)}${group.pause > 0 ? " · rebalancing" : node.kind === "kafka" ? ` · ${live}/${group.members.length} consumers` : ""}`;
    });
    if (log.brokers) {
      const live = log.brokers.filter(Boolean).length;
      const electing = log.parts.filter((part) => sim.time < part.electUntil).length;
      const offline = log.parts.filter((part) => !log.brokers[part.leader]).length;
      const under = log.parts.filter((part) => sim.isrOf(log, part) < log.minIsr).length;
      parts.push(`brokers ${live}/${log.brokers.length}`);
      if (electing) parts.push(`${electing} electing`);
      if (offline) parts.push(`${offline} offline`);
      if (under) parts.push(`${under} under min ISR${log.acks === "all" ? " (writes refused)" : ""}`);
    }
    return [`${name} · in ${formatRate(node.flow, per)}`, ...parts].join(" · ");
  }
  if (node.kind === "flags") {
    const list = [...sim.flags.values()].map((flag) => `${flag.name} ${Math.round(flag.effective * 100)}%${flag.effective !== flag.rollout ? ` (→${Math.round(flag.rollout * 100)}%)` : ""}`);
    return `${name} · ${list.join(" · ") || "no flags"}`;
  }
  const bits = [`${name} · ${formatRate(node.flow, per)}`];
  if (node.roots.length) {
    const lat = latencyOf([node]);
    if (lat.count) bits.push(`p50 ${formatMs(lat.p50)} · p99 ${formatMs(lat.p99)}`);
  } else if (node.service.length) {
    const sorted = node.service.map((s) => s.ms).sort((a, b) => a - b);
    bits.push(`${formatMs(quantile(sorted, 0.5))} p50`);
  }
  for (const t of sim.tablesOf(id)) {
    bits.push(`${t.count} ${t.name}`);
    if (t.primary) bits.push(`${t.behind} behind`);
    if (t.stale) bits.push(`${formatRate(t.stale, per)} stale reads`);
    if (t.conflicts) bits.push(`${formatRate(t.conflicts, per)} conflicts`);
    if (t.lost) bits.push(`${formatRate(t.lost, per)} lost updates`);
  }
  if (node.capacity) bits.push(`cap ${formatRate(node.capacity, per)}`);
  if (node.queueMax) bits.push(`queue ${node.waiting.length}/${node.queueMax}`);
  if (node.dropRate) bits.push(`${formatRate(node.dropRate, per)} rejected`);
  if (node.errorRateSeen) bits.push(`${formatRate(node.errorRateSeen, per)} errors`);
  for (const edge of node.out) if (edge.breaker && edge.breaker.state !== "closed") bits.push(`breaker → ${sim.nodes.get(edge.to).label || edge.to} ${edge.breaker.state}`);
  return bits.join(" · ");
}

function summaryOf(sim) {
  const per = sim.cfg.per;
  let lag = 0;
  let drops = 0;
  for (const node of sim.nodes.values()) drops += node.dropRate;
  for (const id of sim.logs.keys()) lag += sim.lagOf(id);
  const bits = [`${formatRate(sim.totalIn(), per)} in`];
  const lat = sim.latencyOf();
  if (lat.count) bits.push(`p50 ${formatMs(lat.p50)} · p99 ${formatMs(lat.p99)}`);
  if (sim.logs.size) bits.push(`lag ${formatCount(lag, per)}`);
  const failing = lat.failed / 3;
  const down = [...sim.nodes.values()].filter((node) => !node.up).length;
  bits.push(failing > 0.05 ? `${formatRate(failing, per)} failing` : drops ? `${formatRate(drops, per)} lost` : down ? `${down} down` : "healthy");
  return bits.join(" · ");
}

export { attachReporting, reportTick, formatRate, formatCount, formatMs, statsOf, summaryOf };
