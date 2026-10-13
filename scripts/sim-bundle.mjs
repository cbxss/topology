// The simulation uses a deliberately small ESM convention, not an arbitrary JS bundler:
// one-line named relative imports and local export lists. Declarations stay unmodified.
// No aliases, re-exports, default exports, dynamic imports or cycles. Each module gets a
// separate scope. Node executes the original ESM; the browser executes these same bodies.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Script } from 'node:vm';

export const SIM_MODULES = ['sim/common.mjs', 'sim/context.mjs', 'sim/entity-cache.mjs', 'sim/entities.mjs', 'sim/routing.mjs', 'sim/reporting.mjs', 'sim/tables.mjs', 'sim/logs.mjs', 'sim/scenario.mjs', 'sim/transport.mjs', 'sim/core.mjs', 'topo-sim.mjs'];

export function bundleModules(sources, entry) {
  const modules = new Map();
  const visiting = new Set();
  const output = [];
  const namesOf = (list) => {
    const names = list.split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length || names.some(s => !/^[A-Za-z_$][\w$]*$/.test(s))) throw new Error(`unsupported module names: ${list}`);
    return names;
  };
  function visit(id) {
    if (visiting.has(id)) throw new Error(`simulation module cycle: ${[...visiting, id].join(' -> ')}`);
    if (modules.has(id)) return modules.get(id);
    if (!Object.hasOwn(sources, id)) throw new Error(`missing simulation module: ${id}`);
    visiting.add(id);
    const imports = [];
    const exports = [];
    let body = sources[id].replace(/^import \{ ([^\n{}]+) \} from ["'](\.[^"'\n]+)["'];\r?$/gm, (_, list, from) => {
      const dependency = posix.normalize(posix.join(posix.dirname(id), from));
      const module = visit(dependency);
      const names = namesOf(list);
      for (const name of names) if (!module.exports.includes(name)) throw new Error(`${id}: ${dependency} does not export ${name}`);
      imports.push(`const { ${names.join(', ')} } = ${module.variable};`);
      return '';
    });
    body = body.replace(/^export \{ ([^\n{}]+) \};\r?$/gm, (_, list) => { exports.push(...namesOf(list)); return ''; });
    if (new Set(exports).size !== exports.length) throw new Error(`${id}: duplicate exports`);
    // Script compilation rejects remaining static imports/exports. Dynamic imports are
    // valid in Script grammar, so reject them explicitly under this source convention.
    if (/\bimport\s*(?:\(|\.)/.test(body)) throw new Error(`${id}: dynamic import/import.meta is unsupported`);
    const variable = `module${modules.size}`;
    const code = `const ${variable} = (() => {\n'use strict';\n${imports.join('\n')}\n${body}\nreturn { ${exports.join(', ')} };\n})();`;
    try { new Script(code, { filename: id }); } catch (error) { throw new Error(`${id}: unsupported module syntax: ${error.message}`); }
    const module = { variable, exports };
    modules.set(id, module);
    visiting.delete(id);
    output.push(code);
    return module;
  }
  const main = visit(entry);
  return `const { ${main.exports.join(', ')} } = (() => {\n${output.join('\n')}\nreturn ${main.variable};\n})();\n`;
}

export function bundleSim() {
  const sources = Object.fromEntries(SIM_MODULES.map(file => [file, readFileSync(new URL(`../kit/${file}`, import.meta.url), 'utf8')]));
  return bundleModules(sources, 'topo-sim.mjs');
}
