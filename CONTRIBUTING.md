# Contributing to PDF-Skim

This covers building the plugin from source. For how to *use* the plugin, see [README.md](README.md).

## Project layout

- `src/` — all plugin source. This is what you edit.
- `scripts/hand-bundle.js` — bundles `src/main.js` and everything it locally requires into a single `main.js` at the project root. No npm dependencies needed to run it — just Node itself.
- `scripts/fetch-native-deps.mjs` — downloads the Sherpa-ONNX speech engine and a real Node.js binary into `modules/win-x64/` and `modules/linux-x64/`.
- `scripts/fetch-pdfjs.mjs` — downloads `pdf.js` and vendors it as `pdfjs/pdf.mjs` (the library) and `pdf.worker.js` (its parsing worker).
- `worker/tts-worker.js` and `worker/model-registry.js` — plain copies of `src/worker/tts-worker.js` and `src/worker/model-registry.js`. Not bundled (this file gets forked as its own process by a real Node binary, not loaded by Obsidian), just copied as-is.

None of `modules/`, `pdfjs/`, `pdf.worker.js`, `worker/*.js`, or `main.js` are committed to this repo — they're all build output (either bundled from `src/`, or third-party files we don't modify, fetched fresh). If you've just cloned the repo, none of these exist yet; the steps below create them.

## Building

You need [Node.js](https://nodejs.org) installed. No `npm install` is required for the plugin's own code — `package.json` declares no dependencies, since nothing here is bundled from npm at build time (`pdf.js` is vendored as a static file instead — see `fetch-pdfjs.mjs` above).

```
node scripts/fetch-native-deps.mjs   # populates modules/ (~85MB win, ~95MB linux, one-time unless bumping versions)
node scripts/fetch-pdfjs.mjs         # populates pdfjs/pdf.mjs and pdf.worker.js (one-time unless bumping versions)
npm run build                        # writes main.js from src/ — re-run this after every source change
```

`npm run build` runs `scripts/hand-bundle.js` (which writes its output to
`dist-handbuilt/main.js`, not directly to the project root), copies that
to the actual `main.js` Obsidian loads, and copies `worker/tts-worker.js`
+ `worker/model-registry.js` from `src/worker/` (a plain file copy, no
bundling needed — see "Project layout" above). Re-run it after every
source change.

To test your build, copy the project root (with `main.js`, `manifest.json`, `styles.css`, `modules/`, `pdfjs/`, `pdf.worker.js`, and `worker/` all present) into `<vault>/.obsidian/plugins/pdf-skim/` in a real Obsidian vault. There's no automated test suite; verify manually against a real PDF.

## Why the build looks like this

**Why hand-bundle.js instead of a normal bundler (esbuild, webpack, ...)?** It avoids needing `npm install` (and everything that can go wrong with a specific npm/Node/OS combination) just to build the plugin. It only handles what this project actually needs — CommonJS `require()` of local files — not the general case a real bundler solves.

**Why is `pdf.js` vendored as static files instead of bundled from npm?** `extractPdfSegments()` (in `src/pdf/extractor.js`) needs to hand `pdf.js` its own worker script at runtime, and Obsidian's renderer blocks loading that from a `file://` path — it has to be read into memory and handed over as a Blob URL instead. That's much simpler to do from a plain vendored file than from something a bundler produced.

**Why does `modules/` include a full Node.js binary, not just the speech engine?** The speech engine runs in its own process, so a multi-second synthesis call never freezes the Obsidian UI. Forking Obsidian's own executable with `ELECTRON_RUN_AS_NODE=1` (the usual trick for getting plain Node out of an Electron binary) doesn't work here — this Obsidian build has Electron's "runAsNode" capability disabled — and `worker_threads` isn't available in Electron's renderer process either. A real, separately-downloaded Node binary sidesteps both problems, at the cost of the extra download size. See the comment at the top of `src/engine/SherpaEngine.js` for the full story.

## Adding macOS support

`modules/mac-x64/` isn't populated by `fetch-native-deps.mjs` — macOS isn't a target platform this project builds for. To add it:

1. On a Mac, with Node.js installed:
   ```
   mkdir sherpa-tmp && cd sherpa-tmp
   npm init -y
   npm install sherpa-onnx-node
   ```
2. This produces a `node_modules` folder containing `sherpa-onnx-node` and either `sherpa-onnx-darwin-x64` (Intel) or `sherpa-onnx-darwin-arm64` (Apple Silicon). Copy **both** folders into `modules/mac-x64/`.
3. Copy your Mac's own `node` binary (`which node`, or the one from step 1's Node.js install) into `modules/mac-x64/node`, alongside the two folders from step 2.

## Submitting changes

Open a pull request with a clear description of what changed and why. If you're touching the text-extraction heuristics (`src/pdf/extractor.js`) or the pipeline filtering rules (`src/pipeline/`), a before/after example against a real PDF is far more convincing than a description — enable **Debug mode** in the plugin's settings to see exactly which pause/replacement decisions fire and why.
