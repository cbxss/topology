// Scripted headless-Chrome sessions: hover, click, type, wait for a phase, take shots and
// contact sheets, run the line-end check.
//
//   node drive.mjs <page.html | url> '<actions as JSON>' [options]
//   node drive.mjs <page.html | url> --actions steps.json [options]
//
// Options: --width 1440  --height 1100  --scale 1  --reduced  --theme dark|light  --preload file.js
//
// Actions (a null or missing selector means the first .k-card; for key, the focusable [tabindex="0"]):
//   ["wait", ms]                         wait
//   ["scroll", sel]                      scroll the element into the middle of the viewport
//   ["move", sel, fx, fy]                glide the mouse to a fraction of the element
//   ["click", sel, fx?, fy?]             click (centre by default)
//   ["drag", sel, fx0, fy0, fx1, fy1, steps?]   press, glide, release
//   ["key", key, sel?]                   focus and press: "v", "Enter", "ArrowRight", " ", "7"
//   ["slow", factor]                     run the page clock at factor × real time (0.05 = 20× slow)
//   ["until", js, timeoutMs?]            poll a JS expression until it is truthy (default 10 s)
//   ["eval", js]                         run JS and print the result (promises are awaited)
//   ["shot", out, sel?, scale?, [x,y,w,h]?]           screenshot an element, or a region of it
//   ["sheet", out, every, count, sel?, scale?, [x,y,w,h]?, columns?]   frames tiled into one PNG
//   ["lines", out?, sel?, { tolerance }?]            the line-end check; exits 1 on any float
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LINE_CHECK, openBrowser, readoutOf, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
  process.exit(argv.length ? 0 : 1);
}
const take = (flag, fallback) => {
  const at = argv.indexOf(flag);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
};
const has = (flag) => {
  const at = argv.indexOf(flag);
  if (at >= 0) argv.splice(at, 1);
  return at >= 0;
};
const options = {
  width: Number(take("--width", 1440)),
  height: Number(take("--height", 1100)),
  scale: Number(take("--scale", 1)),
  theme: take("--theme", undefined),
  preload: (() => {
    const file = take("--preload", null);
    return file ? readFileSync(file, "utf8") : "";
  })(),
  reduced: has("--reduced"),
};
const actionsFile = take("--actions", null);
const [target, inline] = argv;
const actions = JSON.parse(actionsFile ? readFileSync(actionsFile, "utf8") : inline || "[]");

const page = await openBrowser(options);
let failed = false;
const write = (out, png) => {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
};
const card = (sel) => sel ?? ".k-card";
const point = async (sel, fx = 0.5, fy = 0.5) => {
  const box = await page.box(card(sel));
  return [box.vx + box.w * fx, box.vy + box.h * fy];
};
const regionOf = async (sel, region) => {
  const box = await page.box(card(sel));
  return region ? { x: box.x + region[0], y: box.y + region[1], w: region[2], h: region[3] } : box;
};
let mouse = [0, 0];
async function glide(to, buttons = 0, steps = 10) {
  for (let i = 1; i <= steps; i++) await page.mouse("mouseMoved", mouse[0] + ((to[0] - mouse[0]) * i) / steps, mouse[1] + ((to[1] - mouse[1]) * i) / steps, buttons);
  mouse = to;
}

try {
  await page.goto(target);
  for (const [kind, ...args] of actions) {
    if (kind === "wait") await sleep(args[0]);
    else if (kind === "scroll") await page.box(card(args[0]));
    else if (kind === "move") await glide(await point(...args));
    else if (kind === "click") {
      const at = await point(args[0], args[1], args[2]);
      await glide(at);
      await page.mouse("mousePressed", ...at, 1);
      await page.mouse("mouseReleased", ...at);
    } else if (kind === "drag") {
      const [sel, fx0, fy0, fx1, fy1, steps = 20] = args;
      await glide(await point(sel, fx0, fy0));
      await page.mouse("mousePressed", ...mouse, 1);
      const end = await point(sel, fx1, fy1);
      for (let i = 1; i <= steps; i++) {
        await page.mouse("mouseMoved", mouse[0] + ((end[0] - mouse[0]) * i) / steps, mouse[1] + ((end[1] - mouse[1]) * i) / steps, 1);
        await sleep(16);
      }
      mouse = end;
      await page.mouse("mouseReleased", ...end);
    } else if (kind === "key") {
      await page.eval(`document.querySelector(${JSON.stringify(args[1] ?? '[tabindex="0"]')})?.focus()`);
      await page.key(args[0]);
    } else if (kind === "slow") await page.eval(`window.__driveSpeed = ${Number(args[0])}`);
    else if (kind === "until") {
      const [js, timeout = 10000] = args;
      const start = Date.now();
      while (!(await page.eval(`!!(${js})`))) {
        if (Date.now() - start > timeout) {
          console.log(`until: timed out after ${timeout} ms: ${js}`);
          break;
        }
        await sleep(25);
      }
    } else if (kind === "eval") console.log(`eval: ${JSON.stringify(await page.eval(args[0]))}`);
    else if (kind === "shot") {
      const [out, sel, scale, region] = args;
      write(out, await page.shot(await regionOf(sel, region), scale ?? options.scale));
      console.log(`shot ${out} · readout ${JSON.stringify(await readoutOf(page))}`);
    } else if (kind === "sheet") {
      const [out, every, count, sel, scale, region, columns] = args;
      const clip = await regionOf(sel, region);
      const frames = [];
      for (let i = 0; i < count; i++) {
        frames.push((await page.shot(clip, scale ?? options.scale)).toString("base64"));
        if (i < count - 1) await sleep(every);
      }
      const tiled = await page.eval(`(async () => {
        const frames = ${JSON.stringify(frames)}, cols = ${columns ?? Math.min(count, 6)};
        const images = await Promise.all(frames.map((src) => new Promise((done) => { const img = new Image(); img.onload = () => done(img); img.src = "data:image/png;base64," + src; })));
        const [w, h] = [images[0].width, images[0].height];
        const canvas = document.createElement("canvas");
        canvas.width = w * cols; canvas.height = h * Math.ceil(images.length / cols);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = "bold 13px monospace"; ctx.fillStyle = "#ff00aa";
        images.forEach((img, i) => { ctx.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h); ctx.fillText(String(i), (i % cols) * w + 6, Math.floor(i / cols) * h + 16); });
        return canvas.toDataURL("image/png").split(",")[1];
      })()`);
      write(out, Buffer.from(tiled, "base64"));
      console.log(`sheet ${out} · ${count} frames every ${every} ms`);
    } else if (kind === "lines") {
      const [out, sel, { tolerance = 1 } = {}] = args;
      const result = await page.eval(`${LINE_CHECK}(${JSON.stringify(card(sel))}, ${tolerance})`);
      console.log(`line ends: ${result.floating.length} of ${result.ends} ends on ${result.lines} lines float`);
      for (const f of result.floating.slice(0, 40)) console.log(`  ${f.tone} ${f.which}  at ${f.x.toFixed(1)},${f.y.toFixed(1)}  length ${f.length}  d ${f.d}`);
      if (out) {
        await page.eval(`(() => { const layer = document.createElement("div"); layer.id = "__rings"; layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:99"; for (const f of ${JSON.stringify(result.floating)}) { const ring = document.createElement("div"); ring.style.cssText = "position:fixed;width:14px;height:14px;border:2px solid #ff00aa;border-radius:50%;left:" + (f.x - 7) + "px;top:" + (f.y - 7) + "px"; layer.appendChild(ring); } document.body.appendChild(layer); })()`);
        write(out, await page.shot(await regionOf(sel), 2));
        await page.eval(`document.getElementById("__rings").remove()`);
        console.log(`rings: ${out}`);
      }
      if (result.floating.length) failed = true;
    } else throw new Error(`unknown action "${kind}"`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  failed = true;
}
console.log(page.errors.length ? page.errors.join("\n") : "console: clean");
if (page.errors.length) failed = true;
await page.close();
process.exit(failed ? 1 : 0);
