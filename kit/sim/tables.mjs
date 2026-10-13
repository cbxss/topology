// Tables own record identity, row locks, operations and WAL application.
// Callbacks preserve transport scheduling without importing the transport module.
function createTables(sim, records, { launch, respond, begin }) {
  const { nodes, rand } = sim;
  // Tables: rows keyed by a record key, a write-ahead log, and replicas that apply its entries.
  // A replica (a db fed by a replication edge) gets its primary's tables if it declares none.
  for (const node of nodes.values()) {
    const primaryEdge = node.into.find((edge) => edge.kind === "replication" && nodes.get(edge.from).tables);
    if (!node.tables && primaryEdge && node.kind === "db") node.tables = nodes.get(primaryEdge.from).tables;
    if (!node.tables) continue;
    node.primary = primaryEdge ? nodes.get(primaryEdge.from) : null;
    node.store = new Map(Object.entries(node.tables).map(([name, t]) => [name, { name, key: t.key || "id", show: t.show || 6, rows: new Map(), touched: [] }]));
    node.wal = { lsn: 0, applied: 0, recent: [] };
    node.tableStats = { writes: [], inserts: [], updates: [], conflicts: [], stale: [], misses: [], lockWaits: [], lost: [], applied: [] };
    node.locked = new Map();
  }

  // The record a request is about, one per table: a key from the table's keyspace (with
  // `skew`, that share of requests hits the hottest 5% of keys) and a value for each field.
  const recordOf = (msg, table) => {
    msg.records ??= {};
    if (!msg.records[table]) {
      const def = records[table] || {};
      const keys = def.keys || 100;
      const hot = Math.max(1, Math.round(keys * 0.05));
      const n = def.skew && rand() < def.skew ? Math.floor(rand() * hot) : Math.floor(rand() * keys);
      const fields = {};
      for (const [name, values] of Object.entries(def.fields || {})) fields[name] = values[Math.floor(rand() * values.length)];
      msg.records[table] = { key: (def.start ?? 1000) + n, fields };
    }
    return msg.records[table];
  };
  const WRITES = new Set(["insert", "upsert", "update", "delete", "rmw"]);
  const tableOp = (job) => (job.node.store && job.op?.table && job.node.store.has(job.op.table) ? job.op : null);

  function acquireWrite(job) {
    const node = job.node;
    // Row locks: a write waits for any other write on the same key to commit.
    const op = tableOp(job);
    if (op && node.locks && WRITES.has(op.op) && !job.holdsLock) {
      const key = `${op.table}:${recordOf(job.msg, op.table).key}`;
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
    if (op && op.op === "rmw") job.readVersion = node.store.get(op.table).rows.get(recordOf(job.msg, op.table).key)?.version ?? 0;
    return true;
  }

  function releaseWrite(job) {
    const node = job.node;
    if (job.holdsLock) {
      const waiters = node.locked.get(job.holdsLock) || [];
      const next = waiters.shift();
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
  const rowEvent = (node, op, table, key, extra) => !sim.quiet && sim.events.push({ type: "row", node: node.id, table: table.name, key, op, at: sim.time, ...extra });

  // Apply a table operation at commit. Returns whether it succeeded.
  function commit(job, op) {
    const node = job.node;
    const table = node.store.get(op.table);
    const record = recordOf(job.msg, op.table);
    const key = record.key;
    const row = table.rows.get(key);
    const stats = node.tableStats;
    if (op.op === "select") {
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
      const newest = Math.max(node.primary?.store.get(op.table)?.rows.get(key)?.version ?? 0, job.msg.wrote?.[`${op.table}:${key}`] ?? 0);
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
    let kind = "delete";
    if (op.op === "delete") {
      if (!row) return true;
      table.rows.delete(key);
    } else {
      // An unlocked read-modify-write that read an older version overwrites a newer one.
      if (op.op === "rmw" && row && row.version !== job.readVersion) stats.lost.push(sim.time);
      kind = row ? "update" : "insert";
      table.rows.set(key, { key, version: (row?.version ?? 0) + 1, fields: record.fields, at: sim.time });
    }
    const version = (row?.version ?? 0) + 1;
    touch(table, key);
    stats.writes.push(sim.time);
    if (kind === "insert") stats.inserts.push(sim.time);
    if (kind === "update") stats.updates.push(sim.time);
    job.msg.wrote = { ...(job.msg.wrote || {}), [`${op.table}:${key}`]: version };
    const entry = { lsn: ++node.wal.lsn, table: op.table, key, op: kind, version, fields: record.fields, at: sim.time };
    node.wal.recent = [...node.wal.recent.slice(-23), entry];
    node.wal.applied = entry.lsn;
    rowEvent(node, kind, table, key, { version: entry.version, lsn: entry.lsn });
    if (job.span) job.span.label = `${op.op} ${op.table}/${key} → ${kind} v${version}`;
    for (const edge of node.repl) launch(edge, "replication", { msg: job.msg, entry, parentJob: job });
    return true;
  }

  // A replica applies a WAL entry, `lag` seconds after it arrives if it has one.
  function applyEntry(job) {
    const node = job.node;
    const apply = () => {
      const { entry } = job;
      const table = node.store?.get(entry.table);
      if (table) {
        const row = table.rows.get(entry.key);
        if (entry.op === "delete") table.rows.delete(entry.key);
        else if (!row || row.version < entry.version) table.rows.set(entry.key, { key: entry.key, version: entry.version, fields: entry.fields, at: sim.time });
        touch(table, entry.key);
        node.tableStats.applied.push(sim.time);
        node.wal.applied = Math.max(node.wal.applied, entry.lsn);
        node.wal.lsn = Math.max(node.wal.lsn, entry.lsn);
        node.wal.recent = [...node.wal.recent.slice(-23), entry];
        rowEvent(node, "apply", table, entry.key, { version: entry.version, lsn: entry.lsn });
      }
      respond(job, true);
    };
    if (node.lag) sim.timers.push({ at: sim.time + node.lag, run: () => node.up && !job.dead && apply() });
    else apply();
  }

  return { recordOf, tableOp, acquireWrite, releaseWrite, commit, applyEntry };
}

export { createTables };
