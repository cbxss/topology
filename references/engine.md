# Engine maintenance

Figure authors use `SKILL.md`, `spec.md`, examples and `verify.md`. This document is for changing simulation capabilities or packaging.

## Ownership

`kit/topo-sim.mjs` preserves the public exports. Node and the standalone page execute the same module bodies.

| File under `kit/sim/` | Owns |
|---|---|
| `core.mjs` | Initial node/edge state, component wiring, clock, public simulation API and tick order |
| `transport.mjs` | Source emission, jobs, admission queues, routing, endpoint stages, calls, timeouts, retries, breakers, packets and trace spans |
| `tables.mjs` | Per-request synthetic record identity, row locks, operations, version races, WAL and replica application |
| `logs.mjs` | Kafka/queue offsets, partitions, consumer assignments, elections, ISR and pulls |
| `scenario.mjs` | Target grammar, phase normalization, scripted controls and flag decisions |
| `reporting.mjs` | Bounded histories, rates, latency, table/route projections and readout formatting |
| `common.mjs` | Constants and small pure helpers |

The state object retains its existing node maps, queues, call sets, packets and event arrays because the renderer and inspector consume them. Factories receive that state and explicit callbacks. Tables can launch WAL packets, complete an apply job, or resume a writer; logs can launch a record and allocate its message. Scenario controls delegate cancellation/edge changes to transport and broker/assignment changes to logs. Factories must not invoke transport callbacks during initialization. No module imports core or the public entry point.

A tick advances time, applies scenario steps, runs due timers, retries pending table replication, processes nodes in insertion order, handles timeouts, pulls consumers, moves packets, and updates reporting. Preserve this sequence, map/set iteration order, substeps and RNG draw order. Packet travel affects scheduling even though reported call latency excludes its display duration. Requests remain one shared object through retries and stages; do not clone their record identity or trace context.

## Packaging

`scripts/sim-bundle.mjs` has an explicit `SIM_MODULES` manifest. It visits dependencies first and wraps each module in a separate function scope, then exposes only the entry point's exports to the page runtime. It reads the live sources on each build; the server watches `kit/` recursively.

Use ordinary declarations with one-line named relative imports and one-line local export lists:

```js
import { split } from "./common.mjs";
function operation() { /* ... */ }
export { operation };
```

No import/export aliases, default exports, declaration exports (`export const`/`export function`), re-exports, multiline module statements, dynamic imports, `import.meta` or cycles. The line-based convention reserves standalone import/export lines for module statements, including inside template literals/comments. Unsupported static syntax fails Script compilation; dynamic import/import.meta are explicitly rejected. The helper is for these controlled kit sources, not arbitrary JavaScript. No npm dependency or browser network import is required. Feature toggles still strip model fields and optional UI; this bundle does not claim tree shaking.

## Verification and baseline

Run `node --test tests/*.test.mjs`. `sim-parity.test.mjs` replays 66 frozen cases: all 11 completed S4 examples with six feature configurations, original seeds, explicit timestep patterns and follow/unfollow actions. Seven checkpoints cover 0–48 seconds. The fixture contains the normalized inputs, expected state hashes and summaries, and the SHA-256 of the original engine source. The source was frozen before extraction at `83a093f5892be6997eae20f3f28455d21d3fbb7fe79d315202d57286c8a4f786`.

`observeSim` encodes cyclic/shared references, ordered maps/sets/arrays, packets, events, active jobs/calls, rows, WAL, offsets and trace spans, plus public reports. Function bodies and closure internals are excluded; their effects are checked by subsequent steps. This is bounded regression evidence, not proof of every possible workload. Do not regenerate the fixture from a candidate to make a structural refactor pass. A deliberate behavior change needs its own regression case and a reviewed baseline update.

Run `node scripts/verify-sim-browser.mjs` for generated-HTML execution in Chrome, deterministic Node/browser comparisons, and inspector/trace/story/view controls. This requires Node 22+ and Chrome. Then rebuild examples, run all model checks and use `verify.md` for screenshots and line ends. Authoring recipes are extracted from `spec.md` by `authoring.test.mjs`; keep the tested marker with the runnable recipe.

### Saved-record consumers

Use `sim.recordOf(nodeId, tableName, numericKey)` for full record inspection,
including keys no longer in the recent-row list. It returns `null` for an unknown
node/table; a known table with no saved key returns `row: null`. The detached
snapshot contains `keyName`, `row`, the latest retained primary WAL entry
(`latest`), and `copies` with saved rows and retained WAL entries at the primary
and its direct replicas. Version belongs to row metadata, not the user fields.
Do not reconstruct replication relationships or scan mutable WAL arrays in UI
code. Reporting performs no writes, scheduling or RNG draws.

### v1 behavioral corrections and release gate

The original `sim-s4-baseline.json` remains immutable.
`sim-v1-updates.json` overrides full-state hashes for 16 table cases: stores now
retain version tombstones, replica arrival buffers and unacknowledged WAL.
All 462 S4 summary checkpoints remain equal, and the other 50 cases retain
their full original hashes. `release.test.mjs` independently asserts recovery,
LSN ordering, delete/recreate, empty endpoint stages, invalid inputs, queue
outages, CLI failure status and malformed server URLs. These checks justify
the state changes; the new hashes alone do not establish correctness.

CI runs both Node tests and the generated-page Chrome verifier, checks every
example, rebuilds both themes and catalogs, and rejects generated-file drift.
Release tags must point to a commit whose complete CI run passed.

Opt-in routing lives in `sim/routing.mjs` (pure predicates and destination choice)
and `sim/context.mjs` (immutable request/envelope data). Transport decides when
to route; logs retain envelopes until all groups dispatch; reporting projects
bounded decision/rate histories. `routing-validation.mjs` owns the public schema.
`topo-traffic.js` and `traffic.css` only read the model. Legacy specs allocate no
context/envelope histories and retain their RNG order. The builder bundles the
new ESM modules using the same scoped module manifest; do not concatenate exports
ad hoc or change the frozen release fixtures to accommodate new behavior.
