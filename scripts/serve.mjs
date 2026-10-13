// A dev server: every page is built fresh (in a child process, so kit edits apply too) and
// open pages reload when a spec, its layout file or the kit changes.
//
//   node scripts/serve.mjs [dir | spec ...] [--port 8765] [--host 127.0.0.1]
//
// Pages: /s/<name> (dark), ?theme=light, ?view=flat, ?features=-trails, ?edit (drag to arrange).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escape } from "../kit/iso.mjs";
import { layoutFileOf, nameOf } from "./page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("node serve.mjs [dir | spec ...] [--port 8765] [--host 127.0.0.1]");
  process.exit(0);
}
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const out = argv[at + 1];
  argv.splice(at, 2);
  return out;
};
const port = Number(value("--port", 8765));
const host = value("--host", "127.0.0.1");
const roots = (argv.length ? argv : [join(ROOT, "examples")]).map((path) => resolve(path));

function discover() {
  const specs = new Map();
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isFile()) {
      if (/\.spec\.(mjs|js|json)$/.test(path)) {
        let name = nameOf(path);
        while (specs.has(name)) name += "_";
        specs.set(name, path);
      }
      return;
    }
    for (const entry of readdirSync(path)) if (!entry.startsWith(".") && entry !== "node_modules") visit(join(path, entry));
  };
  roots.forEach(visit);
  return specs;
}

// Specs found under the roots, and built pages, are kept until something changes on disk.
let found = null;
const discovered = () => (found ||= discover());
const pages = new Map();

const clients = new Set();
let timer = 0;
function reload(reason) {
  found = null;
  pages.clear();
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`reload: ${reason}`);
    for (const res of clients) res.write(`event: reload\ndata: ${JSON.stringify(reason)}\n\n`);
  }, 120);
}
for (const dir of [...roots.map((path) => (statSync(path).isFile() ? dirname(path) : path)), join(ROOT, "kit"), HERE]) {
  watch(dir, { recursive: true }, (_, file) => {
    if (!file || /\.(html|svg|png)$/.test(file) || file.includes("/.")) return;
    reload(relative(ROOT, join(dir, String(file))));
  });
}

const RELOAD = `<script>(()=>{const s=new EventSource("/events");s.addEventListener("reload",()=>location.reload());})();</script>`;

function build(file, params) {
  const args = file === "catalog" ? [join(HERE, "catalog.mjs"), "--stdout"] : [join(HERE, "build.mjs"), file, "--stdout"];
  if (params.get("theme") === "light") args.push("--light");
  if (params.get("view")) args.push("--view", params.get("view"));
  if (params.get("features")) args.push("--features", params.get("features"));
  if (params.has("edit")) args.push("--edit");
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => done({ ok: false, out: "", err: error.message }));
    child.on("close", (code) => done({ ok: code === 0, out, err }));
  });
}

function index(specs) {
  const rows = [...specs].map(([name, file]) => `<li><a href="/s/${name}">${name}</a> · <a href="/s/${name}?theme=light">light</a> · <a href="/s/${name}?view=flat">2D</a> · <a href="/s/${name}?edit">edit</a> <small>${escape(relative(ROOT, file))}</small></li>`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Topology</title><style>body{background:#0b0b0b;color:#a3a3a3;font:14px/1.9 ui-monospace,Menlo,monospace;margin:56px auto;width:min(760px,100% - 32px)}a{color:#e6e6e6}small{color:#555;margin-left:8px}h1{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:#e6e6e6}</style><h1>Topology</h1><p><a href="/catalog">Component catalog</a> · <a href="/catalog?theme=light">light</a></p><ul>${rows.join("")}</ul><p>Pages rebuild on every load and reload when a spec, layout file or the kit changes.</p>${RELOAD}`;
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, "http://x");
  const specs = discovered();
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": hi\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(index(specs));
  }
  const page = url.pathname === "/catalog" ? [null, "catalog"] : url.pathname.match(/^\/s\/([^/]+)$/);
  if (page && req.method === "GET") {
    const file = page[1] === "catalog" && url.pathname === "/catalog" ? "catalog" : specs.get(decodeURIComponent(page[1]));
    if (!file) return res.writeHead(404).end("no such spec");
    const started = Date.now();
    const key = `${file}?${[...url.searchParams].sort().join("&")}`;
    if (!pages.has(key)) pages.set(key, build(file, url.searchParams));
    const result = await pages.get(key);
    if (!result.ok) pages.delete(key);
    console.log(`${req.method} ${req.url} ${result.ok ? "ok" : "FAILED"} ${Date.now() - started}ms`);
    res.writeHead(result.ok ? 200 : 500, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // Before the last </body>: the page's own script may contain the text "</body>" (the
    // morph inlines the kit, whose page template has one).
    const at = result.out.lastIndexOf("</body>");
    if (result.ok) return res.end(at < 0 ? result.out + RELOAD : result.out.slice(0, at) + RELOAD + result.out.slice(at));
    return res.end(`<!doctype html><meta charset="utf-8"><title>build failed</title><body style="background:#0b0b0b;color:#ff6b6b;font:13px/1.6 ui-monospace,monospace;margin:40px"><h3>build failed: ${escape(page[1])}</h3><pre>${escape(result.err)}</pre>${RELOAD}</body>`);
  }
  const layout = url.pathname.match(/^\/layout\/([^/]+)$/);
  if (layout && req.method === "POST") {
    const file = specs.get(decodeURIComponent(layout[1]));
    if (!file) return res.writeHead(404).end("no such spec");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1e5) return res.writeHead(413).end("too large");
    }
    try {
      const { at } = JSON.parse(body);
      const clean = {};
      for (const [id, pos] of Object.entries(at || {})) {
        if (!Array.isArray(pos) || pos.length !== 2 || !pos.every(Number.isFinite)) throw new Error(`bad position for ${id}`);
        clean[id] = pos.map((n) => Math.round(n * 100) / 100);
      }
      const target = layoutFileOf(file);
      writeFileSync(target, JSON.stringify({ at: clean }, null, 2) + "\n");
      console.log(`wrote ${relative(ROOT, target)}`);
      res.writeHead(200).end("ok");
    } catch (error) {
      res.writeHead(400).end(String(error.message));
    }
    return;
  }
  res.writeHead(404).end("not found");
  } catch (error) {
    if (res.headersSent) return res.end();
    res.writeHead(error instanceof URIError ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof URIError ? "malformed URL" : "request failed");
  }
});
server.listen(port, host, () => {
  const specs = discovered();
  console.log(`topology serve: http://${host}:${server.address().port}/  (${specs.size} spec${specs.size === 1 ? "" : "s"}: ${[...specs.keys()].join(", ")})`);
  if (!existsSync(join(ROOT, "kit"))) console.log("warning: kit/ not found");
});
