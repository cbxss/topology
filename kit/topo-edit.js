// Drag-to-arrange, inlined after topo-live.js only on serve.mjs's ?edit pages.
// Drag a node in the 2D view; on release it snaps to a quarter grid cell and every node's
// position is POSTed to the server, which writes <name>.layout.json and reloads the page.
(() => {
  setView("flat");
  const v = views.flat;
  const k = DATA.views.flat.k;
  const [gx, gy] = DATA.grid;
  const positions = JSON.parse(JSON.stringify(DATA.positions));
  const snap = (n) => Math.round(n * 4) / 4;
  let drag = null;
  stage.setAttribute("data-edit", "");
  const style = document.createElement("style");
  style.textContent = `.tp-stage[data-edit] .tp-flat .tp-node{cursor:grab}.tp-stage[data-edit] .tp-node[data-dragging]{cursor:grabbing;opacity:.85}.tp-stage[data-edit] .tp-flat{outline:1px dashed var(--tp-amber);outline-offset:4px}`;
  document.head.appendChild(style);

  const toSvg = (event) => {
    const point = v.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(v.svg.getScreenCTM().inverse());
  };
  // In edit mode a click arranges; it never fails a node.
  stage.addEventListener("click", (event) => event.stopPropagation(), true);

  v.svg.addEventListener("pointerdown", (event) => {
    const el = event.target.closest("[data-node]");
    if (!el) return;
    event.preventDefault();
    v.svg.setPointerCapture(event.pointerId);
    drag = { id: el.dataset.node, el, label: v.labels.get(el.dataset.node), start: toSvg(event), cols: 0, rows: 0 };
    el.setAttribute("data-dragging", "");
  });
  v.svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const at = toSvg(event);
    drag.cols = snap((at.x - drag.start.x) / k / gx);
    drag.rows = snap((at.y - drag.start.y) / k / gy);
    const move = `translate(${(drag.cols * gx * k).toFixed(1)} ${(drag.rows * gy * k).toFixed(1)})`;
    drag.el.setAttribute("transform", move);
    drag.label?.setAttribute("transform", move);
    if (readoutText) readoutText.textContent = `${drag.id} → [${(positions[drag.id][0] + drag.cols).toFixed(2)}, ${(positions[drag.id][1] + drag.rows).toFixed(2)}]`;
  });
  const drop = async () => {
    if (!drag) return;
    const { id, cols, rows, el } = drag;
    drag = null;
    el.removeAttribute("data-dragging");
    if (!cols && !rows) return;
    positions[id] = [positions[id][0] + cols, positions[id][1] + rows];
    const reply = await fetch(location.pathname.replace(/^\/s\//, "/layout/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: positions }) });
    if (!reply.ok && readoutText) readoutText.textContent = `save failed: ${await reply.text()}`;
  };
  v.svg.addEventListener("pointerup", drop);
  v.svg.addEventListener("pointercancel", drop);
})();
