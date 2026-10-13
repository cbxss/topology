const SIM_DEFAULTS = { speed: 150, per: 1, rebalance: 0.9, window: 2, seed: 7, refuse: 0.02, net: 0.5, length: 0, loop: true };
const SERVICE_MS = { client: 0, lb: 0.3, gateway: 1, service: 8, worker: 15, cache: 0.4, db: 4, storage: 20, kafka: 2, queue: 1, cdn: 0.5, dns: 1, external: 120, flags: 1, scheduler: 0, box: 5 };
const DETECT = { lb: 0.6, gateway: 0.6, dns: 3 };

function rngOf(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const isLog = (node) => node.kind === "kafka" || node.kind === "queue";
// A log's consumer group for an edge out of it: a queue has one shared group.
const groupOf = (log, edge) => (log.kind === "queue" ? "queue" : edge.group || "default");

const routeOf = (node) => node.route || (node.kind === "lb" || node.kind === "gateway" || node.kind === "dns" ? "roundrobin" : "all");

function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// One pass: [items where test holds, the rest].
function split(list, test) {
  const yes = [];
  const no = [];
  for (const item of list) (test(item) ? yes : no).push(item);
  return [yes, no];
}

export { SIM_DEFAULTS, SERVICE_MS, DETECT, rngOf, isLog, groupOf, routeOf, hashOf, split };
