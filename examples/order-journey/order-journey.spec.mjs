export default {
  title: 'One order, several representations', fig: 'Entity 1', grid: [150, 100],
  caption: 'Synthetic orders are scoped by tenant. A committed write publishes a snapshot; a consumer projects it into search and fills a cache. During the consumer outage, the primary and replica advance while derived copies lag. Click a saved row to follow its actual causal history. Cache entries expire after six simulated seconds. Kafka offsets represent dispatch, not durable acknowledgment; publication is not atomic with the database write.',
  traffic: {north:{label:'North',color:'cyan',context:{tenant:'north'}},south:{label:'South',color:'violet',context:{tenant:'south'}}},
  records: {orders:{key:'orderId',keys:3,fields:{status:['new','paid','shipped'],total:[20,40,80]}}},
  entities: {order:{record:'orders',scope:['context.tenant'],owner:'api',representations:{
    primary:{node:'pg',table:'orders',authoritative:true},
    search:{node:'search',table:'documents',versionPolicy:'if-newer',fields:{state:{from:'status'},amount:{from:'total'}},owners:{state:'api',amount:'api'}},
    cache:{node:'redis',cache:'orders',ttl:6},
  },steps:{
    save:{kind:'write',target:'primary'},
    publish:{kind:'publish',event:'order.saved',input:{step:'save'}},
    index:{kind:'project',target:'search',input:{event:'order.saved'}},
    fill:{kind:'cache-fill',target:'cache',input:{event:'order.saved'}},
  }}},
  nodes:[
    {id:'app',kind:'client',at:[0,.5],workload:[{traffic:'north',endpoint:'PUT /orders',rate:2},{traffic:'south',endpoint:'PUT /orders',rate:1}]},
    {id:'api',kind:'service',at:[1,.5],endpoints:{'PUT /orders':{calls:[
      {id:'save',to:'pg',op:'upsert',table:'orders',entityStep:{entity:'order',step:'save'}},
      {id:'publish',to:'events',then:true,entityStep:{entity:'order',step:'publish'}},
    ]}}},
    {id:'pg',kind:'db',at:[2,-.5],tables:{orders:{key:'orderId'}}},
    {id:'replica',kind:'db',at:[3,-.5],lag:.5},
    {id:'events',kind:'kafka',at:[2,1.5],partitions:2},
    {id:'worker',kind:'worker',at:[3,1.5],rate:20,endpoints:{'PUT /orders':{calls:[
      {id:'index',to:'search',op:'upsert',table:'documents',entityStep:{entity:'order',step:'index',optional:true}},
      {id:'fill',to:'redis',entityStep:{entity:'order',step:'fill',optional:true}},
    ]}}},
    {id:'search',kind:'db',at:[4,.5],tables:{documents:{key:'orderId'}}},
    {id:'redis',kind:'redis',at:[4,2]},
  ],
  edges:[['app','api'],['api','pg'],['api','events'],{from:'pg',to:'replica',kind:'replication'},{from:'events',to:'worker',group:'views'},['worker','search'],['worker','redis']],
  scenario:{length:36,loop:true,phases:[{at:0,name:'copies converge'},{at:12,name:'consumer paused'},{at:22,name:'catch up'}],steps:[{at:12,fail:'worker'},{at:22,recover:'worker'}]},
};
