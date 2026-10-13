// Run the generated, self-contained HTML in Chrome and compare it with versioned release
// checkpoints and Node. Also exercise real inspector, record, trace and story controls.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildPage, loadSpec} from './page.mjs';
import {openBrowser, sleep} from './browser.mjs';
import {createSim} from '../kit/topo-sim.mjs';
import {observeSim, replayCase} from '../tests/helpers/sim-observation.mjs';

import { cases } from '../tests/helpers/release-cases.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = mkdtempSync(join(tmpdir(), 'topology-parity-'));
const browser = await openBrowser({scale: 1, preload: 'window.__topoSpeed = 0;'});
const raw = new Map();
const errors = browser.errors;
async function load(name, features = '') {
  if (!raw.has(name)) raw.set(name, await loadSpec(new URL(`../examples/${name}/${name}.spec.mjs`, import.meta.url).pathname));
  let {html} = buildPage(raw.get(name), {featureLayers: [features]});
  // Verification-only hook; never shipped in generated examples. It uses the actual
  // factory already embedded by buildPage, not a separately loaded engine.
  const hook = `\nwindow.__simVerification = { createSim, observeSim: ${observeSim.toString()}, replayCase: ${replayCase.toString()} };\n`;
  html = html.replace('</script>', hook + '</script>');
  const file = join(directory, 'page.html');
  writeFileSync(file, html);
  await browser.goto(file);
  assert.equal(await browser.eval('!!window.__simVerification && !!window.__topo'), true);
  assert.equal(await browser.eval('performance.getEntriesByType("resource").filter(e => /^https?:/.test(e.name)).length'), 0);
  assert.deepEqual(errors, []);
}
async function evaluate(fn, argument) {
  return browser.eval(`(${fn.toString()})(${JSON.stringify(argument)})`);
}
async function until(expression) {
  for (let i = 0; i < 200; i++) {
    if (await browser.eval(expression)) return;
    await sleep(25);
  }
  throw new Error(`browser condition timed out: ${expression}`);
}
try {
  let count = 0;
  for (const item of cases) {
    await load(item.name, item.features);
    const node = [];
    replayCase(createSim, item, sim => node.push(digest(observeSim(sim))));
    const result = await evaluate(async item => {
      const {createSim, observeSim, replayCase} = window.__simVerification;
      const states = [];
      replayCase(createSim, item, sim => states.push(JSON.stringify(observeSim(sim))));
      return Promise.all(states.map(async state => {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
        return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
      }));
    }, item);
    assert.deepEqual(result, node, `${item.name} ${item.features}: browser/Node`);
    assert.deepEqual(result, item.expected.map(e => e.sha256), `${item.name} ${item.features}: release baseline`);
    if (++count % 6 === 0) console.log(`browser parity: ${item.name} (6 configurations)`);
  }

  await load('orders-api');
  await browser.eval('for(let i=0;i<900;i++) window.__topo.sim.step(1/60); window.__topo.select("replica");');
  await until('document.querySelector("button.tp-row") !== null');
  await browser.eval('document.querySelector("button.tp-row").click()');
  const selected = await browser.eval('window.__topo.records.selected');
  assert.equal(selected.table, 'orders');
  assert.equal(await browser.eval('document.querySelector(".tp-record dt").textContent'), 'orderId');
  assert.equal(await browser.eval('Array.from(document.querySelectorAll(".tp-record dt")).some(el => el.textContent === "status")'), true);
  const savedFields = await browser.eval(`(() => {
    const {node, table, key} = window.__topo.records.selected;
    const store = window.__topo.sim.nodes.get(node).store.get(table);
    return [[store.key, String(key)], ...Object.entries(store.rows.get(key).fields).map(([k,v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])];
  })()`);
  assert.ok(savedFields.length >= 8);
  assert.deepEqual(await browser.eval('Array.from(document.querySelectorAll(".tp-record dt")).map(el => [el.textContent, el.nextElementSibling.textContent])'), savedFields);
  assert.equal(await browser.eval('document.querySelector(".tp-record-query").textContent'), `SELECT * FROM "orders" WHERE "orderId" = ${selected.key};`);

  await browser.eval('document.querySelector("[data-follow-record]").click()');
  assert.deepEqual(await browser.eval('window.__topo.records.following'), {table: 'orders', key: selected.key});
  const originalVersion = await browser.eval(`window.__topo.sim.nodes.get('pg').store.get('orders').rows.get(${selected.key}).version`);
  const updates = await evaluate(key => {
    const sim = window.__topo.sim;
    const start = sim.nodes.get('pg').store.get('orders').rows.get(key).version;
    let elapsed = 0;
    while (elapsed++ < 120 * 60 && (sim.nodes.get('pg').store.get('orders').rows.get(key).version <= start || sim.nodes.get('replica').store.get('orders').rows.get(key)?.version !== sim.nodes.get('pg').store.get('orders').rows.get(key).version)) sim.step(1/60);
    return [sim.nodes.get('pg').store.get('orders').rows.get(key), sim.nodes.get('replica').store.get('orders').rows.get(key)];
  }, selected.key);
  assert.ok(updates[0].version > originalVersion, 'selected key receives another real write');
  assert.equal(updates[0].version, updates[1].version);
  assert.deepEqual(updates[0].fields, updates[1].fields);
  await sleep(300);
  assert.equal(await browser.eval('document.querySelector(".tp-record").dataset.recordKey'), String(selected.key));
  assert.ok((await browser.eval('document.querySelector(".tp-record-copy[data-copy=replica]").textContent')).includes(`v${updates[1].version}`));
  await browser.eval('document.querySelector("[data-close-record]").click()');
  assert.equal(await browser.eval('window.__topo.records.following'), null);
  await browser.eval('document.querySelector(".tp-ins-fail").click()');
  assert.equal(await browser.eval('window.__topo.sim.nodes.get("replica").up'), false);
  await browser.eval('document.querySelector(".tp-ins-fail").click()');
  assert.equal(await browser.eval('window.__topo.sim.nodes.get("replica").up'), true);

  await load('read-your-writes');
  await browser.eval('window.__topo.story.seek(15); window.__topo.select("api"); document.querySelector(".tp-route[data-route]").click(); document.querySelector(".tp-ins-follow").click();');
  assert.equal(await browser.eval('document.querySelector(".tp-trace").hidden'), false);
  await browser.eval('for(let i=0;i<900 && !window.__topo.sim.tracing.done;i++) window.__topo.sim.step(1/60);');
  assert.equal(await browser.eval('window.__topo.sim.tracing.spans.some(s => s.label.includes("(stale)"))'), true);
  await browser.eval('window.__topo.story.seek(5);');
  assert.equal(await browser.eval('window.__topo.tracer.active'), false);
  assert.ok(Math.abs(await browser.eval('window.__topo.sim.time') - 5) < 1e-8);
  await browser.eval('window.__topo.select("replica"); document.querySelector(".tp-ins-fail").click();');
  assert.equal(await browser.eval('window.__topo.story.mode'), 'free');
  await browser.eval('window.__topo.setView("flat");');
  await until('window.__topo.view === "flat" && !window.__topo.morphing');
  await browser.eval('window.__topo.setView("iso");');
  await until('window.__topo.view === "iso" && !window.__topo.morphing');

  await load('data-stores');
  await browser.eval('for(let i=0;i<900;i++) window.__topo.sim.step(1/60); window.__topo.select("items"); document.querySelector("button.tp-row").click();');
  assert.equal(await browser.eval('document.querySelector(".tp-inspect .tp-ins-kind").textContent'), 'dynamodb');
  assert.equal(await browser.eval('document.querySelector(".tp-record dt").textContent'), 'itemId');
  await browser.eval('document.querySelector("[data-follow-record]").click();');
  assert.equal(await browser.eval('window.__topo.records.following.table'), 'items');
  await browser.eval('window.__topo.setView("flat");');
  await until('window.__topo.view === "flat" && !window.__topo.morphing');
  await browser.eval('window.__topo.setView("iso");');
  await until('window.__topo.view === "iso" && !window.__topo.morphing');

  // A second domain proves field disclosure is schema-driven, including falsy and nested values.
  raw.set('record-schema', {
    records: { profiles: { key: 'userId', keys: 1, fields: {
      enabled: [false], quota: [0], nickname: [null], preferences: [{digest: ['weekly']}],
      version: ['user field'], note: ['<b>literal & text</b>'],
    } } },
    nodes: [
      {id: 'app', kind: 'client', emit: {'PUT /profile': 3}},
      {id: 'api', kind: 'service', endpoints: {'PUT /profile': {calls: [{to: 'db', op: 'upsert', table: 'profiles'}]}}},
      {id: 'db', kind: 'db', tables: {profiles: {key: 'userId'}}},
    ],
    edges: [['app', 'api'], ['api', 'db']],
  });
  await load('record-schema');
  await browser.eval('for(let i=0;i<600;i++) window.__topo.sim.step(1/60); window.__topo.select("db"); document.querySelector("button.tp-row").click();');
  assert.deepEqual(await browser.eval('Array.from(document.querySelectorAll(".tp-record dt")).map(el => [el.textContent, el.nextElementSibling.textContent])'), [
    ['userId', '1000'], ['enabled', 'false'], ['quota', '0'], ['nickname', 'null'],
    ['preferences', '{"digest":["weekly"]}'], ['version', 'user field'], ['note', '<b>literal & text</b>'],
  ]);
  assert.equal(await browser.eval('document.querySelector(".tp-record dd b")'), null);

  for (const name of ['tenant-routing', 'event-routing']) {
    await load(name);
    const input = await browser.eval('window.__topo.data.spec');
    const reference = createSim(input);
    reference.events.length = 0; reference.quiet = true; reference.follow();
    for (let i = 0; i < 1500; i++) reference.step(1/60);
    const browserState = await browser.eval(`(() => { const s=window.__topo.sim; s.events.length=0; s.quiet=true; s.follow(); for(let i=0;i<1500;i++) s.step(1/60); return window.__simVerification.observeSim(s); })()`);
    assert.deepEqual(browserState, JSON.parse(JSON.stringify(observeSim(reference))), `${name}: new routing browser/Node parity`);
    const before = await browser.eval('JSON.stringify(window.__simVerification.observeSim(window.__topo.sim))');
    await browser.eval(`for (const mode of ['activity','none','traffic']) window.__topo.traffic.setMode(mode); document.querySelector('.tp-traffic-legend button').click();`);
    assert.equal(await browser.eval('JSON.stringify(window.__simVerification.observeSim(window.__topo.sim))'), before, 'display controls do not mutate simulation');
    await until('document.querySelector(".tp-stage").hasAttribute("data-traffic-filter")');
    await browser.eval('window.__topo.tracer.follow(); for(let i=0;i<240;i++) window.__topo.sim.step(1/60);');
    await until('document.querySelector(".tp-tr-context") !== null');
    assert.ok(await browser.eval('document.querySelector(".tp-decision") !== null'));
    if (name === 'event-routing') assert.ok(await browser.eval('window.__topo.sim.tracing.spans.some(s => s.node === "consumer")'));
    await browser.eval('window.__topo.tracer.stop(); window.__topo.setView("flat")');
    await until('window.__topo.view === "flat" && !window.__topo.morphing');
    await browser.eval('window.__topo.setView("iso")');
    await until('window.__topo.view === "iso" && !window.__topo.morphing');
    assert.deepEqual(errors, []);
  }
  console.log('routing browser parity, class controls, asynchronous tracing and both views passed');

  for (const name of ['order-journey','flagged-projection-rollout']) {
    await load(name);
    await browser.eval('window.__topo.story.seek(18); window.__topo.select("pg");');
    const reference = createSim(await browser.eval('window.__topo.data.spec'));
    for (let i=0;i<1080;i++) reference.step(1/60);
    const expected = [...reference.entityState.histories.values()].map(h=>reference.entityOf(h.ref));
    assert.deepEqual(await browser.eval('[...window.__topo.sim.entityState.histories.values()].map(h=>window.__topo.sim.entityOf(h.ref))'),JSON.parse(JSON.stringify(expected)),`${name}: entity browser/Node parity`);
    await until('document.querySelector("[data-entity-ref]") !== null');
    await browser.eval('document.querySelector("[data-entity-ref]").click()');
    assert.ok(await browser.eval('window.__topo.entities.selected'));
    assert.equal(await browser.eval('document.querySelectorAll(".tp-entity .tp-record-copy").length'),4);
    const before = await browser.eval('JSON.stringify(window.__topo.sim.entityOf(window.__topo.entities.selected))');
    await browser.eval('document.querySelector("[data-follow-entity]").click()');
    assert.equal(await browser.eval('document.querySelector("[data-follow-entity]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await browser.eval('JSON.stringify(window.__topo.sim.entityOf(window.__topo.entities.selected))'),before);
    await browser.eval('window.__topo.setView("flat")');
    await until('window.__topo.view === "flat" && !window.__topo.morphing');
    await browser.eval('window.__topo.story.seek(28)');
    assert.equal(await browser.eval('window.__topo.entities.selected'),null);
    assert.deepEqual(errors, []);
  }
  for (const feature of ['-entities','-tables','-endpoints','-trace','-flags']) {
    await load('order-journey',feature);
    await browser.eval('for(let i=0;i<600;i++) window.__topo.sim.step(1/60);');
    assert.equal(await browser.eval('!!window.__topo.sim.entityOf'),['-trace','-flags'].includes(feature));
    assert.deepEqual(errors, []);
  }
  console.log('entity inspector, read-only following, views, seeking and feature dependencies passed');

  await load('orders-api', '-tables,-trace,-morph');
  assert.equal(await browser.eval('!!window.__topo.records || !!window.__topo.tracer'), false);
  assert.deepEqual(errors, []);
  console.log('browser controls: records, saved fields, subsequent writes/replication, follow, failure/restore, seek, takeover, both views and feature removal passed');
  console.log('66 browser/Node/frozen cases, 462 checkpoints passed; no external resource requests or console errors');
} finally {
  await browser.close();
  rmSync(directory, {recursive: true, force: true});
}
