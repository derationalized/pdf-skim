// Populates modules/win-x64/ and modules/linux-x64/ with everything the
// plugin needs to run standalone: the Sherpa-ONNX TTS engine, and a real,
// genuine Node.js binary to run it in. Not committed to the repo — these
// are third-party binaries we don't modify, not source we authored, so
// contributors regenerate them locally instead (see CONTRIBUTING.md).
//
// Why a bundled Node binary, when Obsidian is already built on Electron
// (which embeds Node)? Forking Obsidian's own executable with
// ELECTRON_RUN_AS_NODE=1 (the usual trick for getting plain Node out of
// an Electron binary) doesn't work here — this Obsidian build has
// Electron's "runAsNode" fuse disabled — and worker_threads isn't
// available in Electron's renderer process either. A real, separately
// downloaded node(.exe) binary sidesteps both. See the comment at the
// top of src/engine/SherpaEngine.js for the full story.
//
// Run with: node scripts/fetch-native-deps.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, cpSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SHERPA_VERSION = '1.13.4';
const NODE_VERSION = '22.11.0'; // any LTS works; pinned for reproducible builds

const root = path.resolve(import.meta.dirname, '..');
const modulesDir = path.join(root, 'modules');
const tmp = path.join(os.tmpdir(), `pdf-skim-fetch-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

function fetchAndExtract(pkg, version) {
  console.log(`Fetching ${pkg}@${version}...`);
  execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent'], { cwd: tmp, stdio: 'inherit' });
  const tgz = path.join(tmp, `${pkg.replace('@', '').replace('/', '-')}-${version}.tgz`);
  const dest = path.join(tmp, pkg.replace('@', '').replace('/', '-'));
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
  return dest;
}

// ---- Windows ----
rmSync(path.join(modulesDir, 'win-x64'), { recursive: true, force: true });
mkdirSync(path.join(modulesDir, 'win-x64', 'sherpa-onnx-node'), { recursive: true });
mkdirSync(path.join(modulesDir, 'win-x64', 'sherpa-onnx-win-x64'), { recursive: true });

cpSync(fetchAndExtract('sherpa-onnx-node', SHERPA_VERSION), path.join(modulesDir, 'win-x64', 'sherpa-onnx-node'), { recursive: true });
cpSync(fetchAndExtract('sherpa-onnx-win-x64', SHERPA_VERSION), path.join(modulesDir, 'win-x64', 'sherpa-onnx-win-x64'), { recursive: true });

const nodeWin = fetchAndExtract('node-win-x64', NODE_VERSION);
cpSync(path.join(nodeWin, 'bin', 'node.exe'), path.join(modulesDir, 'win-x64', 'node.exe'));

// ---- Linux ----
rmSync(path.join(modulesDir, 'linux-x64'), { recursive: true, force: true });
mkdirSync(path.join(modulesDir, 'linux-x64', 'sherpa-onnx-node'), { recursive: true });
mkdirSync(path.join(modulesDir, 'linux-x64', 'sherpa-onnx-linux-x64'), { recursive: true });

cpSync(fetchAndExtract('sherpa-onnx-node', SHERPA_VERSION), path.join(modulesDir, 'linux-x64', 'sherpa-onnx-node'), { recursive: true });
cpSync(fetchAndExtract('sherpa-onnx-linux-x64', SHERPA_VERSION), path.join(modulesDir, 'linux-x64', 'sherpa-onnx-linux-x64'), { recursive: true });

const nodeLinux = fetchAndExtract('node-linux-x64', NODE_VERSION);
const nodeLinuxOut = path.join(modulesDir, 'linux-x64', 'node');
cpSync(path.join(nodeLinux, 'bin', 'node'), nodeLinuxOut);
chmodSync(nodeLinuxOut, 0o755);
// The published binary isn't stripped (ships debug symbols) — stripping
// cuts it roughly in half with no effect on behavior. `strip` isn't
// available on every platform this script might run from, so this is
// best-effort, not required.
try {
  execFileSync('strip', [nodeLinuxOut]);
  console.log('Stripped debug symbols from the Linux node binary.');
} catch {
  console.log('("strip" not available — Linux node binary left unstripped, still works fine.)');
}

// ---- macOS placeholder ----
// Not a target platform, so nothing is fetched automatically — left as a
// pointer to CONTRIBUTING.md rather than silently absent.
mkdirSync(path.join(modulesDir, 'mac-x64'), { recursive: true });

rmSync(tmp, { recursive: true, force: true });
console.log('Done. modules/win-x64 and modules/linux-x64 are ready to build with.');
