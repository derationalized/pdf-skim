// Vendors two files from pdfjs-dist: pdfjs/pdf.mjs (the main library,
// loaded by src/pdf/extractor.js) and pdf.worker.js (pdf.js's own parsing
// worker, loaded at runtime via a Blob URL — see extractor.js's comments
// for why a plain file:// path doesn't work inside Obsidian's renderer).
//
// Not committed to the repo — these are raw, unmodified copies of a
// third-party package's own build output, not source we authored, so
// contributors regenerate them locally instead (see CONTRIBUTING.md).
//
// Run with: node scripts/fetch-pdfjs.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PDFJS_VERSION = '5.6.205'; // pinned for reproducible builds; bump deliberately

const root = path.resolve(import.meta.dirname, '..');
const tmp = path.join(os.tmpdir(), `pdf-skim-pdfjs-fetch-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

console.log(`Fetching pdfjs-dist@${PDFJS_VERSION}...`);
execFileSync('npm', ['pack', `pdfjs-dist@${PDFJS_VERSION}`, '--silent'], { cwd: tmp, stdio: 'inherit' });
const dest = path.join(tmp, 'pdfjs-dist');
mkdirSync(dest, { recursive: true });
execFileSync('tar', ['-xzf', path.join(tmp, `pdfjs-dist-${PDFJS_VERSION}.tgz`), '-C', dest, '--strip-components=1']);

mkdirSync(path.join(root, 'pdfjs'), { recursive: true });
cpSync(path.join(dest, 'legacy', 'build', 'pdf.mjs'), path.join(root, 'pdfjs', 'pdf.mjs'));
cpSync(path.join(dest, 'legacy', 'build', 'pdf.worker.mjs'), path.join(root, 'pdf.worker.js'));

rmSync(tmp, { recursive: true, force: true });
console.log('Done. pdfjs/pdf.mjs and pdf.worker.js are up to date.');
