import { envelopeOf, inheritEnvelope } from "./context.mjs";
import { isLog, groupOf, hashOf } from "./common.mjs";

// Kafka partitions/brokers and queue consumers. Transport delivers/launches packets;
// this module alone changes log offsets, assignments and election state.
function createLogs(sim, { launch, newMsg }) {
  const { nodes, logs, cfg, rand } = sim;
  // Logs: kafka topics (partitions, consumer groups with exclusive assignment) and queues
  // (one lane, competing consumers).
  for (const node of nodes.values()) {
    if (!isLog(node)) continue;
    const partitions = node.kind === "queue" ? 1 : node.partitions || 3;
    const groups = new Map();
    for (const edge of node.out) {
      const name = groupOf(node, edge);
      if (!groups.has(name)) groups.set(name, { name, members: [], committed: Array(partitions).fill(0), assign: new Map(), pause: 0, generation: 0 });
      groups.get(name).members.push(edge);
    }
    const log = { node, partitions, end: Array(partitions).fill(0), rr: 0, groups: [...groups.values()], appended: 0 };
    // Brokers: each partition has `rf` replicas, led round-robin. Losing a leader pauses its
    // partitions for `election` seconds; with acks "all", a partition whose in-sync replicas
    // fall below `minIsr` refuses writes.
    if (node.kind === "kafka" && node.brokers) {
      const n = node.brokers;
      log.brokers = Array(n).fill(true);
      log.rf = Math.min(node.rf ?? 3, n);
      log.minIsr = Math.min(node.minIsr ?? 2, log.rf);
      log.acks = node.acks ?? 1;
      log.election = node.election ?? 2;
      log.parts = Array.from({ length: partitions }, (_, p) => ({ replicas: Array.from({ length: log.rf }, (_, i) => (p + i) % n), leader: p % n, electUntil: 0 }));
    }
    if (sim.trafficState) log.envelopes = Array.from({ length: partitions }, () => new Map());
    logs.set(node.id, log);
  }

  function rebalance(log, group, now) {
    const live = group.members.filter((edge) => nodes.get(edge.to).up);
    group.assign = new Map();
    if (log.node.kind === "queue") {
      for (const edge of live) group.assign.set(edge.index, [0]);
    } else {
      live.forEach((edge) => group.assign.set(edge.index, []));
      for (let p = 0; p < log.partitions; p++) if (live.length) group.assign.get(live[p % live.length].index).push(p);
      group.generation++;
      if (now > 0) group.pause = cfg.rebalance;
    }
    sim.events.push({ type: "rebalance", log: log.node.id, group: group.name, at: now });
  }
  for (const log of logs.values()) for (const group of log.groups) rebalance(log, group, 0);

  const isrOf = (log, part) => part.replicas.filter((b) => log.brokers[b]).length;
  const readable = (log, p) => log.node.up && (!log.parts || (sim.time >= log.parts[p].electUntil && log.brokers[log.parts[p].leader]));
  const writable = (log, p) => readable(log, p) && (!log.parts || log.acks !== "all" || isrOf(log, log.parts[p]) >= log.minIsr);

  function setBroker(id, b, up) {
    const log = logs.get(id);
    if (!log?.brokers || b < 0 || b >= log.brokers.length || log.brokers[b] === up) return;
    log.brokers[b] = up;
    sim.events.push({ type: up ? "broker-up" : "broker-down", node: id, broker: b, at: sim.time });
    for (const part of log.parts) {
      if (!up && part.leader === b) {
        const next = part.replicas.find((r) => log.brokers[r]);
        if (next != null) {
          part.leader = next;
          part.electUntil = sim.time + log.election;
        }
      } else if (up && !log.brokers[part.leader] && part.replicas.includes(b)) {
        part.leader = b;
        part.electUntil = sim.time + log.election;
      }
    }
  }

  function chooseP(log, edge, packet) {
    if (packet.partition != null) return packet.partition;
    if (edge.key != null) return hashOf(String(edge.key)) % log.partitions;
    const skew = log.node.skew;
    if (skew) {
      const total = skew.reduce((a, b) => a + b, 0);
      let pick = rand() * total;
      for (let p = 0; p < log.partitions; p++) if ((pick -= skew[p] ?? 0) <= 0) return p;
      return log.partitions - 1;
    }
    return log.rr++ % log.partitions;
  }

  function pull(dt) {
    // Consumers pull from logs at their own rate.
    for (const log of logs.values()) {
      for (const group of log.groups) {
        if (group.pause > 0) {
          group.pause = Math.max(0, group.pause - dt);
          continue;
        }
        for (const edge of group.members) {
          const consumer = nodes.get(edge.to);
          if (!consumer.up) continue;
          const parts = group.assign.get(edge.index) || [];
          const rate = edge.rate ?? consumer.rate ?? 40;
          consumer.tokens = Math.min(consumer.tokens + rate * dt, 3);
          while (consumer.tokens >= 1) {
            let best = -1;
            let most = 0;
            for (const p of parts) {
              if (!readable(log, p)) continue;
              const lag = log.end[p] - group.committed[p];
              if (lag > most) {
                most = lag;
                best = p;
              }
            }
            if (best < 0) {
              consumer.tokens = Math.min(consumer.tokens, 1);
              break;
            }
            consumer.tokens -= 1;
            group.committed[best]++;
            const msg = newMsg(log.node.id);
            const envelope = log.envelopes?.[best].get(group.committed[best]);
            if (envelope) inheritEnvelope(msg, envelope);
            launch(edge, "record", { partition: best, group: group.name, msg, ...(envelope?.parentSpan != null ? { traceParent: envelope.parentSpan } : {}) });
            if (log.envelopes) {
              const dispatched = Math.min(...log.groups.map(g => g.committed[best]));
              for (const offset of log.envelopes[best].keys()) {
                if (offset > dispatched) break;
                log.envelopes[best].delete(offset);
              }
            }
          }
        }
      }
    }
  }

  const lagOf = (id, groupName) => {
    const log = logs.get(id);
    if (!log) return 0;
    const group = groupName ? log.groups.find((g) => g.name === groupName) : log.groups[0];
    if (!group) return 0;
    return log.end.reduce((sum, end, p) => sum + end - group.committed[p], 0);
  };
  function append(log, edge, packet) {
    const p = chooseP(log, edge, packet);
    if (!writable(log, p)) return null;
    log.end[p]++;
    log.appended++;
    return p;
  }
  function remember(log, partition, msg, parentSpan) {
    if (log.envelopes && log.groups.length && msg) log.envelopes[partition].set(log.end[partition], envelopeOf(msg, parentSpan));
  }
  return { remember, append, rebalance, pull, lagOf, setBroker, readable, isrOf };
}

export { createLogs };
