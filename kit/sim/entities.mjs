import { createEntityCache } from './entity-cache.mjs';
import { freezeData } from './context.mjs';

// Owns entity identity and causal results. Transport still owns every call and failure.
function createEntities(sim, definitions) {
  const histories = new Map(), pending = new Map();
  let sequence = 0, operations = 0;
  const state = { definitions, histories, pending };
  sim.entityState = state;
  const keyOf = (type, scope, key) => JSON.stringify([type, scope, key]);
  const versionKey = (ref, representation) => JSON.stringify([ref.id,representation]);
  const resultKey = (type, step) => JSON.stringify([type, step]);
  function event(ref, data) {
    let history = histories.get(ref.id);
    if (!history) {
      if (histories.size >= 256) histories.delete(histories.keys().next().value);
      history = { ref, events: [], incomplete: true };
      histories.set(ref.id, history);
    }
    const entry = { id: ++sequence, at: sim.time, ...data };
    if (entry.outcome === 'committed' && entry.initialAuthority) history.incomplete = false;
    history.events.push(entry);
    if (history.events.length > 128) { history.events.shift(); history.incomplete = true; }
    // LRU without pinning unbounded history in the renderer.
    histories.delete(ref.id); histories.set(ref.id, history);
    return entry.id;
  }
  const caches = createEntityCache(sim, row => event(row.entity.ref, { node: row.node, representation: row.entity.representation, outcome: 'expired', parent: row.entity.cause, revision: row.entity.revision }));
  state.caches = caches.stores;
  const authority = def => Object.entries(def.representations).find(([,r]) => r.authoritative);
  function identity(msg, type, recordOf) {
    msg.entityRefs ??= {};
    if (msg.entityRefs[type]) return msg.entityRefs[type];
    const def = definitions[type];
    const scope = (def.scope || []).map(path => {
      let value = msg.context;
      for (const part of path.split('.').slice(1)) value = value && Object.hasOwn(value, part) ? value[part] : undefined;
      if (value == null || !['string','number','boolean'].includes(typeof value)) throw new Error(`entity ${type}: missing or nonscalar scope ${path}`);
      return value;
    });
    const record = recordOf(msg, def.record);
    const ref = freezeData({type, scope, key: record.key, id: keyOf(type, scope, record.key)});
    msg.entityRefs[type] = ref;
    return ref;
  }
  function mapped(fields, rep) {
    if (!rep.fields) return structuredClone(fields);
    const result = Object.create(null);
    for (const [name, mapping] of Object.entries(rep.fields)) {
      if (Object.hasOwn(mapping, 'value')) result[name] = structuredClone(mapping.value);
      else if (Object.hasOwn(fields, mapping.from)) result[name] = structuredClone(fields[mapping.from]);
    }
    return result;
  }
  function prepare(msg, binding, actor, recordOf) {
    const def = definitions[binding.entity], step = def.steps[binding.step];
    const ref = identity(msg, binding.entity, recordOf);
    const input = step.input?.step ? msg.entityResults?.[resultKey(binding.entity, step.input.step)] : step.input?.event ? msg.entityEvent?.name === step.input.event && msg.entityEvent.snapshot.ref.type === binding.entity ? msg.entityEvent.snapshot : null : null;
    const run = { id: ++operations, ref, step: binding.step, kind: step.kind, target: step.target, actor, request:msg.id, root:msg.rootId ?? msg.id, optional: !!binding.optional, input: input ? freezeData(structuredClone(input)) : null };
    run.invalid = !!step.input && !input;
    const fields = step.kind === 'write' ? recordOf(msg, def.record).fields : input?.fields || {};
    const rep = def.representations[step.target];
    run.record = { key:ref.id, fields: mapped(fields, rep || {}) };
    run.cause = event(ref, {operation:run.id, node:actor, step:run.step, outcome:'started', parent:input?.cause});
    pending.set(run.id, run);
    return run;
  }
  function note(run, outcome, extra = {}) {
    if (!run) return;
    return event(run.ref, {operation:run.id, request:run.request, root:run.root, step:run.step, node:run.actor, representation:run.target, parent:run.cause, outcome, ...extra});
  }
  function end(run, outcome, extra) { if (!run) return; note(run, outcome, extra); pending.delete(run.id); }
  function accept(msg, run, snapshot) {
    if (snapshot) { msg.entityResults ??= {}; msg.entityResults[resultKey(run.ref.type, run.step)] = snapshot; }
  }
  function metadata(run, revision, cause, deleted = false) {
    return {ref:run.ref, representation:run.target, revision, cause, deleted};
  }
  function committed(job, entry, row) {
    const run = job.op?.entityRun;
    if (!run) return;
    const revision = run.kind === 'write' ? entry.version : run.input.revision;
    const deleted = entry.op === 'delete';
    const cause = note(run, 'committed', { node:job.node.id, attempt:job.call?.attempt || 0, revision, localVersion:entry.version, ...(run.kind === 'write' && revision === 1 ? {initialAuthority:true} : {}) });
    entry.entity = metadata(run, revision, cause, deleted);
    if (row) row.entity = entry.entity;
    job.node.entityVersions ??= new Map(); job.node.entityVersions.set(versionKey(run.ref,run.target), entry.entity);
    job.entityResult = freezeData({ref:run.ref, revision, fields:structuredClone(row?.fields || {}), deleted, cause});
  }
  function before(job) {
    const run = job.op?.entityRun;
    if (!run) return null;
    const def = definitions[run.ref.type], rep = def.representations[run.target];
    if (run.kind === 'project') {
      const prior = job.node.entityVersions?.get(versionKey(run.ref,run.target));
      if (rep.versionPolicy === 'if-newer' && prior && prior.revision >= run.input.revision) {
        note(run,'older-or-duplicate', {node:job.node.id,revision:run.input.revision}); return true;
      }
      if (run.input.deleted) job.op = {...job.op, op:'delete'};
    }
    if (!run.kind.startsWith('cache-')) return null;
    const rows = caches.store(run.ref.type, run.target), row = rows.get(run.ref.id);
    if (run.kind === 'cache-get') {
      job.entityResult = row ? freezeData({ref:run.ref,fields:structuredClone(row.fields),revision:row.entity.revision,cause:row.entity.cause,deleted:false}) : null;
      note(run,row ? 'cache-hit' : 'cache-miss',{node:job.node.id,revision:row?.entity.revision});
    } else if (run.kind === 'cache-invalidate' || run.input?.deleted) {
      rows.delete(run.ref.id); note(run,'invalidated',{node:job.node.id});
    } else {
      const cause = note(run,'cache-filled',{node:job.node.id,revision:run.input.revision});
      const saved = {key:run.ref.key,fields:run.record.fields,node:job.node.id,entity:metadata(run,run.input.revision,cause),expiresAt:rep.ttl ? sim.time+rep.ttl : null};
      rows.set(run.ref.id,saved); job.entityResult = freezeData({...run.input,fields:structuredClone(saved.fields),cause});
    }
    return true;
  }
  function published(job, log, partition) {
    const run = job.op?.entityRun;
    if (!run || run.kind !== 'publish') return;
    const step = definitions[run.ref.type].steps[run.step];
    const cause = note(run,'published',{node:log.node.id,event:step.event,partition,offset:log.end[partition],revision:run.input.revision});
    job.msg.entityEvent = freezeData({name:step.event,snapshot:{...run.input,cause}});
    job.entityResult = job.msg.entityEvent.snapshot;
  }
  function read(job, row) {
    const run = job.op?.entityRun;
    if (!run) return;
    note(run,row ? 'read' : 'missing',{node:job.node.id,revision:row?.entity?.revision});
    if (row?.entity) job.entityResult = freezeData({ref:run.ref,revision:row.entity.revision,fields:structuredClone(row.fields),cause:row.entity.cause,deleted:false});
  }
  function applied(node, entry) {
    if (!entry.entity) return;
    node.entityVersions ??= new Map(); node.entityVersions.set(versionKey(entry.entity.ref,entry.entity.representation), entry.entity);
    event(entry.entity.ref,{node:node.id,outcome:'replicated',parent:entry.entity.cause,revision:entry.entity.revision});
  }
  sim.entityOf = ref => {
    if (!ref || !definitions[ref.type] || ref.id !== keyOf(ref.type,ref.scope,ref.key)) return null;
    const def = definitions[ref.type], [authorityName, primary] = authority(def);
    const node = sim.nodes.get(primary.node), source = node.store?.get(primary.table)?.rows.get(ref.id);
    const latest = node.entityVersions?.get(versionKey(ref,authorityName));
    function representationOf(name, rep) {
      const host = sim.nodes.get(rep.node);
      const replica = host.primary?.id === primary.node && rep.table === primary.table;
      const row = rep.cache ? caches.stores.get(JSON.stringify([ref.type,name]))?.get(ref.id) : host.store?.get(rep.table)?.rows.get(ref.id);
      const version = row?.entity || (!rep.cache && host.entityVersions?.get(versionKey(ref,replica ? authorityName : name)));
      const expected = source ? rep.authoritative ? source.fields : mapped(source.fields,rep) : {};
      const differences = [...new Set([...Object.keys(expected),...Object.keys(row?.fields || {})])].filter(k => JSON.stringify(expected[k]) !== JSON.stringify(row?.fields[k]));
      // An absent cache after a deletion already agrees with the authority.
      const behind = latest && !(rep.cache && latest.deleted && !row)
        ? !version || version.revision < latest.revision || (!!row === !!latest.deleted) : false;
      return {name,...rep,...(replica ? {replica:true} : {}),row:row || null,sourceRevision:version?.revision ?? null,behind:!!behind,differences};
    }
    const representations = Object.entries(def.representations).map(([name, rep]) => representationOf(name,rep));
    for (const host of sim.nodes.values()) if (host.primary?.id === primary.node && !representations.some(r=>r.node===host.id && r.table===primary.table)) {
      representations.push(representationOf(host.id,{node:host.id,table:primary.table}));
    }
    const queued = [];
    for (const log of sim.logs.values()) for (const [partition, envelopes] of (log.envelopes || []).entries()) {
      for (const [offset, envelope] of envelopes) if (envelope.entityEvent?.snapshot.ref.id === ref.id) {
        queued.push({node:log.node.id,partition,offset,event:envelope.entityEvent.name,groups:log.groups.filter(g=>g.committed[partition]<offset).map(g=>g.name)});
      }
    }
    const possible = Object.entries(def.steps).map(([name,step])=>({name,...step}));
    return structuredClone({ref,queued,possible,owner:def.owner,authority:authorityName,representations,history:histories.get(ref.id) || {ref,events:[],incomplete:true},pending:[...pending.values()].filter(r=>r.ref.id===ref.id).map(r=>({id:r.id,step:r.step,node:r.actor}))});
  };
  return { prepare, note, end, accept, committed, before, published, read, applied, expire:caches.expire };
}
export { createEntities };
