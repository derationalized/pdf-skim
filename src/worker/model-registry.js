/*
  model-registry.js

  Turns "a folder of model files" into the engine-specific config object
  sherpa-onnx-node expects. Deliberately has zero dependency on
  sherpa-onnx-node itself or any native addon — it's just fs/path — so it's
  safe to require directly from Obsidian's own process (e.g. a future
  settings-UI "here's what I detected" preview) without forking a worker
  first, as well as from tts-worker.js at actual load time.

  Supported engines: vits, kokoro, matcha, kitten. This list is the
  extension point — adding a new sherpa-onnx TTS engine means adding one
  entry to ENGINE_ADAPTERS (and to ENGINE_DETECTION_ORDER if it should be
  auto-detectable), not touching the worker or SherpaEngine.js at all.

  Deliberately NOT covered: voice-cloning engines (zipvoice, pocket,
  supertonic) — those need a reference audio clip + its transcript per
  request, not just text, which doesn't fit a "hand it a sentence, get PCM
  back" queue. Worth a separate code path later if you want cloned voices,
  not a fit for this one.

  ── Auto-detection ──────────────────────────────────────────────────────
  File-shape heuristics, tried in ENGINE_DETECTION_ORDER:
    matcha : 2+ .onnx files, one of them named like a vocoder/vocos file
    kokoro : exactly 1 .onnx file + voices.bin present
    vits   : exactly 1 .onnx file + tokens.txt, no voices.bin
  kitten shares kokoro's on-disk shape (model + voices.bin + tokens) with
  no reliable distinguishing file, so it is never auto-selected — reach it
  via manifest.json or an explicit engine override.

  ── Escape hatch: manifest.json ─────────────────────────────────────────
  Drop a manifest.json in the model folder to bypass heuristics entirely:

    {
      "engine": "kitten",
      "files": {
        "model": "model.onnx",
        "voices": "voices.bin",
        "tokens": "tokens.txt",
        "dataDir": "espeak-ng-data"
      }
    }

  "files" keys are whatever the target engine's config object expects
  (see ENGINE_ADAPTERS below for the shape each one builds) and values are
  filenames relative to the model folder.
*/

'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_ENGINES = ['vits', 'kokoro', 'matcha', 'kitten'];
const ENGINE_DETECTION_ORDER = ['matcha', 'kokoro', 'vits'];

function isDir(modelDir, f) {
  try { return fs.statSync(path.join(modelDir, f)).isDirectory(); } catch { return false; }
}

function abs(modelDir, file) {
  return file ? path.join(modelDir, file) : '';
}

function readManifest(modelDir) {
  const p = path.join(modelDir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json in ${modelDir} isn't valid JSON: ${err.message}`);
  }
}

/** Pure file-shape inspection — no guessing about *meaning* happens here. */
function inspect(modelDir) {
  const entries = fs.readdirSync(modelDir);
  const onnxFiles = entries.filter(f => f.endsWith('.onnx'));
  const vocoderOnnx = onnxFiles.find(f => /vocoder|vocos/i.test(f));
  const acousticOnnx = onnxFiles.find(f => f !== vocoderOnnx) || onnxFiles[0];

  return {
    entries,
    onnxFiles,
    vocoderOnnx,
    acousticOnnx,
    hasTokens: entries.includes('tokens.txt'),
    hasVoicesBin: entries.includes('voices.bin'),
    dataDir: entries.find(f => f === 'espeak-ng-data' && isDir(modelDir, f)),
    lexicon: entries.find(f => /^lexicon.*\.txt$/i.test(f)),
    // Chinese-language models frequently ship number/date/phone normalization
    // rules as separate FST files sitting right in the model folder.
    ruleFsts: ['phone.fst', 'date.fst', 'number.fst'].filter(f => entries.includes(f)),
  };
}

const ENGINE_ADAPTERS = {
  vits: {
    detect: (info) => info.onnxFiles.length === 1 && info.hasTokens && !info.hasVoicesBin,
    // Covers Piper, Coqui, and icefall VITS releases alike, single- or
    // multi-speaker (VCTK, libritts_r, ...) — speaker selection is a
    // per-request `sid`, not a config-shape difference.
    build: (modelDir, info) => ({
      vits: {
        model: abs(modelDir, info.onnxFiles[0]),
        tokens: abs(modelDir, 'tokens.txt'),
        dataDir: abs(modelDir, info.dataDir),
        lexicon: abs(modelDir, info.lexicon),
      },
    }),
  },

  kokoro: {
    // NOTE: this file shape (1 onnx + voices.bin + tokens) is identical to
    // kitten's — see AMBIGUOUS_SHAPES below, which intercepts this case
    // *before* detect() is consulted so an actual Kitten model never
    // silently loads as Kokoro. detect() here only fires once that check
    // has already ruled kitten out.
    detect: (info) => info.onnxFiles.length === 1 && info.hasVoicesBin,
    build: (modelDir, info) => ({
      kokoro: {
        model: abs(modelDir, info.onnxFiles[0]),
        voices: abs(modelDir, 'voices.bin'),
        tokens: abs(modelDir, 'tokens.txt'),
        dataDir: abs(modelDir, info.dataDir),
        lexicon: abs(modelDir, info.lexicon),
      },
    }),
  },

  matcha: {
    detect: (info) => info.onnxFiles.length >= 2 && !!info.vocoderOnnx,
    build: (modelDir, info) => ({
      matcha: {
        acousticModel: abs(modelDir, info.acousticOnnx),
        vocoder: abs(modelDir, info.vocoderOnnx),
        tokens: abs(modelDir, 'tokens.txt'),
        dataDir: abs(modelDir, info.dataDir),
        lexicon: abs(modelDir, info.lexicon),
      },
    }),
  },

  kitten: {
    // Same on-disk shape as kokoro (model + voices.bin + tokens); no file
    // reliably tells them apart, so kitten is reachable only via
    // manifest.json or an explicit engine override — never guessed.
    detect: () => false,
    build: (modelDir, info) => ({
      kitten: {
        model: abs(modelDir, info.onnxFiles[0]),
        voices: abs(modelDir, 'voices.bin'),
        tokens: abs(modelDir, 'tokens.txt'),
        dataDir: abs(modelDir, info.dataDir),
        lengthScale: 1.0,
      },
    }),
  },
};

// Groups of engines that are genuinely indistinguishable by file shape
// alone. Checked *before* heuristic detection: if a folder matches one of
// these shapes and there's no override/manifest to break the tie, resolving
// must fail loudly rather than silently pick the first match in
// ENGINE_DETECTION_ORDER. A wrong-but-plausible guess (wrong voice, wrong
// config fields silently ignored by the native layer) is worse than an
// error that tells you exactly what to do about it.
const AMBIGUOUS_SHAPES = [
  {
    // A lexicon file is real evidence, not a coin flip: Kokoro's config
    // accepts a `lexicon` field and official Kokoro releases ship one;
    // Kitten's config has no such field. Only flag ambiguity for the truly
    // bare case (just model + voices.bin + tokens, nothing else to go on).
    matches: (info) => info.onnxFiles.length === 1 && info.hasVoicesBin && !info.lexicon,
    candidates: ['kokoro', 'kitten'],
  },
];

/**
 * @param {string} modelDir
 * @param {string} [engineOverride] Force a specific engine (settings-UI
 *   dropdown), skipping auto-detection but not the manifest.
 * @returns {{ engine: string, modelConfig: object, topLevel: object, detectedBy: 'manifest'|'override'|'heuristic' }}
 */
function resolveModel(modelDir, engineOverride) {
  const manifest = readManifest(modelDir);
  const info = inspect(modelDir);

  let engine = engineOverride || (manifest && manifest.engine);
  let detectedBy = engineOverride ? 'override' : (manifest && manifest.engine) ? 'manifest' : null;

  if (!engine) {
    const ambiguity = AMBIGUOUS_SHAPES.find(shape => shape.matches(info));
    if (ambiguity) {
      throw new Error(
        `The model in ${modelDir} could be any of: ${ambiguity.candidates.join(', ')} ` +
        `— they look identical from the files alone (found: ${info.entries.join(', ')}). ` +
        `Add a manifest.json ({"engine": "${ambiguity.candidates[0]}", ...}) to this folder, ` +
        `or pick the engine explicitly in settings.`
      );
    }

    engine = ENGINE_DETECTION_ORDER.find(name => ENGINE_ADAPTERS[name].detect(info));
    detectedBy = 'heuristic';
    if (!engine) {
      throw new Error(
        `Couldn't tell what kind of model is in ${modelDir} from its files ` +
        `(found: ${info.entries.join(', ') || '(empty)'}). Add a manifest.json ` +
        `({"engine": "${SUPPORTED_ENGINES.join('"|"')}", ...}) to this folder, ` +
        `or pick the engine explicitly in settings.`
      );
    }
  }

  if (!ENGINE_ADAPTERS[engine]) {
    throw new Error(`Unknown engine "${engine}". Supported: ${SUPPORTED_ENGINES.join(', ')}`);
  }

  let modelConfig;
  if (manifest && manifest.files) {
    // Manifest fully specifies filenames for this engine — resolve to
    // absolute paths and use as-is, bypassing heuristics entirely.
    const resolved = {};
    for (const [key, file] of Object.entries(manifest.files)) resolved[key] = abs(modelDir, file);
    modelConfig = { [engine]: resolved };
  } else {
    modelConfig = ENGINE_ADAPTERS[engine].build(modelDir, info);
  }

  const topLevel = {};
  if (info.ruleFsts.length) topLevel.ruleFsts = info.ruleFsts.map(f => abs(modelDir, f)).join(',');

  return { engine, modelConfig, topLevel, detectedBy };
}

module.exports = { resolveModel, inspect, SUPPORTED_ENGINES, ENGINE_DETECTION_ORDER };
