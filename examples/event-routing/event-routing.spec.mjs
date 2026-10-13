// Consumer assignment still belongs to Kafka. Consumers route using the event context.
export default {
  title: 'Event routing', fig: 'Routing 2', grid: [150, 95],
  caption: 'Synthetic purchase and audit events share one Kafka topic. The consumer inherits each event’s class, context and root request, then selects its sink. During the consumer outage, the topic retains context with the backlog. Follow a request to see the asynchronous journey; offsets represent dispatch, not durable acknowledgments.',
  traffic: {purchase: {label: 'Purchase', color: 'teal', context: {event: 'purchase'}}, audit: {label: 'Audit', color: 'magenta', context: {event: 'audit'}}},
  nodes: [
    {id: 'producer', kind: 'service', at: [0, .5], workload: [{traffic: 'purchase', endpoint: 'POST /events', rate: 6}, {traffic: 'audit', endpoint: 'POST /events', rate: 3}]},
    {id: 'events', kind: 'kafka', partitions: 3, at: [1, .5]},
    {id: 'consumer', kind: 'worker', at: [2, .5], rate: 30, routing: {rules: [{id: 'purchases', when: {field: 'context.event', eq: 'purchase'}, action: {type: 'send', to: 'billing'}}], fallback: {type: 'send', to: 'audit-log'}}},
    {id: 'billing', kind: 'service', at: [3, 0]},
    {id: 'audit-log', kind: 'storage', at: [3, 1.5]},
  ],
  edges: [['producer', 'events'], {from: 'events', to: 'consumer', group: 'dispatch'}, ['consumer', 'billing'], ['consumer', 'audit-log']],
  scenario: {length: 30, loop: true, phases: [{at: 0, name: 'mixed events'}, {at: 10, name: 'consumer down'}, {at: 18, name: 'drain backlog'}], steps: [{at: 10, fail: 'consumer'}, {at: 18, recover: 'consumer'}]},
};
