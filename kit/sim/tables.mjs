// Tables own record identity, row locks, operations and WAL application.
// Callbacks preserve transport scheduling without importing the transport module.
function createTables(sim, records, { launch, respond, begin, entities }) {
  const { nodes, rand } = sim;
  // Tables: rows keyed by a record key, a write-ahead log, and replicas that apply its entries.
  // A replica (a db fed by a replication edge) gets its primary's tables if it declares none.
  for (const node of nodes.values()) {
    const primaryEdge = node.into.find((edge) => edge.kind === "replication" && nodes.get(edge.from).tables);
    if (!node.tables && primaryEdge && node.kind === "db") node.tables = nodes.get(primaryEdge.from).tables;
    if (!node.tables) continue;
    node.primary = primaryEdge ? nodes.get(primaryEdge.from) : null;
    node.store = new Map(Object.entries(node.tables).map(([name, t]) => [name, { name, key: t.key || "id", show: t.show || 6, rows: new Map(), versions: new Map(), touched: [] }]));
    node.wal = { lsn: 0, applied: 0, recent: [], received: new Map(), pending: new Map() };
    node.tableStats = { writes: [], inserts: [], updates: [], conflicts: [], stale: [], misses: [], lockWaits: [], lost: [], applied: [] };
    node.locked = new Map();
  }

  // The record a request is about, one per table: a key from the table's keyspace (with
  // `skew`, that share of requests hits the hottest 5% of keys) and a value for each field.
  const recordOf = (msg, table) => {
    msg.records ??= Object.create(null);
    if (!Object.hasOwn(msg.records, table)) {
      const def = records[table] || {};
      const keys = def.keys || 100;
      const hot = Math.max(1, Math.round(keys * 0.05));
      const n = def.skew && rand() < def.skew ? Math.floor(rand() * hot) : Math.floor(rand() * keys);
      const fields = Object.create(null);
      for (const [name, values] of Object.entries(def.fields || {})) fields[name] = values[Math.floor(rand() * values.length)];
      msg.records[table] = { key: (def.start ?? 1000) + n, fields };
    }
    return msg.records[table];
  };
  const recordFor = (job, table) => job.op?.entityRun?.record || recordOf(job.msg, table);
  const WRITES = new Set(["insert", "upsert", "update", "delete", "rmw"]);
  const tableOp = (job) => (job.node.store && job.op?.table && job.node.store.has(job.op.table) ? job.op : null);

  function acquireWrite(job) {
    const node = job.node;
    // Row locks: a write waits for any other write on the same key to commit.
    const op = tableOp(job);
    if (op && node.locks && WRITES.has(op.op) && !job.holdsLock) {
      const key = `${op.table}:${recordFor(job, op.table).key}`;
      if (node.locked.has(key)) {
        node.locked.get(key).push(job);
        node.tableStats.lockWaits.push(sim.time);
        return false;
      }
      node.locked.set(key, []);
      job.holdsLock = key;
    }
    // An unlocked read-modify-write reads now and writes at commit: anything committed in
    // between is overwritten (a lost update).
    if (op && op.op === "rmw") job.readVersion = node.store.get(op.table).rows.get(recordFor(job, op.table).key)?.version ?? 0;
    return true;
  }

  function releaseWrite(job) {
    const node = job.node;
    if (job.holdsLock) {
      const waiters = node.locked.get(job.holdsLock) || [];
      let next;
      while (waiters.length && !next) {
        const candidate = waiters.shift();
        if (!candidate.dead && !candidate.done) next = candidate;
      }
      if (next) {
        next.holdsLock = job.holdsLock;
        node.locked.set(job.holdsLock, waiters);
        if (!next.dead && !next.done) begin(next);
      } else node.locked.delete(job.holdsLock);
      job.holdsLock = null;
    }
  }

  const touch = (table, key) => {
    table.touched = [key, ...table.touched.filter((k) => k !== key)].slice(0, 16);
  };
  const retryDelay = (edge) => {
    const target = nodes.get(edge.to);
    return Math.max(1, edge.len / sim.cfg.speed + target.ms * 5 / 1000 + (target.lag || 0) + 1);
  };
  const rowEvent = (node, op, table, key, extra) => !sim.quiet && sim.events.push({ type: "row", node: node.id, table: table.name, key, op, at: sim.time, ...extra });

  // Apply a table operation at commit. Returns whether it succeeded.
  function commit(job, op) {
    const node = job.node;
    const table = node.store.get(op.table);
    const record = recordFor(job, op.table);
    const key = record.key;
    const row = table.rows.get(key);
    const stats = node.tableStats;
    if (op.op === "select") {
      entities?.read(job, row);
      if (row) touch(table, key);
      if (!row) {
        const stale = !!node.primary?.store.get(op.table)?.rows.has(key) || (job.msg.wrote?.[`${op.table}:${key}`] ?? 0) > 0;
        stats.misses.push(sim.time);
        if (stale) stats.stale.push(sim.time);
        rowEvent(node, "miss", table, key, { stale });
        if (job.span) job.span.label = `select ${op.table}/${key} → not found${stale ? " (stale)" : ""}`;
        return true;
      }
      // On a replica: stale if the primary has a newer version, or if this same request
      // wrote a newer one (read-your-writes).
      const newest = Math.max(node.primary?.store.get(op.table)?.versions.get(key) ?? 0, job.msg.wrote?.[`${op.table}:${key}`] ?? 0);
      const stale = newest > row.version;
      if (stale) stats.stale.push(sim.time);
      rowEvent(node, "select", table, key, { version: row.version, stale });
      if (job.span) job.span.label = `select ${op.table}/${key} → v${row.version}${stale ? " (stale)" : ""}`;
      return true;
    }
    if (op.op === "insert" && row) {
      if (job.span) job.span.label = `insert ${op.table}/${key} → conflict (v${row.version} exists)`;
      stats.conflicts.push(sim.time);
      rowEvent(node, "conflict", table, key, { version: row.version });
      return false;
    }
    if (op.op === "update" && !row) {
      stats.misses.push(sim.time);
      rowEvent(node, "miss", table, key);
      return true;
    }
    const version = (table.versions.get(key) ?? 0) + 1;
    let kind = "delete";
    if (op.op === "delete") {
      if (!row && !op.entityRun) return true;
      table.rows.delete(key);
    } else {
      // An unlocked read-modify-write that read an older version overwrites a newer one.
      if (op.op === "rmw" && row && row.version !== job.readVersion) stats.lost.push(sim.time);
      kind = row ? "update" : "insert";
      table.rows.set(key, { key, version, fields: record.fields, at: sim.time });
    }
    table.versions.set(key, version);
    touch(table, key);
    stats.writes.push(sim.time);
    if (kind === "insert") stats.inserts.push(sim.time);
    if (kind === "update") stats.updates.push(sim.time);
    job.msg.wrote = { ...(job.msg.wrote || {}), [`${op.table}:${key}`]: op.op === "delete" ? -version : version };
    const entry = { lsn: ++node.wal.lsn, table: op.table, key, op: kind, version, fields: record.fields, at: sim.time };
    entities?.committed(job, entry, table.rows.get(key));
    node.wal.recent = [...node.wal.recent.slice(-23), entry];
    node.wal.applied = entry.lsn;
    rowEvent(node, kind, table, key, { version: entry.version, lsn: entry.lsn });
    if (job.span) job.span.label = `${op.op} ${op.table}/${key} → ${kind} v${version}`;
    for (const edge of node.repl) {
      if (nodes.get(edge.to).store) {
        const pending = node.wal.pending.get(edge.index) || new Map();
        node.wal.pending.set(edge.index, pending);
        pending.set(entry.lsn, { entry, msg: job.msg, retryAt: sim.time + retryDelay(edge) });
      }
      launch(edge, "replication", { msg: job.msg, entry, parentJob: job });
    }
    return true;
  }

  // A replica applies a WAL entry, `lag` seconds after it arrives if it has one.
  function applyEntry(job) {
    const node = job.node;
    // Lag is chosen on arrival; a scenario may change it after launch.
    const pendingItem = node.primary?.wal.pending.get(job.via.index)?.get(job.entry.lsn);
    if (pendingItem) pendingItem.retryAt = Math.max(pendingItem.retryAt, sim.time + (node.lag || 0) + 1);
    const apply = () => {
      const { entry } = job;
      const table = node.store?.get(entry.table);
      if (table) {
        // Buffer arrivals until the preceding LSN has applied. A late delete must
        // never erase a newer recreation, and "applied" must not skip missing writes.
        if (entry.lsn > node.wal.applied) node.wal.received.set(entry.lsn, entry);
        while (node.wal.received.has(node.wal.applied + 1)) {
          const next = node.wal.received.get(node.wal.applied + 1);
          node.wal.received.delete(next.lsn);
          const target = node.store.get(next.table);
          if (next.op === "delete") target.rows.delete(next.key);
          else target.rows.set(next.key, { key: next.key, version: next.version, fields: next.fields, at: sim.time, ...(next.entity ? {entity:next.entity} : {}) });
          entities?.applied(node, next);
          target.versions.set(next.key, next.version);
          touch(target, next.key);
          node.tableStats.applied.push(sim.time);
          node.wal.applied = next.lsn;
          node.wal.lsn = next.lsn;
          node.wal.recent = [...node.wal.recent.slice(-23), next];
          rowEvent(node, "apply", target, next.key, { version: next.version, lsn: next.lsn });
        }
        // Acknowledge contiguous progress, including duplicates retried after downtime.
        const pending = node.primary?.wal.pending.get(job.via.index);
        if (pending) for (const lsn of pending.keys()) if (lsn <= node.wal.applied) pending.delete(lsn);
      }
      respond(job, true);
    };
    if (node.lag) sim.timers.push({ at: sim.time + node.lag, run: () => node.up && !job.dead && apply() });
    else apply();
  }

  function reset(node) {
    node.locked?.clear();
    // Stored rows and buffered WAL survive node failure in this simplified model.
    for (const source of nodes.values()) for (const edge of source.repl) {
      if (edge.to !== node.id) continue;
      for (const item of source.wal?.pending.get(edge.index)?.values() || []) item.retryAt = -Infinity;
    }
  }

  function retryReplication() {
    for (const source of nodes.values()) {
      if (!source.up || !source.wal) continue;
      for (const edge of source.repl) {
        const target = nodes.get(edge.to);
        if (!target.up) continue;
        // Bound retries by travel, service and configured lag; delivery is still
        // subject to the normal transport, admission and node failure paths.
        for (const item of source.wal.pending.get(edge.index)?.values() || []) {
          if (sim.time < item.retryAt || target.wal.received.has(item.entry.lsn)) continue;
          item.retryAt = sim.time + retryDelay(edge);
          launch(edge, "replication", { msg: item.msg, entry: item.entry });
        }
      }
    }
  }

  return { recordOf, tableOp, acquireWrite, releaseWrite, commit, applyEntry, reset, retryReplication };
}

export { createTables };
