// Entity authoring is validated separately from transport and rendering.
export function validateEntities(spec) {
  if (!spec.entities) {
    if (spec.nodes.some(n=>Object.values(n.endpoints || {}).some(e=>e.calls?.some(c=>c.entityStep)))) throw new Error("spec entities: bindings require definitions");
    return;
  }
  const fail = message => { throw new Error(`spec entities: ${message}`); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const json = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(json) : object(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(json));
  const kinds = new Set(['write', 'read', 'publish', 'project', 'cache-get', 'cache-fill', 'cache-invalidate']);
  const nodes = new Map(spec.nodes.map(n => [n.id, n]));
  const tableAt = (node, table) => nodes.get(node)?.tables?.[table] || spec.edges.some(e=>!Array.isArray(e) && e.kind === 'replication' && e.to === node && nodes.get(e.from)?.tables?.[table]);
  if (!object(spec.entities)) fail('expected a definition map');
  for (const [name, def] of Object.entries(spec.entities)) {
    if (!object(def) || !spec.records?.[def.record]) fail(`${name} needs an existing record generator`);
    if (!nodes.has(def.owner)) fail(`${name} has an unknown owner`);
    if (!Array.isArray(def.scope || []) || (def.scope || []).some(p => typeof p !== 'string' || !/^context\.[\w.-]+$/.test(p) || p.split('.').some(k => ['__proto__','constructor','prototype'].includes(k)))) fail(`${name} has invalid scope paths`);
    if (!object(def.representations) || !object(def.steps)) fail(`${name} needs representations and steps`);
    if (Object.values(def.representations).filter(r => r.authoritative === true).length !== 1) fail(`${name} needs exactly one authoritative representation`);
    for (const [id, rep] of Object.entries(def.representations)) {
      if (!object(rep) || !nodes.has(rep.node)) fail(`${name}.${id} has an unknown node`);
      if (!!rep.table === !!rep.cache) fail(`${name}.${id} needs table or cache`);
      if (rep.table && !tableAt(rep.node,rep.table)) fail(`${name}.${id} has an unknown table`);
      if (rep.cache && !['cache','redis','elasticache'].includes(nodes.get(rep.node).kind)) fail(`${name}.${id} needs a cache node`);
      if (rep.authoritative && spec.edges.some(e => !Array.isArray(e) && e.kind === 'replication' && e.to === rep.node)) fail(`${name}.${id} authority cannot be a replica`);
      if (rep.authoritative && !rep.table) fail(`${name}.${id} authority must be a table`);
      if (rep.table && !rep.authoritative && !['arrival','if-newer'].includes(rep.versionPolicy)) fail(`${name}.${id} needs versionPolicy arrival or if-newer`);
      if (rep.ttl != null && (!Number.isFinite(rep.ttl) || rep.ttl <= 0)) fail(`${name}.${id} ttl must be positive`);
      if (rep.fields != null && !object(rep.fields)) fail(`${name}.${id} fields must be a map`);
      for (const mapping of Object.values(rep.fields || {})) {
        if (!object(mapping) || Object.keys(mapping).length !== 1 || !(typeof mapping.from === 'string' || Object.hasOwn(mapping, 'value'))) fail(`${name}.${id} mappings use {from: field} or {value: JSON}`);
        if (Object.hasOwn(mapping, 'value')) { try { if (!json(mapping.value)) fail('invalid constant'); } catch { fail(`${name}.${id} constant must be JSON`); } }
      }
      for (const owner of Object.values(rep.owners || {})) if (!nodes.has(owner)) fail(`${name}.${id} has an unknown field owner`);
    }
    for (const [id, step] of Object.entries(def.steps)) {
      if (!object(step) || !kinds.has(step.kind)) fail(`${name}.${id} has an unknown step kind`);
      const rep = def.representations[step.target];
      if (step.kind === 'publish') {
        if (typeof step.event !== 'string' || !step.event) fail(`${name}.${id} needs an event name`);
      } else if (!rep) fail(`${name}.${id} has an unknown representation`);
      if (step.kind === 'read' && !rep?.table) fail(`${name}.${id} reads need a table`);
      if (step.kind === 'write' && !rep?.authoritative) fail(`${name}.${id} must write the authority`);
      if (step.kind === 'project' && (!rep?.table || rep.authoritative)) fail(`${name}.${id} needs a projection table`);
      if (step.kind.startsWith('cache-') && !rep?.cache) fail(`${name}.${id} needs a cache representation`);
      if (['publish','project','cache-fill'].includes(step.kind) && !step.input) fail(`${name}.${id} needs input`);
      if (step.input) {
        if (!object(step.input) || Object.keys(step.input).length !== 1) fail(`${name}.${id} input uses step or event`);
        if (step.input.step && !def.steps[step.input.step]) fail(`${name}.${id} references an unknown step`);
        if (step.input.event && !Object.values(def.steps).some(s => s.kind === 'publish' && s.event === step.input.event)) fail(`${name}.${id} references an unknown event`);
        if (!step.input.step && !step.input.event) fail(`${name}.${id} needs a step or event input`);
      }
      const seen = new Set([id]); let current = step;
      while (current?.input?.step) {
        if (seen.has(current.input.step)) fail(`${name}.${id} has cyclic step inputs`);
        seen.add(current.input.step); current = def.steps[current.input.step];
      }
    }
  }
  for (const node of spec.nodes) for (const endpoint of Object.values(node.endpoints || {})) {
    const ids = new Set(), bindings = new Set();
    for (const call of endpoint.calls || []) {
      if (!call.entityStep) continue;
      const binding = call.entityStep, def = spec.entities[binding.entity], step = def?.steps[binding.step];
      if (!step) fail(`${node.id} binds an unknown entity step`);
      if (typeof call.id !== 'string' || !call.id || ids.has(call.id)) fail(`${node.id} entity calls need unique ids per endpoint`);
      ids.add(call.id);
      const key = JSON.stringify([binding.entity,binding.step]);
      if (bindings.has(key)) fail(`${node.id} binds the same entity step twice in one endpoint; use distinct steps`);
      bindings.add(key);
      if (binding.optional != null && typeof binding.optional !== 'boolean') fail(`${call.id} optional must be boolean`);
      const actions = call.routing ? [...call.routing.rules.map(r=>r.action),call.routing.fallback] : [{type:'send',to:call.to}];
      const targets = actions.flatMap(a => a.type === 'send' ? [a.to] : a.type === 'weighted' ? a.targets.map(t=>t.to) : []);
      const rep = def.representations[step.target];
      for (const to of targets) {
        if (step.kind === 'publish' ? !['kafka','queue'].includes(nodes.get(to)?.kind) : to !== rep.node) fail(`${call.id} destination does not match its step`);
      }
      if (rep?.table && (call.table !== rep.table || (['read'].includes(step.kind) ? call.op !== 'select' : !['insert','update','upsert','delete','rmw'].includes(call.op)))) fail(`${call.id} table operation does not match its step`);
      if (!rep?.table && (call.op || call.table)) fail(`${call.id} cache/publish calls must not declare table operations`);
    }
  }
}
