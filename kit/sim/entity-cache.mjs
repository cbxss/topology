// Explicit caches are independent of the existing probabilistic cache routing.
function createEntityCache(sim, expired) {
  const stores = new Map();
  const keyOf = (type, representation) => JSON.stringify([type, representation]);
  function store(type, representation) {
    const key = keyOf(type, representation);
    if (!stores.has(key)) stores.set(key, new Map());
    return stores.get(key);
  }
  function expire() {
    for (const rows of stores.values()) for (const [key, row] of rows) if (row.expiresAt != null && sim.time >= row.expiresAt) {
      rows.delete(key); expired(row);
    }
  }
  return { stores, store, expire };
}
export { createEntityCache };
