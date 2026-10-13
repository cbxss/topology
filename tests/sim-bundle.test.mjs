import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {bundleModules} from '../scripts/sim-bundle.mjs';

test('bundle orders dependencies and isolates module-local names',()=>{
 const sources={
  'main.mjs': 'import { a } from "./a.mjs";\nimport { b } from "./b.mjs";\nconst answer = a + b;\nexport { answer };',
  'a.mjs': 'const local = 20;\nconst a = local;\nexport { a };',
  'b.mjs': 'const local = 22;\nconst b = local;\nexport { b };',
 };
 assert.equal(runInNewContext(bundleModules(sources,'main.mjs')+'answer'),42);
});
test('bundle rejects missing modules, missing exports and cycles',()=>{
 assert.throws(()=>bundleModules({'a.mjs':'import { b } from "./b.mjs";'},'a.mjs'),/missing simulation module/);
 assert.throws(()=>bundleModules({'a.mjs':'import { b } from "./b.mjs";','b.mjs':'const c = 1;\nexport { c };'},'a.mjs'),/does not export b/);
 assert.throws(()=>bundleModules({'a.mjs':'import { b } from "./b.mjs";','b.mjs':'import { a } from "./a.mjs";'},'a.mjs'),/cycle/);
});
test('bundle fails closed on unsupported syntax',()=>{
 for(const source of ['export default 1;', 'export * from "./b.mjs";', 'import thing from "./b.mjs";', 'export const a = import("./b.mjs");','export const a = import.meta.url;', 'export const a = 1, b = 2;\nexport { b as renamed };'])
  assert.throws(()=>bundleModules({'a.mjs':source},'a.mjs'),/unsupported/);
});
