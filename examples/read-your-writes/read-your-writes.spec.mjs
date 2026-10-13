// Save, then show what you saved: the API writes the profile to the primary and reads it back
// to return it. Reading it back from the replica works until the replica falls behind; then
// users see their old profile. The fix: read your own write from the primary.
export default {
  title: "Read your writes",
  fig: "Fig 9",
  caption:
    "PUT /profile upserts the profile into the primary, then reads it back to return it. While the replica keeps up, reading back from it is fine. When it falls behind (it applies the WAL 1.5 s late), the read-back returns the old version: a stale read, the user's change seems lost. The fix reads your own write from the primary.",
  sim: { per: 20, seed: 21 },
  grid: [150, 80],
  records: { profiles: { key: "userId", keys: 30, fields: { plan: ["free", "pro", "team"] } } },
  nodes: [
    { id: "app", kind: "client", at: [0, 0.5], emit: { "PUT /profile": 6 } },
    {
      id: "api",
      kind: "service",
      replicas: 2,
      label: "profile-api",
      at: [1, 0.5],
      endpoints: {
        "PUT /profile": { ms: 4, calls: [{ to: "pg", op: "upsert", table: "profiles" }, { to: "replica", op: "select", table: "profiles", then: true }] },
        "PUT /profile (fixed)": { ms: 4, calls: [{ to: "pg", op: "upsert", table: "profiles" }, { to: "pg", op: "select", table: "profiles", then: true }] },
      },
    },
    { id: "pg", kind: "db", role: "primary", label: "pg-primary", at: [2.2, 0], tables: { profiles: { key: "userId", show: 6 } } },
    { id: "replica", kind: "db", role: "replica", label: "pg-replica", at: [2.2, 1.05] },
  ],
  edges: [["app", "api"], ["api", "pg"], ["api", "replica"], { from: "pg", to: "replica", kind: "replication" }],
  scenario: {
    length: 40,
    phases: [
      { name: "replica keeps up", at: 0 },
      { name: "replica behind", at: 9 },
      { name: "fixed", at: 24 },
    ],
    steps: [
      { at: 1, say: "Each PUT /profile writes to the primary, then reads the profile back from the replica to return it. The replica applies the WAL almost at once." },
      { phase: "replica behind", set: { replica: { lag: 1.5 } }, inspect: "replica", say: "The replica starts applying the WAL 1.5 s late (amber: rows behind the primary). The read-back often gets the previous version." },
      { phase: "replica behind", after: 5, follow: "PUT /profile", say: "Follow one request: the upsert writes v5 to the primary, the read-back from the replica returns v4, marked stale." },
      { phase: "fixed", follow: false, inspect: false, set: { app: { emit: { "PUT /profile (fixed)": 6 } } }, say: "The fix: read your own write from the primary. The replica is still behind, but nobody reads it straight after writing." },
      { phase: "fixed", after: 8, set: { replica: { lag: 0 } }, say: "The replica catches up." },
    ],
  },
};
