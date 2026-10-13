import { cacheAside, compose } from "../../kit/patterns.mjs";

export default compose({
  title: "Reusable data stores",
  fig: "Fig 12",
  caption: "Illustrative traffic and synthetic fields. Redis and ElastiCache use the shared cache model; the service independently samples reads to DynamoDB at a 20% miss rate. The session branch demonstrates Redis separately. DynamoDB uses generic table operations, not AWS APIs, capacity units, consistency modes or global tables. Click DynamoDB, then a row, to inspect saved fields and follow writes.",
  records: { items: { key: "itemId", keys: 12, fields: { name: ["Notebook", "Mug"], stock: [0, 12, 48], available: [true, false] } } },
}, {
  nodes: [
    { id: "users", kind: "client", emit: { "GET /items": 5 }, at: [0, 0] },
    { id: "api", kind: "service", label: "catalog-api", at: [1, 0], endpoints: { "GET /items": { calls: [{ to: "sessions" }, { to: "cache" }, { to: "items", op: "select", table: "items", p: 0.2 }] } } },
    { id: "sessions", kind: "redis", label: "Redis sessions", at: [2, -1.3] },
    { id: "items", kind: "dynamodb", label: "DynamoDB items", at: [2, 1.3], tables: { items: { key: "itemId" } } },
    { id: "writer", kind: "client", emit: { "PUT /items": 2 }, at: [0, 2.6] },
    { id: "save", kind: "service", at: [1, 2.6], endpoints: { "PUT /items": { calls: [{ to: "items", op: "upsert", table: "items" }] } } },
  ],
  edges: [["users", "api"], ["api", "sessions"], ["writer", "save"], ["save", "items"]],
}, cacheAside("api", { id: "cache", kind: "elasticache", label: "ElastiCache", db: "items", hit: 0.8, at: [2, 0] }));
