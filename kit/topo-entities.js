// Entity disclosure reads detached snapshots, never mutable stores or flag evaluators.
(() => {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const panel = document.querySelector('.tp-inspect');
  let selected = null;

  function copyHtml(copy) {
    const version = copy.row ? `source v${copy.sourceRevision}${copy.row.version ? ` · local v${copy.row.version}` : ''}` : 'not present';
    const fields = Object.entries(copy.row?.fields || {}).map(([name, value]) =>
      `<dt>${esc(name)}</dt><dd>${esc(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`).join('');
    return `<div class="tp-record-copy"${copy.behind ? ' data-behind' : ''}>
      <b>${esc(copy.name)}</b> at ${esc(copy.node)} · ${version}${copy.behind ? ' · behind' : ''}
      ${fields ? `<dl aria-label="Saved ${esc(copy.name)} fields">${fields}</dl>` : '<small>No saved fields</small>'}
      ${copy.differences.length ? `<small>Different fields: ${esc(copy.differences.join(', '))}</small>` : ''}
      ${copy.owners ? `<small>Declared field owners: ${esc(JSON.stringify(copy.owners))}</small>` : ''}
    </div>`;
  }
  function eventHtml(event) {
    return `<div class="tp-entity-event">#${event.id} · ${event.at.toFixed(2)}s · ${esc(event.node || '')} · ${esc(event.step || '')} · <b>${esc(event.outcome)}</b>
      ${event.event ? ` · ${esc(event.event)} [${event.partition}:${event.offset}]` : ''}
      ${event.revision != null ? ` · source v${event.revision}` : ''}
      ${event.operation ? ` · operation ${event.operation}` : ''}
      ${event.attempt != null ? ` · attempt ${event.attempt + 1}` : ''}
      ${event.parent ? ` · caused by #${event.parent}` : ''}
      ${event.flags && Object.keys(event.flags).length ? `<small>Flag decisions ${esc(JSON.stringify(event.flags))}</small>` : ''}
    </div>`;
  }
  function section() {
    if (!selected) return '';
    const entity = sim.entityOf(selected);
    if (!entity) return '';
    const {history, representations, pending, queued, possible, owner, ref} = entity;
    const following = entityFilter === ref.id;
    return `<section class="tp-entity">
      <header><strong>${esc(ref.type)} / ${esc(ref.key)}</strong>
        <button type="button" data-follow-entity aria-pressed="${following}">${following ? 'Stop following' : 'Follow entity'}</button>
        <button type="button" data-close-entity aria-label="Close entity">×</button></header>
      <p class="tp-ins-note">Scope ${esc(JSON.stringify(ref.scope))} · declared owner ${esc(owner)} · ${pending.length} pending calls · ${queued.length} queued events${history.incomplete ? ' · partial retained history' : ''}</p>
      <div class="tp-record-copies">${representations.map(copyHtml).join('')}</div>
      <details><summary>Possible steps (${possible.length})</summary>
        ${possible.map(step => `<div>${esc(step.name)} · ${esc(step.kind)} → ${esc(step.target || step.event)}</div>`).join('')}
      </details>
      ${pending.length ? `<p class="tp-ins-note">In flight: ${pending.map(item => `${esc(item.node)} / ${esc(item.step)} (#${item.id})`).join('; ')}</p>` : ''}
      ${queued.length ? `<p class="tp-ins-note">Waiting for dispatch: ${queued.map(item => `${esc(item.node)} / ${esc(item.groups.join(', '))}`).join('; ')}</p>` : ''}
      <details open><summary>Observed causal history (${history.events.length} retained)</summary>${history.events.map(eventHtml).join('')}</details>
    </section>`;
  }
  function clear() { selected = null; entityFilter = null; }
  inspector.sections.push(section);
  panel.addEventListener('click', event => {
    const row = event.target.closest('[data-entity-ref]');
    if (row) { selected = JSON.parse(row.dataset.entityRef); entityFilter = null; }
    else if (event.target.closest('[data-follow-entity]') && selected) {
      const following = entityFilter === selected.id;
      window.__topo.tracer?.stop(); recordFilter = null; routeFilter = null;
      entityFilter = following ? null : selected.id;
    } else if (event.target.closest('[data-close-entity]')) clear();
    else return;
    inspector.render();
  });
  hooks.reset.push(clear);
  hooks.select.push(clear);
  hooks.tick.push(() => { if (!inspector.open) clear(); });
  window.__topo.entities = {
    select(ref, node) { inspector.show(node); selected = ref; inspector.render(); },
    get selected() { return selected; },
  };
})();
