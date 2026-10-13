// Presentation-only traffic controls. No simulation inputs, clocks or random draws change.
trafficDisplay = (() => {
  const definitions = DATA.traffic;
  const ids = Object.keys(definitions);
  const palette = ['cyan', 'blue', 'violet', 'magenta', 'teal', 'lime'];
  const selected = new Set();
  let mode = DATA.colorBy || 'traffic';
  const host = document.createElement('section');
  host.className = 'tp-traffic';
  host.setAttribute('aria-label', 'Traffic display');
  const controls = document.createElement('div');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Color packets by');
  const modes = new Map();
  for (const value of ['traffic', 'activity', 'none']) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = value[0].toUpperCase() + value.slice(1);
    button.dataset.colorBy = value;
    button.addEventListener('click', () => setMode(value));
    modes.set(value, button); controls.append(button);
  }
  host.append(controls);
  const legend = document.createElement('div');
  legend.className = 'tp-traffic-legend';
  legend.setAttribute('role', 'group'); legend.setAttribute('aria-label', 'Filter traffic classes; none selected shows all');
  const buttons = new Map();
  const colorOf = id => definitions[id]?.color || palette[Math.max(0, ids.indexOf(id)) % palette.length];
  for (const id of [...ids, null]) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.traffic = id ?? '';
    const swatch = document.createElement('i');
    swatch.style.background = id == null ? 'var(--tp-mid)' : `var(--traffic-${colorOf(id)})`;
    const label = document.createElement('span'); label.textContent = definitions[id]?.label || id || 'Unclassified';
    const rate = document.createElement('small');
    button.append(swatch, label, rate); button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      button.setAttribute('aria-pressed', String(selected.has(id))); update(); drawPackets();
    });
    buttons.set(id, {button, rate}); legend.append(button);
  }
  host.append(legend);
  const note = document.createElement('p'); note.className = 'tp-ins-note';
  note.textContent = 'Source emissions/s · select classes to follow their observed paths. ○ response · □ record · ◇ replication · amber outline retry · × error';
  host.append(note); stage.before(host);
  function setMode(value) {
    if (!modes.has(value)) return;
    mode = value; stage.dataset.colorBy = value;
    const activityKeys = document.querySelector('.k-keys');
    if (activityKeys) activityKeys.hidden = value !== 'activity';
    for (const [key, button] of modes) button.setAttribute('aria-pressed', String(key === value));
    drawPackets();
  }
  function matchesPacket(packet) {
    const msg = packet.msg || packet.call?.job.msg;
    return !selected.size || selected.has(msg?.traffic ?? null);
  }
  function paint(slot, packet) {
    const id = (packet.msg || packet.call?.job.msg)?.traffic;
    slot.g.style.setProperty('--traffic', id == null ? 'var(--tp-mid)' : `var(--traffic-${colorOf(id)})`);
  }
  function update() {
    const rates = new Map(sim.trafficOf().map(c => [c.id, c.rate]));
    for (const [id, {button, rate}] of buttons) {
      button.hidden = id == null && !rates.has(null) && !selected.has(null);
      rate.textContent = `${(rates.get(id) || 0).toFixed(1)}/s`;
    }
    const paths = new Set(sim.trafficState.paths.filter(p => !selected.size || selected.has(p.traffic)).map(p => p.edge));
    stage.toggleAttribute('data-traffic-filter', selected.size > 0);
    for (const v of viewList) v.edges.forEach((el, index) => el.toggleAttribute('data-traffic-path', paths.has(index)));
  }
  let clock = 0;
  hooks.tick.push(dt => { clock += dt; if (clock >= .25) { clock = 0; update(); } });
  setMode(mode); update();
  const api = {paint, matches: matchesPacket, get selected() {return [...selected];}, setMode, get mode() {return mode;}};
  window.__topo.traffic = api;
  return api;
})();
