'use strict';
/*
  scripts/hand-bundle.js

  Stand-in for esbuild when no Node/npm toolchain is available to run the
  project's normal build. Produces a single self-contained main.js from
  src/main.js and everything it locally requires — the same *shape* of
  output esbuild would produce (one file), just not minified and built by
  hand instead of by a real bundler.

  Module IDs are paths relative to src/, always joined with forward
  slashes and resolved by a tiny hand-rolled POSIX-style path joiner
  defined *inside* the generated bundle — deliberately not the real
  Node 'path' module. An earlier version of this script used absolute
  filesystem paths (from wherever it happened to be run) as registry
  keys, and Node's real path.resolve()/path.dirname() to look them up
  again at runtime — which happened to work when built and tested on the
  same machine, but breaks the moment the bundle runs somewhere else
  (different absolute paths entirely, and on Windows, real path.*
  resolution also behaves differently for POSIX-style strings than on
  Linux/Mac). Logical, forward-slash-only IDs resolved by fixed string
  logic sidestep both problems — the bundle's behavior no longer depends
  on the filesystem or OS it happens to run on at all.

  Each local module's source is wrapped UNMODIFIED in a factory function;
  no require(...) call text is rewritten, only read well enough to know
  which files to also pull in. 'obsidian', 'electron', and Node builtins
  are left as real require() calls in the output (delegated to the
  actual runtime require), same as esbuild's `external` list in
  esbuild.config.mjs does for the real build.

  Run: node scripts/hand-bundle.js
  Output: dist-handbuilt/main.js
*/

const fs = require('fs');
const path = require('path');

const EXTERNAL = new Set([
  'obsidian', 'electron',
  'fs', 'path', 'os', 'url', 'events', 'child_process', 'crypto', 'stream', 'util', 'buffer',
]);

const srcRoot = path.resolve(__dirname, '..', 'src');
const entryId = 'main';
const modules = new Map(); // logical id ('pdf/extractor') -> source code, in discovery order

/** OS-directory path -> logical module id, always forward-slash, always
 *  relative to src/. This is the ONLY place a real filesystem path is
 *  converted to a logical id — everything downstream (both here and in
 *  the generated bundle) works with these ids as plain strings. */
function toId(absPath) {
  return path.relative(srcRoot, absPath).split(path.sep).join('/').replace(/\.js$/, '');
}

function fileForId(id) {
  return path.join(srcRoot, ...id.split('/')) + '.js';
}

/** Resolves a require() specifier written in the module `fromId` against
 *  that module's own logical directory, using plain '/'-joined string
 *  logic — the same algorithm the generated bundle's own resolveId()
 *  repeats at runtime, so build-time and run-time resolution can never
 *  disagree with each other. */
function resolveId(fromId, specifier) {
  const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
  const combinedParts = (fromDir ? `${fromDir}/${specifier}` : specifier).split('/');
  const out = [];
  for (const part of combinedParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function collect(id) {
  if (modules.has(id)) return;
  const code = fs.readFileSync(fileForId(id), 'utf8');
  modules.set(id, code); // reserve the slot before recursing, guards against cycles

  const re = /require\(\s*(['"])(\.[^'"]*)\1\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    collect(resolveId(id, m[2]));
  }
}

collect(entryId);

const lines = [];
lines.push(`'use strict';`);
lines.push(`// Hand-built bundle (see scripts/hand-bundle.js) — a stand-in for the normal`);
lines.push(`// esbuild output when no Node/npm toolchain was available to run it.`);
lines.push(`// Functionally the same require() graph as src/, just inlined by hand.`);
lines.push(`(function () {`);
lines.push(`  var __registry = Object.create(null);`);
lines.push(`  var __cache = Object.create(null);`);
lines.push(``);
lines.push(`  // Plain '/'-joined string resolution, deliberately not Node's real`);
lines.push(`  // 'path' module — this must behave identically on every OS, and must`);
lines.push(`  // exactly match how scripts/hand-bundle.js resolved the same specifiers`);
lines.push(`  // at build time (see its resolveId()).`);
lines.push(`  function __resolve(fromId, specifier) {`);
lines.push(`    var fromDir = fromId.indexOf('/') !== -1 ? fromId.slice(0, fromId.lastIndexOf('/')) : '';`);
lines.push(`    var combined = (fromDir ? fromDir + '/' + specifier : specifier).split('/');`);
lines.push(`    var out = [];`);
lines.push(`    for (var i = 0; i < combined.length; i++) {`);
lines.push(`      var part = combined[i];`);
lines.push(`      if (part === '' || part === '.') continue;`);
lines.push(`      if (part === '..') out.pop(); else out.push(part);`);
lines.push(`    }`);
lines.push(`    return out.join('/');`);
lines.push(`  }`);
lines.push(``);
lines.push(`  function __req(fromId, specifier) {`);
lines.push(`    if (specifier.charAt(0) !== '.') return require(specifier); // external: obsidian, electron, node builtins`);
lines.push(`    var id = __resolve(fromId, specifier);`);
lines.push(`    if (!__registry[id]) throw new Error('hand-bundle: module not found at runtime: ' + specifier + ' -> ' + id + ' (from ' + fromId + ')');`);
lines.push(`    if (__cache[id]) return __cache[id].exports;`);
lines.push(`    var mod = { exports: {} };`);
lines.push(`    __cache[id] = mod; // set before running the factory, so circular requires see the in-progress exports object`);
lines.push(`    __registry[id](mod, mod.exports, function (spec) { return __req(id, spec); });`);
lines.push(`    return mod.exports;`);
lines.push(`  }`);
lines.push(``);

for (const [id, code] of modules) {
  lines.push(`  __registry[${JSON.stringify(id)}] = function (module, exports, require) {`);
  lines.push(code);
  lines.push(`  };`);
  lines.push(``);
}

lines.push(`  module.exports = __req(${JSON.stringify(entryId)}, './${entryId}');`);
lines.push(`})();`);
lines.push(``);

const outPath = path.resolve(__dirname, '..', 'dist-handbuilt', 'main.js');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));
console.log('Wrote', outPath, `(${modules.size} modules inlined)`);
