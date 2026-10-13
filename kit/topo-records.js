// Saved-record disclosure. Reads the actual store/WAL; it never creates or edits data.
const recordInspector = (() => {
  const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const panel = document.querySelector(".tp-inspect");
  let selected = null;
  const text = (value) => typeof value === "object" ? JSON.stringify(value) : String(value);

  function section(id) {
    if (!selected || selected.node !== id) return "";
    const { table, key } = selected;
    const record = sim.recordOf(id, table, key);
    if (!record) return "";
    const { row, latest, copies, keyName } = record;
    const following = recordFilter?.table === table && recordFilter.key === key;
    const fields = row ? [[keyName, key], ...Object.entries(row.fields).filter(([name]) => name !== keyName)] : [];
    const identifier = value => '"' + String(value).replace(/"/g, '""') + '"';
    const query = `SELECT * FROM ${identifier(table)} WHERE ${identifier(keyName)} = ${key};`;
    const rows = fields.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(text(value))}</dd>`).join("");
    const copyRows = copies.map(copy => {
      const { row: saved, latest: entry, behind } = copy;
      return `<div class="tp-record-copy" data-copy="${esc(copy.id)}"${behind ? " data-behind" : ""}><b>${esc(copy.label)}</b> · ${saved ? `v${saved.version}` : "not present"}${behind ? " · behind" : ""}<small>${saved ? esc(Object.entries(saved.fields).map(([k, v]) => `${k}: ${text(v)}`).join(" · ")) || "no fields" : "No saved row at this node"}</small><small>${entry ? `last retained ${esc(entry.op)} · lsn ${entry.lsn} · v${entry.version}` : "No retained WAL entry for this key"}</small></div>`;
    }).join("");
    return `<section class="tp-record" data-record-key="${esc(key)}"><header><strong>${esc(table)} · ${esc(keyName)} ${esc(key)}</strong><button type="button" data-follow-record aria-pressed="${following}">${following ? "Stop following writes" : "Follow writes"}</button><button type="button" data-close-record aria-label="Close record">×</button></header><pre class="tp-record-query">${esc(query)}</pre><p class="tp-ins-note">${row ? `1 saved row · version ${row.version} · all ${fields.length} fields` : "0 saved rows"} · read-only view of simulated storage</p><dl aria-label="Saved record fields">${rows}</dl><p class="tp-ins-note">Saved at ${esc(record.label)}. ${latest ? `Latest retained primary write: ${esc(latest.op)} v${latest.version}, lsn ${latest.lsn}, at ${latest.at.toFixed(2)}s.` : "No primary write for this key remains in the bounded WAL history."}</p><div class="tp-record-copies">${copyRows}</div><p class="tp-ins-note">${following ? "Following this key: its packets stay bright; saved versions and WAL entries update here as workload writes arrive." : "Select Follow writes to keep this key in view as traffic saves and replicates it."}</p></section>`;
  }

  inspector.sections.push(section);
  panel.addEventListener("click", event => {
    const row = event.target.closest("button.tp-row[data-table]");
    if (row) {
      selected = { node: inspector.open, table: row.dataset.table, key: Number(row.dataset.key) };
      recordFilter = null;
    } else if (event.target.closest("[data-follow-record]") && selected) {
      if (recordFilter) recordFilter = null;
      else {
        if (typeof tracer !== "undefined") tracer.stop();
        routeFilter = null;
        recordFilter = { table: selected.table, key: selected.key };
      }
    } else if (event.target.closest("[data-close-record]")) {
      selected = null;
      recordFilter = null;
    } else return;
    inspector.render();
  });
  hooks.select.push(() => { selected = null; recordFilter = null; });
  window.__topo.records = { get selected() { return selected; }, get following() { return recordFilter; } };
  return { section };
})();
