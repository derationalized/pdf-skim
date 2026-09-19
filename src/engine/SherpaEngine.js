/*
  SherpaEngine.js

  Plugin-side handle for the Sherpa TTS backend. Forks worker/tts-worker.js
  as a genuine child Node.js process — using a real node(.exe) binary
  bundled with this plugin under modules/<platform>/, not Obsidian's own
  executable — and exposes a plain async API:

      const engine = new SherpaEngine(pluginDir);
      await engine.init({ modelDir, numThreads: 2 });
      const { samples, sampleRate } = await engine.speak('Some sentence.');
      await engine.stop();      // hard-interrupt whatever is currently synthesizing
      await engine.dispose();

  ---- Why a bundled real Node binary, and not one of the two more obvious
  options ----

  1. Forking `process.execPath` (Obsidian.exe itself) with
     ELECTRON_RUN_AS_NODE=1 is the usual trick for getting a plain Node
     process out of an Electron binary that doesn't ship its own node
     executable, and works on many Electron apps. It doesn't on this one:
     Obsidian's packaged Windows build has Electron's "runAsNode" fuse
     disabled (a hardening measure some apps enable at build time), so the
     env var is silently ignored — the forked process launches as a second
     full Obsidian instance instead, which hits Obsidian's single-instance
     lock, forwards our worker script's path to the already-running
     instance as if it were a CLI command, and exits cleanly. No fix to the
     worker script itself could address that, since the worker script's
     code never ran at all.

  2. worker_threads (tried next) needs no separate process at all, which
     looked like a clean way to route around problem #1 entirely — but
     Electron's *renderer* process (where Obsidian plugins run) uses a
     custom V8 platform that Node's worker_threads implementation isn't
     compatible with: constructing a Worker throws "The V8 platform used
     by this instance of Node does not support creating Workers" every
     time, unconditionally. This is a renderer-process limitation with no
     workaround from inside a plugin.

  A real, separately-downloaded node(.exe) binary sidesteps both: forking
  it is forking a genuine, unrestricted Node.js process — there's no
  Electron fuse to hit (it isn't Electron at all) and no renderer-process
  V8 platform restriction to hit (it's a full separate OS process, exactly
  like a plain `node script.js` invocation would be). Downloading a real
  Node binary per platform costs real disk space (see scripts/
  fetch-native-deps.mjs, which is how modules/<platform>/node[.exe] gets
  populated) — call it a pragmatic tradeoff for two dead ends in a row on
  the "clever, no extra bytes" options.

  Also worth noting: the addon's .node file has an embedded RUNPATH of
  "$ORIGIN" (verified with `readelf -d` on the Linux build), meaning it
  finds its own sibling .so files by itself. The LD_LIBRARY_PATH env-var
  dance from an earlier version of this file was solving a problem that
  didn't actually exist.

  This is the piece that plugs into the "Speech synthesis backend" stage of
  the pipeline; swapping in a different engine later (or running the
  existing SAPI/browser speechSynthesis code as a fallback) means writing
  another class with the same speak()/stop()/dispose() shape, not touching
  this one.
*/

'use strict';

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

class SherpaEngine extends EventEmitter {
  /**
   * @param {string} pluginDir Absolute path to the plugin's own directory
   *   (e.g. `<vault>/.obsidian/plugins/pdf-skim`), so the worker and the
   *   bundled node binary can be found regardless of where the vault
   *   itself lives — including a network share.
   */
  constructor(pluginDir) {
    super();
    this.pluginDir = pluginDir;
    this.child = null;
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this._initPromise = null;

    // Kept inside the plugin folder (not a system temp dir) on purpose:
    // this plugin is often used from a synced/shared vault across more
    // than one machine, and anyone troubleshooting it — including someone
    // other than the person who installed it — should be able to find the
    // log sitting right next to the plugin itself rather than hunting
    // through an OS-specific temp path.
    this._debugLog = path.join(pluginDir, 'pdf-skim-debug.log');
  }

  _logDebug(line) {
    try {
      fs.appendFileSync(this._debugLog, `[${new Date().toISOString()}] ${line}\n`);
    } catch { /* best-effort; never let logging itself break the engine */ }
  }

  _platformDir() {
    return process.platform === 'win32' ? 'win-x64'
      : process.platform === 'darwin' ? 'mac-x64'
      : 'linux-x64';
  }

  _bundledNodePath() {
    const platformDir = this._platformDir();
    const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
    return path.join(this.pluginDir, 'modules', platformDir, exeName);
  }

  /**
   * Starts the worker and loads a model. Resolves once the model is loaded
   * and ready to synthesize; rejects if the addon or model can't be loaded
   * (missing modules/<platform>/sherpa-onnx-node, bad model folder, an
   * ambiguous model folder with no manifest.json, etc.).
   *
   * @param {string} modelDir
   * @param {number} [numThreads]
   * @param {string} [engine] Force a specific engine ('vits'|'kokoro'|
   *   'matcha'|'kitten') instead of auto-detecting from the folder's files.
   *   Needed for engines like kitten that are never guessed automatically
   *   because they're indistinguishable from kokoro on disk. See
   *   model-registry.js.
   */
  init({ modelDir, numThreads = 1, engine }) {
    if (this._initPromise) return this._initPromise;

    this._lastModelDir = modelDir;
    this._lastNumThreads = numThreads;
    this._lastEngine = engine;

    this._initPromise = new Promise((resolve, reject) => {
      const workerPath = path.join(this.pluginDir, 'worker', 'tts-worker.js');
      const nodePath = this._bundledNodePath();

      this._logDebug('--- init() called ---');
      this._logDebug(`pluginDir=${this.pluginDir}`);
      this._logDebug(`workerPath=${workerPath} exists=${fs.existsSync(workerPath)}`);
      this._logDebug(`nodePath=${nodePath} exists=${fs.existsSync(nodePath)}`);

      if (!fs.existsSync(nodePath)) {
        reject(new Error(
          `Bundled Node runtime not found at ${nodePath}. The plugin folder may not have ` +
          `been copied completely — modules/${this._platformDir()}/ should contain it.`
        ));
        return;
      }

      let forkErr = null;
      try {
        this.child = fork(workerPath, [], {
          execPath: nodePath, // a real, standalone node(.exe) — NOT Obsidian.exe.
          // No ELECTRON_RUN_AS_NODE needed: nodePath is genuinely Node, not
          // Electron pretending to be Node, so there's no fuse to fight.
          serialization: 'advanced', // lets Float32Array samples cross the IPC boundary natively
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      } catch (err) {
        forkErr = err;
      }
      this._logDebug(`fork() returned. pid=${this.child && this.child.pid} threw=${forkErr ? forkErr.stack : 'no'}`);
      if (forkErr) { reject(forkErr); return; }

      this.child.on('message', (msg) => { this._logDebug(`parent got message: ${msg && msg.type}`); this._handleMessage(msg, resolve, reject); });
      this.child.on('exit', (code, signal) => { this._logDebug(`child exited. code=${code} signal=${signal}`); this._handleExit(code, signal, reject); });
      this.child.on('error', (err) => { this._logDebug(`child 'error' event: ${err && err.stack || err}`); this._handleFatal(err, reject); });
      this.child.on('spawn', () => this._logDebug('child spawn event fired (process actually started)'));

      this._lastStderr = '';
      this.child.stdout.on('data', (d) => this._logDebug(`child stdout: ${d.toString()}`));
      this.child.stderr.on('data', (d) => {
        // Not mirrored to console.error: this fires constantly during
        // normal synthesis (native lexicon "unknown token" / "OOV" notices
        // for every word the model's dictionary doesn't recognize — not
        // errors, just noise) and would flood the dev console during
        // ordinary playback. Still fully captured below for real crash
        // diagnosis via _handleExit's error message.
        const text = d.toString();
        this._logDebug(`child stderr: ${text}`);
        this._lastStderr = (this._lastStderr + text).slice(-4000);
      });

      this.child.send({ type: 'init', modelDir, numThreads, engine });
      this._logDebug('sent init message to child');
    });

    return this._initPromise;
  }

  _handleMessage(msg, resolveInit, rejectInit) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.sampleRate = msg.sampleRate;
        this.numSpeakers = msg.numSpeakers;
        this.engine = msg.engine;
        this.detectedBy = msg.detectedBy;
        resolveInit({
          sampleRate: msg.sampleRate,
          numSpeakers: msg.numSpeakers,
          engine: msg.engine,
          detectedBy: msg.detectedBy, // 'manifest' | 'override' | 'heuristic'
        });
        break;

      case 'audio': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
        }
        break;
      }

      case 'error':
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id).reject(new Error(msg.message));
          this.pending.delete(msg.id);
        } else if (!this.ready) {
          rejectInit(new Error(msg.message));
        } else {
          // Fatal-ish error with no request id attached — surface it rather
          // than swallow it.
          this.emit('error', new Error(msg.message));
        }
        break;
    }
  }

  _handleExit(code, signal, rejectInit) {
    this.ready = false;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    const detail = (this._lastStderr || '').trim();
    const err = new Error(
      `Sherpa TTS worker exited unexpectedly (${reason})` +
      (detail ? `\n${detail}` : '') +
      `\nSee ${this._debugLog} for a step-by-step trace of what happened before the exit.`
    );
    if (!this.ready) rejectInit(err);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.emit('crash', err);
  }

  _handleFatal(err, rejectInit) {
    rejectInit(err);
    this.emit('error', err);
  }

  /**
   * Synthesizes one chunk of text. Resolves with { samples, sampleRate }
   * where samples is a Float32Array of PCM data at sampleRate — hand this
   * straight to an AudioBuffer for playback.
   */
  speak(text, { sid = 0, speed = 1.0 } = {}) {
    if (!this.ready) return Promise.reject(new Error('SherpaEngine not initialized'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ type: 'speak', id, text, sid, speed });
    });
  }

  /**
   * Hard-interrupts synthesis in progress (e.g. the user hit "skip" mid
   * sentence). Because sherpa's generate() call is synchronous inside the
   * worker's event loop, there's no clean way to cancel it mid-flight —
   * so this kills and re-forks the worker rather than trying to signal
   * into a blocked native call. Any in-flight speak() promises are
   * rejected; the model is reloaded automatically before the next speak().
   */
  async stop() {
    if (!this.child) return;
    const modelDir = this._lastModelDir;
    const numThreads = this._lastNumThreads;
    const engine = this._lastEngine;
    this.child.kill();
    this._initPromise = null;
    this.ready = false;
    if (modelDir) await this.init({ modelDir, numThreads, engine });
  }

  dispose() {
    return new Promise((resolve) => {
      if (!this.child) return resolve();
      this.child.once('exit', () => resolve());
      this.child.send({ type: 'shutdown' });
      // Belt-and-suspenders: don't hang forever if the worker is stuck
      // inside a native call and never processes the shutdown message.
      setTimeout(() => { if (this.child) this.child.kill(); }, 2000);
    });
  }
}

module.exports = SherpaEngine;
