// Two figures chained into one: order-events, embedded whole with its clients, and the ledger
// (ten shards), embedded without its own client. A new consumer group on orders.v1 feeds the
// ledger, so a dead shard shows up as failures behind Kafka while orders keep flowing.
import { compose, importSpec, link, system } from "../../kit/patterns.mjs";

const orders = system("orders", await importSpec(new URL("../order-events/order-events.spec.mjs", import.meta.url)), { at: [0, 0], keepSources: true });
const books = system("books", await importSpec(new URL("../ledger/ledger.spec.mjs", import.meta.url)), { at: [3.2, 4.4] });

export default compose(
  {
    title: "Orders → ledger",
    fig: "Fig 9",
    caption:
      "Built from two figures with system(): order-events on top, the ledger below. Every order on orders.v1 is also read by a ledger consumer group, which posts it to ledger-api and on to one of ten shards. Fail a shard and the ledger group's writes to it fail; billing and search never notice.",
    sim: { per: 40, seed: 9 },
    scenario: {
      length: 36,
      phases: [{ name: "steady", at: 0 }, { name: "shard lost", at: 10 }, { name: "recovered", at: 24 }],
      steps: [
        { at: 1, say: "Orders reach orders.v1 at ~400/s. Billing, search and now the ledger read it as separate consumer groups." },
        { phase: "shard lost", fail: "books.shard-3", say: "Ledger shard-3 dies. About a tenth of ledger writes are refused; the order path, billing and search are untouched." },
        { phase: "recovered", recover: "books.shard-3", say: "shard-3 is back and the ledger takes every order again." },
      ],
    },
  },
  orders,
  books,
  link(orders.id("topic"), books.in, { group: "ledger", rate: 14 }),
);
