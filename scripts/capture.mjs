// One-shot screenshots of a figure with headless Chrome.
//
//   node capture.mjs <page.html | page.svg | url> [options]
//
//   --out <png>          output (default capture.png)
//   --width <px>         viewport width (default 1440; 390 for a phone)
//   --height <px>        viewport height (default 1000)
//   --scale <n>          device pixel ratio (default 2)
//   --wait <ms>          settle time before the first shot (default 2500)
//   --select <css>       clip to this element (default .k-card, else the whole page)
//   --zoom <x,y,w,h>     clip a region of the selected element, in CSS px, at --zoom-scale (default 4)
//   --hover <fx,fy>      move the mouse to this fraction of the element first
//   --key <keys>         press keys on the figure first, comma separated (a comma is written Comma)
//   --times <ms,...>     extra shots at these delays after the first, saved as <name>-<ms>.png
//   --reduced            prefers-reduced-motion: reduce
//   --theme dark|light   prefers-color-scheme
//
// Prints the clip box, the readout, whether the page scrolls sideways, and any console
// errors or exceptions.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openBrowser, readoutOf, sleep } from "./browser.mjs";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n"));
  process.exit(argv.length ? 0 : 1);
}
const o = { out: "capture.png", width: 1440, height: 1000, scale: 2, wait: 2500, zoomScale: 4, times: [], keys: [] };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const next = () => argv[++i];
  if (arg === "--out") o.out = next();
  else if (arg === "--width") o.width = Number(next());
  else if (arg === "--height") o.height = Number(next());
  else if (arg === "--scale") o.scale = Number(next());
  else if (arg === "--wait") o.wait = Number(next());
  else if (arg === "--select") o.select = next();
  else if (arg === "--zoom") o.zoom = next().split(",").map(Number);
  else if (arg === "--zoom-scale") o.zoomScale = Number(next());
  else if (arg === "--hover") o.hover = next().split(",").map(Number);
  else if (arg === "--key") o.keys = next().split(",");
  else if (arg === "--times") o.times = next().split(",").map(Number);
  else if (arg === "--reduced") o.reduced = true;
  else if (arg === "--theme") o.theme = next();
  else rest.push(arg);
}

const page = await openBrowser({ width: o.width, height: o.height, scale: o.scale, reduced: o.reduced, theme: o.theme });
let code = 0;
try {
  await page.goto(rest[0]);
  const select = o.select ?? ((await page.eval(`!!document.querySelector(".k-card")`)) ? ".k-card" : "body");
  let box = await page.box(select);
  if (o.hover) await page.mouse("mouseMoved", box.vx + box.w * o.hover[0], box.vy + box.h * o.hover[1]);
  if (o.keys.length) {
    await page.eval(`document.querySelector('[tabindex="0"]')?.focus()`);
    for (const key of o.keys) if (key !== "Tab") await page.key(key);
  }
  await sleep(o.wait);
  box = await page.box(select);
  const clip = o.zoom ? { x: box.x + o.zoom[0], y: box.y + o.zoom[1], w: o.zoom[2], h: o.zoom[3] } : box;
  const shoot = async (out) => {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, await page.shot(clip, o.zoom ? o.zoomScale : o.scale));
  };
  await shoot(o.out);
  console.log(`saved ${resolve(o.out)}`);
  const sideways = await page.eval(`document.documentElement.scrollWidth > innerWidth + 1`);
  console.log(`clip ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} · readout ${JSON.stringify(await readoutOf(page))} · scrolls sideways: ${sideways ? "YES" : "no"}`);
  const started = Date.now();
  const later = [];
  for (const ms of o.times) {
    await sleep(Math.max(0, ms - (Date.now() - started)));
    await shoot(o.out.replace(/\.png$/, `-${ms}.png`));
    later.push(`+${ms}ms ${JSON.stringify(await readoutOf(page))}`);
  }
  if (later.length) console.log(`readout over time: ${later.join(" · ")}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  code = 1;
}
console.log(page.errors.length ? page.errors.join("\n") : "console: clean");
await page.close();
process.exit(code || (page.errors.length ? 1 : 0));
