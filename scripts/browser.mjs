// A small headless-Chrome driver over the DevTools protocol, for capture.mjs, drive.mjs and
// lines.mjs. Node 22+ (built-in WebSocket); no dependencies.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const name of names) {
    const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
    if (found) return found;
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  throw new Error("no Chrome or Chromium found; set CHROME_PATH");
}

export const urlOf = (target) => (/^[a-z]+:\/\//.test(target) ? target : pathToFileURL(resolve(target)).href);

// Page clock control: window.__driveSpeed scales requestAnimationFrame timestamps and
// performance.now, so a sheet can film a fast transition in slow motion.
const CLOCK = `(() => {
  window.__driveSpeed = window.__driveSpeed ?? 1;
  const now = performance.now.bind(performance);
  let real = now(), shown = real;
  const tick = () => { const t = now(); shown += (t - real) * window.__driveSpeed; real = t; return shown; };
  performance.now = tick;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf(() => fn(tick()));
})();`;

export async function openBrowser({ width = 1440, height = 1000, scale = 2, reduced = false, theme, preload } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "topo-chrome-"));
  const chrome = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((done, fail) => {
    let text = "";
    const abort = (reason) => {
      clearTimeout(timer);
      fail(new Error(`${reason}\n${text.slice(-8192)}`));
    };
    const timer = setTimeout(() => { chrome.kill(); abort("Chrome did not start"); }, 20000);
    chrome.stderr.on("data", (chunk) => {
      text += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    chrome.once("error", (error) => abort(`Chrome could not start: ${error.message}`));
    chrome.once("exit", (code, signal) => abort(`Chrome exited (${signal || code})`));
  }).catch((error) => {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  });
  const socket = new WebSocket(endpoint);
  await new Promise((done) => socket.addEventListener("open", done, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message));
      else done(message.result);
    } else for (const listener of listeners) listener(message);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      pending.set(++id, { done, fail });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  const errors = [];
  let loaded = null;
  listeners.add((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (message.method === "Page.loadEventFired" && loaded) loaded();
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: width < 600 });
  const media = [];
  if (reduced) media.push({ name: "prefers-reduced-motion", value: "reduce" });
  if (theme) media.push({ name: "prefers-color-scheme", value: theme });
  if (media.length) await send("Emulation.setEmulatedMedia", { features: media });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK + (preload || "") });

  const page = {
    errors,
    send,
    async goto(target) {
      const ready = new Promise((done) => (loaded = done));
      await send("Page.navigate", { url: urlOf(target) });
      await ready;
    },
    async eval(expression) {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result.value;
    },
    // The element's box in page coordinates (document, not viewport).
    async box(selector) {
      const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, vx: r.left, vy: r.top }; })()`);
      if (!box) throw new Error(`no element matches ${selector}`);
      return box;
    },
    async shot(clip, shotScale = scale) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: shotScale / scale } });
      return Buffer.from(data, "base64");
    },
    async mouse(type, x, y, buttons = 0) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
    },
    async key(key) {
      const code = /^[0-9]$/.test(key) ? `Digit${key}` : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key === "," || key === "Comma" ? "Comma" : key;
      const text = key.length === 1 ? key : key === "Comma" ? "," : key === "Enter" ? "\r" : undefined;
      const name = key === "Comma" ? "," : key;
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: name, code, text, windowsVirtualKeyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : undefined });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code });
    },
    async close() {
      try {
        socket.close();
      } catch {}
      chrome.kill();
      await new Promise((done) => (chrome.exitCode !== null ? done() : chrome.once("exit", done)));
      // Chrome's helper processes can still be writing the profile after the main one exits:
      // retry, and never fail a finished check over a leftover temp directory.
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {}
    },
  };
  return page;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const readoutOf = (page) => page.eval(`(document.querySelector("[data-readout]") || {}).textContent || ""`);

// The line-end check, run in the page: every open subpath of every k-line (seams, ticks,
// rule lines, edges' arrowheads…) must end within `tolerance` viewBox units of another stroke
// or a dot, or under a fill painted after it. Short marks (< 7 units, ticks) need one rooted
// end. Ends marked data-free ("", "start", "end") are meant to stop. Silhouettes, creases
// and bevels are the solids' own and aren't checked.
export const LINE_CHECK = `((select, tolerance) => {
  const root = document.querySelector(select) || document;
  const svgs = [...root.querySelectorAll("svg.k-svg")].filter((svg) => svg.getBoundingClientRect().width > 0 && !svg.closest("[hidden]"));
  const out = { ends: 0, lines: 0, floating: [] };
  const own = (el) => el.classList.contains("k-edge") || el.classList.contains("k-crease") || el.classList.contains("k-bevel");
  for (const svg of svgs) {
    const toSvg = (el, p) => { const m = el.getCTM(); return m ? new DOMPoint(p.x, p.y).matrixTransform(m) : p; };
    const pieces = (el) => (el.getAttribute("d") || "").split(/(?=M)/).filter((d) => d.trim());
    const temp = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const sampled = [];
    const strokes = [...svg.querySelectorAll("path")].filter((el) => getComputedStyle(el).stroke !== "none" && getComputedStyle(el).display !== "none");
    strokes.forEach((el, index) => {
      el.parentNode.appendChild(temp);
      pieces(el).forEach((d, part) => {
        temp.setAttribute("d", d);
        const total = temp.getTotalLength();
        for (let s = 0; s <= total; s += 0.75) sampled.push({ index, part, p: toSvg(temp, temp.getPointAtLength(s)) });
      });
      temp.remove();
    });
    // Rectangle outlines count as strokes too.
    [...svg.querySelectorAll("rect")].filter((el) => getComputedStyle(el).stroke !== "none").forEach((el, i) => {
      const b = el.getBBox();
      const edges = [[b.x, b.y, b.x + b.width, b.y], [b.x + b.width, b.y, b.x + b.width, b.y + b.height], [b.x, b.y + b.height, b.x + b.width, b.y + b.height], [b.x, b.y, b.x, b.y + b.height]];
      for (const [x0, y0, x1, y1] of edges) {
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.75));
        for (let k = 0; k <= n; k++) sampled.push({ index: -1 - i, part: 0, p: toSvg(el, { x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n }) });
      }
    });
    const dots = [...svg.querySelectorAll("circle, ellipse")].map((el) => { const b = el.getBBox(); const c = toSvg(el, { x: b.x + b.width / 2, y: b.y + b.height / 2 }); return { c, r: Math.max(b.width, b.height) / 2 }; });
    const fills = [...svg.querySelectorAll("path, rect, circle, ellipse")].filter((el) => { const f = getComputedStyle(el).fill; return f && f !== "none" && !el.classList.contains("k-halo"); });
    const covered = (line, p) => fills.some((el) => {
      if (!(line.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const m = el.getCTM();
      const local = m ? new DOMPoint(p.x, p.y).matrixTransform(m.inverse()) : p;
      return el.isPointInFill(local);
    });
    strokes.forEach((el, index) => {
      if (!el.classList.contains("k-line") || own(el)) return;
      const free = el.getAttribute("data-free");
      out.lines++;
      el.parentNode.appendChild(temp);
      pieces(el).forEach((d, part) => {
        if (/z\s*$/i.test(d)) return;
        temp.setAttribute("d", d);
        const total = temp.getTotalLength();
        const ends = [["start", toSvg(temp, temp.getPointAtLength(0))], ["end", toSvg(temp, temp.getPointAtLength(total))]];
        const rooted = ends.map(([which, p]) => {
          if (free === "" || free === which) return true;
          if (sampled.some((s) => !(s.index === index && s.part === part) && Math.hypot(s.p.x - p.x, s.p.y - p.y) <= tolerance)) return true;
          if (dots.some((dot) => Math.hypot(dot.c.x - p.x, dot.c.y - p.y) <= dot.r + tolerance)) return true;
          return covered(el, p);
        });
        out.ends += 2;
        const short = total < 7;
        ends.forEach(([which, p], i) => {
          if (rooted[i] || (short && rooted[1 - i])) return;
          const box = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          out.floating.push({ which, tone: el.getAttribute("data-tone"), x: box.left + ((p.x - vb.x) / vb.width) * box.width, y: box.top + ((p.y - vb.y) / vb.height) * box.height, length: +total.toFixed(1), d: d.slice(0, 48) });
        });
      });
      temp.remove();
    });
  }
  return out;
})`;
