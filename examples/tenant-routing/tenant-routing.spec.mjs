// One immutable context drives independent decisions at the gateway and database call.
export default {
  title: 'Tenant routing', fig: 'Routing 1', grid: [150, 90],
  caption: 'Synthetic standard and premium requests share a gateway. Their immutable tier selects a service, then a database. Failing premium-db produces premium failures; it never spills into shared-db. Select a class or follow a request to inspect the decisions. Colors identify traffic, not success.',
  traffic: {
    standard: {label: 'Standard', color: 'cyan', context: {tier: 'standard'}},
    premium: {label: 'Premium', color: 'violet', context: {tier: 'premium'}},
  },
  policies: {premium: {field: 'context.tier', eq: 'premium'}},
  records: {orders: {key: 'orderId', keys: 40, fields: {status: ['paid', 'new'], quantity: [1, 2, 3]}}},
  nodes: [
    {id: 'app', kind: 'client', at: [0, .5], workload: [{traffic: 'standard', endpoint: 'POST /orders', rate: 9}, {traffic: 'premium', endpoint: 'POST /orders', rate: 5}]},
    {id: 'gateway', kind: 'gateway', at: [1, .5], routing: {rules: [{id: 'premium-service', when: {policy: 'premium'}, action: {type: 'send', to: 'premium-api'}}], fallback: {type: 'send', to: 'shared-api'}}},
    ...['shared', 'premium'].map((tier, i) => ({id: `${tier}-api`, kind: 'service', at: [2, i * 1.5]})),
    {id: 'storage-router', kind: 'service', at: [3, .5], endpoints: {
      'POST /orders': {calls: [{op: 'upsert', table: 'orders', routing: {rules: [{id: 'premium-storage', when: {policy: 'premium'}, action: {type: 'send', to: 'premium-db'}}], fallback: {type: 'send', to: 'shared-db'}}}]},
    }},
    ...['shared', 'premium'].map((tier, i) => ({id: `${tier}-db`, kind: 'db', at: [4, i * 1.5], tables: {orders: {key: 'orderId'}}})),
  ],
  edges: [['app', 'gateway'], ['gateway', 'shared-api'], ['gateway', 'premium-api'], ['shared-api', 'storage-router'], ['premium-api', 'storage-router'], ['storage-router', 'shared-db'], {from: 'storage-router', to: 'premium-db', retries: 1}],
  scenario: {length: 30, loop: true, phases: [{at: 0, name: 'isolated tenants'}, {at: 10, name: 'premium database down'}, {at: 20, name: 'recovered'}], steps: [{at: 10, fail: 'premium-db'}, {at: 20, recover: 'premium-db'}]},
};
