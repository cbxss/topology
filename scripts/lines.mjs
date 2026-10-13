// The line-end check on a built page: every k-line must end on another stroke, a dot or an
// outline, or under a fill painted after it; ticks need one rooted end; data-free ends may stop.
//
//   node lines.mjs <page.html | url> [--out rings.png] [--tolerance 1] [--select css] [--wait 1500] [drive.mjs options]
//
// Exits 1 if any end floats; --out writes the card with each one ringed.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

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
const out = take("--out", null);
const tolerance = Number(take("--tolerance", 1));
const select = take("--select", null);
const wait = Number(take("--wait", 1500));
const actions = JSON.stringify([["wait", wait], ["lines", out, select, { tolerance }]]);
const child = spawn(process.execPath, [new URL("./drive.mjs", import.meta.url).pathname, argv[0], actions, ...argv.slice(1)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
