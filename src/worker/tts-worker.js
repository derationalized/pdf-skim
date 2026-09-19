/*
  tts-worker.js

  Runs as a forked child process — under a real, bundled node(.exe) binary
  (modules/<platform>/node[.exe]), not Obsidian.exe. See SherpaEngine.js
  for the two dead ends (Obsidian's Electron build has the "runAsNode"
  fuse disabled; worker_threads doesn't work in Electron's renderer
  process at all) that led here.

  This file is platform-agnostic. It figures out which prebuilt addon to
  load (modules/linux-x64/... or modules/win-x64/...) at runtime, based on
  process.platform. No LD_LIBRARY_PATH/DYLD_LIBRARY_PATH setup is needed:
  the .node addon has an embedded RUNPATH of "$ORIGIN" (confirmed with
  `readelf -d` on the Linux build), so it finds its own sibling .so files
  by itself regardless of environment variables.

  IPC protocol (all messages are plain objects, sent via process.send /
  process.on('message') — advanced serialization is enabled by the
  parent's fork() call, so Float32Array sample buffers cross the boundary
  natively, no base64 round-trip):

    parent -> worker
      { type: 'init',   modelDir, engine, numThreads, sid, speed }
      { type: 'speak',  id, text, speed? }
      { type: 'shutdown' }

    worker -> parent
      { type: 'ready',  sampleRate, numSpeakers }
      { type: 'audio',  id, samples, sampleRate }
      { type: 'error',  id?, message }   // id present => this request failed,
                                          // id absent  => init/fatal failure
*/

'use strict';

const path = require('path');
const fs = require('fs');

const { resolveModel } = require('./model-registry');

let sherpaOnnx = null;
let tts = null;
let currentGeneration = 0; // bumped on every 'speak' so stale results can be dropped

// Shared with SherpaEngine.js — same file, inside the plugin folder
// (not an OS temp dir) so anyone troubleshooting this, not necessarily the
// person who installed it, can find one unified, interleaved trace of
// both sides sitting right next to the plugin itself.
const DEBUG_LOG = path.join(path.resolve(__dirname, '..'), 'pdf-skim-debug.log');
function logDebug(line) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* best-effort; never let logging itself crash the worker */ }
}
logDebug(`worker starting. pid=${process.pid} platform=${process.platform} arch=${process.arch} connected=${process.connected}`);

function pluginDir() {
  // This file lives at <pluginDir>/worker/tts-worker.js
  return path.resolve(__dirname, '..');
}

function addonDir() {
  // Mirrors SherpaEngine.js's platformDir choice on the parent side — kept
  // in sync manually since this file runs in its own forked process and
  // can't import a shared constant from there without adding a bundler
  // dependency between the two.
  const platformDir = process.platform === 'win32' ? 'win-x64'
    : process.platform === 'darwin' ? 'mac-x64'
    : 'linux-x64';
  return path.join(pluginDir(), 'modules', platformDir, 'sherpa-onnx-node');
}

function loadAddon() {
  const dir = addonDir();
  logDebug(`looking for addon at: ${dir}`);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No sherpa-onnx-node build found at ${dir}. ` +
      `This plugin should ship with it prebuilt for Windows and Linux — ` +
      `if it's missing, the plugin folder may not have been copied completely.`
    );
  }
  return require(dir);
}

function buildTtsConfig(modelDir, engineOverride, numThreads) {
  const { engine, modelConfig, topLevel, detectedBy } = resolveModel(modelDir, engineOverride);
  const config = {
    model: {
      ...modelConfig,
      debug: false,
      numThreads: numThreads || 1,
      provider: 'cpu',
    },
    maxNumSentences: 1, // we do our own sentence segmentation upstream; don't let sherpa re-chunk
    ...topLevel,
  };
  return { config, engine, detectedBy };
}

function handleInit(msg) {
  logDebug(`handling init: modelDir=${msg.modelDir} engine=${msg.engine || '(auto)'} numThreads=${msg.numThreads}`);
  sherpaOnnx = loadAddon();
  logDebug('addon loaded OK');
  const { config, engine, detectedBy } = buildTtsConfig(msg.modelDir, msg.engine, msg.numThreads);
  logDebug(`model resolved: engine=${engine} detectedBy=${detectedBy}`);
  tts = new sherpaOnnx.OfflineTts(config);
  logDebug('OfflineTts constructed OK, sending ready');
  process.send({
    type: 'ready',
    sampleRate: tts.sampleRate,
    numSpeakers: tts.numSpeakers,
    engine,
    detectedBy, // 'manifest' | 'override' | 'heuristic' — lets the UI show "guessed: kokoro"
  });
}

function handleSpeak(msg) {
  // Synthesis is a synchronous native call — it blocks this process's event
  // loop for the duration. That's fine (that's *why* this runs in its own
  // process and not Obsidian's), but it does mean a 'shutdown' or a newer
  // 'speak' can't interrupt one already in flight. We track a generation
  // counter so results superseded by a skip/stop are dropped on arrival
  // rather than played out of order; a hard interrupt (e.g. the user hits
  // skip mid-sentence on a very long paragraph) means killing and
  // re-forking the worker, which SherpaEngine.js does rather than trying
  // to signal into a blocked native call.
  const myGeneration = ++currentGeneration;
  const id = msg.id;

  if (!tts) {
    process.send({ type: 'error', id, message: 'speak() called before init completed' });
    return;
  }

  try {
    const generationConfig = new sherpaOnnx.GenerationConfig({
      sid: msg.sid || 0,
      speed: msg.speed || 1.0,
      silenceScale: 0.2,
    });
    const audio = tts.generate({ text: msg.text, generationConfig });

    if (myGeneration !== currentGeneration) return; // superseded while we were generating

    process.send(
      { type: 'audio', id, samples: audio.samples, sampleRate: audio.sampleRate }
    );
  } catch (err) {
    process.send({ type: 'error', id, message: String(err && err.message || err) });
  }
}

process.on('message', (msg) => {
  logDebug(`received message: ${msg && msg.type}`);
  switch (msg.type) {
    case 'init':
      try {
        handleInit(msg);
      } catch (err) {
        logDebug(`init failed: ${err && err.stack || err}`);
        process.send({ type: 'error', message: String(err && err.message || err) });
      }
      break;
    case 'speak':
      handleSpeak(msg);
      break;
    case 'shutdown':
      logDebug('received shutdown, exiting');
      process.exit(0);
      break;
    default:
      process.send({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
});

// If the parent dies without sending 'shutdown' (Obsidian crashed, force-quit,
// etc.), don't linger as an orphan process. This process is a genuine
// separate Node process now (not Obsidian.exe pretending to be one), so a
// 'disconnect' here reliably means the IPC pipe actually closed — no need
// for the earlier "ignore it until ready" guard that was worked around a
// different architecture's quirks.
process.on('disconnect', () => {
  logDebug('disconnect event fired, exiting');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logDebug(`UNCAUGHT EXCEPTION: ${err && err.stack || err}`);
  try { process.send({ type: 'error', message: `uncaught: ${String(err && err.message || err)}` }); } catch { /* channel may be gone */ }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logDebug(`UNHANDLED REJECTION: ${err && err.stack || err}`);
});

logDebug(`setup complete, listening for messages. connected=${process.connected}`);
