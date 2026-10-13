import journey from '../order-journey/order-journey.spec.mjs';
export default {
  ...journey,
  title:'Flagged projection rollout',fig:'Entity 2',
  caption:'Synthetic order commits continue while an optional search projection is disabled. Each operation retains flags already evaluated across retries and event delivery; a flag first encountered by the consumer uses the effective rollout at that moment. Killing the flag skips new projection decisions without undoing admitted writes. The entity history distinguishes flag-skipped work from failures and lag. This is dispatch-offset simulation, not exactly-once delivery.',
  flags:{search:{rollout:1,sticky:true}},
  edges:journey.edges.map(e=>Array.isArray(e)&&e[0]==='worker'&&e[1]==='search'?{from:'worker',to:'search',flag:'search'}:e),
  scenario:{length:36,loop:true,phases:[{at:0,name:'projection enabled'},{at:12,name:'projection disabled'},{at:24,name:'enabled again'}],steps:[{at:12,kill:'search'},{at:24,flag:'search',rollout:1}]},
};
