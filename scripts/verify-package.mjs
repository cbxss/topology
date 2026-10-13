// Exercise the archive that npm will ship, outside the repository checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "topology-package-"));
try {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { encoding: "utf8" }));
  const paths = new Set(packed.files.map(({ path }) => path));
  for (const required of ["SKILL.md", "agents/openai.yaml", "references/spec.md", "kit/sim/core.mjs", "scripts/build.mjs", "LICENSE"]) {
    assert.ok(paths.has(required), `package missing ${required}`);
  }
  for (const path of paths) {
    assert.ok(!/^(?:\.git|\.scratch|node_modules|shots|docs\/media)(?:\/|$)/.test(path), `unexpected package file: ${path}`);
    assert.ok(!/(?:^|\/)\.env(?:\.|$)/.test(path), `unexpected environment file: ${path}`);
  }
  execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);
  const cwd = join(temp, "package");
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const skill = readFileSync(join(cwd, "SKILL.md"), "utf8");
  assert.equal(/^  version: "([^"]+)"$/m.exec(skill)?.[1], manifest.version, "package and skill versions differ");
  for (const example of ["orders-api", "data-stores", "tenant-routing", "event-routing", "order-ledger"]) {
    const spec = `examples/${example}/${example}.spec.mjs`;
    execFileSync(process.execPath, ["scripts/build.mjs", spec, "--check"], { cwd, stdio: "pipe" });
    execFileSync(process.execPath, ["scripts/build.mjs", spec, "--out", join(temp, `${example}.html`)], { cwd, stdio: "pipe" });
    assert.ok(readFileSync(join(temp, `${example}.html`), "utf8").includes("<svg"));
  }
  console.log(`${packed.name}@${packed.version}: ${paths.size} packed files; isolated model checks and HTML builds passed`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
