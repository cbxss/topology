import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildPage, check, loadSpec, nameOf, svgOf, traceText } from "./page.mjs";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(`Build a system figure from a spec.

  node build.mjs <spec.mjs | spec.json> [options]

  --light             light theme (default dark)
  --view iso|flat     the view the page opens in (default: spec.view, else iso)
  --out <file>        output path (default: <spec name>.html, or <spec name>-light.html, next to the spec)
  --stdout            write the page to stdout instead of a file
  --svg               also write a static <name>-<view>.svg of each view (standalone, themed)
  --features <list>   turn tool features on or off: "trails,-morph" (see kit/topo-features.mjs)
  --no-<feature>      the same, for one feature
  --edit              include the drag-to-arrange editor (serve.mjs uses this)
  --trace <route>     follow one request on that route (e.g. "POST /orders") and print its spans
  --check [seconds]   run the model headless for that long (default 30) and print what the readout
                      will say, per node, plus warnings: growing lag, drops, idle edges, layout.
                      Writes nothing.
  --sources           resolve the spec's source refs (sources, refs, notes) and report what's
                      missing, mismatched or changed since the pinned rev. Writes nothing.
    --json            the report as JSON
    --fetch           shallow-fetch remote repos into ~/.cache/topology/repos
    --source-dir n=p  read source n from the checkout at p (repeatable)
    --strict          also fail on stale or unresolved refs

A <name>.layout.json next to the spec (written by serve.mjs's editor) overrides node positions.`);
  process.exit(argv.length ? 0 : 1);
}
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};

const file = resolve(argv[0]);
const spec = await loadSpec(file);
const featureLayers = [[value("--features", ""), ...argv.filter((arg) => arg.startsWith("--no-")).map((arg) => "-" + arg.slice(5))].filter(Boolean).join(",")];

if (flag("--sources")) {
  const { failed, printSources, sourcesReport } = await import("./sources.mjs");
  const sourceDirs = Object.fromEntries(argv.flatMap((arg, i) => (arg === "--source-dir" && argv[i + 1]?.includes("=") ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
  const report = sourcesReport(spec, { file, sourceDirs, fetch: flag("--fetch") });
  if (flag("--json")) console.log(JSON.stringify(report, null, 2));
  else printSources(report);
  process.exit(failed(report, flag("--strict")) ? 1 : 0);
}

if (flag("--trace")) {
  for (const line of traceText(spec, value("--trace", ""), { featureLayers })) console.log(line);
  process.exit(0);
}

if (flag("--check")) {
  check(spec, { seconds: Number(value("--check", 30)), featureLayers });
  process.exit(process.exitCode ?? 0);
}

const theme = flag("--light") ? "light" : "dark";
const { html, rendered } = buildPage(spec, { theme, view: value("--view", undefined), featureLayers, edit: flag("--edit") });
if (flag("--stdout")) {
  process.stdout.write(html);
} else {
  const name = nameOf(file);
  const out = resolve(value("--out", join(dirname(file), theme === "light" ? `${name}-light.html` : `${name}.html`)));
  writeFileSync(out, html);
  console.log("wrote", out);
  if (flag("--svg")) {
    for (const v of ["iso", "flat"]) {
      const svgOut = out.replace(/\.html$/, `-${v}.svg`);
      writeFileSync(svgOut, svgOf(rendered, v, theme));
      console.log("wrote", svgOut);
    }
  }
}
