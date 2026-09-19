'use strict';

const path = require('path');
const { Plugin, Notice, TFile, MarkdownView } = require('obsidian');

const { extractPdfSegments } = require('./pdf/extractor');
const { processSegments } = require('./pipeline/TextPipeline');
const { DEFAULT_CONFIG } = require('./pipeline/defaultConfig');
const SherpaEngine = require('./engine/SherpaEngine');
const { PlaybackController } = require('./playback/PlaybackController');
const { PdfSkimSettingTab } = require('./ui/SettingsTab');
const { PlayerView, VIEW_TYPE, activatePlayerView } = require('./ui/PlayerView');
const { getCurrentPage, getSelectionInfo } = require('./obsidian/pdfViewerBridge');

const DEFAULT_SETTINGS = {
  modelDir: '', // folder name under <plugin>/models/, or an absolute path
  engineOverride: '', // '' = auto-detect
  numThreads: 2,
  speed: 1.0,
  config: DEFAULT_CONFIG,
  rememberPosition: true, // save each PDF's last-heard page for the "Resume" hint
  lastPositions: {}, // { [file.path]: pageNumber }
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return override !== undefined ? override : base;
  if (typeof base !== 'object' || base === null) return override !== undefined ? override : base;
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (override && Object.prototype.hasOwnProperty.call(override, k)) {
      out[k] = deepMerge(base[k], override[k]);
    }
  }
  return out;
}

class PdfSkimPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.sherpa = null;
    this.playback = new PlaybackController(this);

    this.registerView(VIEW_TYPE, (leaf) => new PlayerView(leaf, this));

    this.addRibbonIcon('audio-lines', 'PDF-Skim: open player', () => activatePlayerView(this));

    this.addCommand({
      id: 'open-player',
      name: 'Open player panel',
      callback: () => activatePlayerView(this),
    });
    this.addCommand({
      id: 'narrate-active',
      name: 'Narrate active PDF (from the beginning)',
      callback: () => this.narrateActiveFile(),
    });
    this.addCommand({
      id: 'play-current-page',
      name: 'Play from current PDF page',
      callback: () => this.playFrom('current-page'),
    });
    this.addCommand({
      id: 'play-cursor',
      name: 'Play from cursor / text selection',
      callback: () => this.playFrom('cursor'),
    });
    this.addCommand({
      id: 'play-selection-only',
      name: 'Play only selected text',
      callback: () => this.playSelectionOnly(),
    });
    this.addCommand({
      id: 'play-pause',
      name: 'Play / pause narration',
      callback: () => this.playback.togglePlayPause(),
    });
    this.addCommand({
      id: 'stop',
      name: 'Stop narration',
      callback: () => this.playback.stop(),
    });
    this.addCommand({
      id: 'skip-forward',
      name: 'Skip to next passage',
      callback: () => this.playback.skip(1),
    });
    this.addCommand({
      id: 'skip-back',
      name: 'Skip to previous passage',
      callback: () => this.playback.skip(-1),
    });
    this.addCommand({
      id: 'next-heading',
      name: 'Jump to next heading',
      callback: () => { if (!this.playback.jumpToHeading(1)) new Notice('PDF-Skim: no later heading found.'); },
    });
    this.addCommand({
      id: 'prev-heading',
      name: 'Jump to previous heading',
      callback: () => { if (!this.playback.jumpToHeading(-1)) new Notice('PDF-Skim: no earlier heading found.'); },
    });
    this.addCommand({
      id: 'return-to-document',
      name: 'Return to document (exit "play only selection")',
      callback: () => this.playback.returnToDocument(),
    });
    this.addCommand({
      id: 'insert-link',
      name: 'Insert link to current passage into active note',
      callback: () => this.playback.insertLinkAtCursor(),
    });

    this.statusBarEl = this.addStatusBarItem();
    this._lastSavedPage = null;
    this._savePositionTimer = null;
    this.playback.on('update', (status) => {
      this._renderStatusBar(status);
      this._maybeSavePosition(status);
    });
    this._renderStatusBar(this.playback.getStatus());

    // "Insert link" is triggered from the player panel — a side leaf —
    // so by the time it's clicked, the panel itself (not the note) is
    // the active leaf. getActiveViewOfType(MarkdownView) alone would
    // therefore report "no note open" even with one sitting right next
    // to it; remembering the last-focused one is the fix (see
    // getTargetMarkdownView()).
    this._lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView) || null;
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && leaf.view instanceof MarkdownView) this._lastMarkdownView = leaf.view;
    }));

    this.addSettingTab(new PdfSkimSettingTab(this.app, this));
  }

  _renderStatusBar(status) {
    if (status.state === 'stopped' || !status.fileName) {
      this.statusBarEl.setText('');
      return;
    }
    const icon = status.state === 'playing' ? '▶' : '⏸';
    const page = status.currentPage != null ? ` — p.${status.currentPage}` : '';
    this.statusBarEl.setText(`${icon} PDF-Skim: ${status.fileName}${page}`);
  }

  /** Debounced save of "what page was this file last heard on," so the
   *  player panel can offer a Resume hint next time it's opened. Debounced
   *  (rather than on every cue) since currentPage only actually changes a
   *  handful of times a minute during normal narration, but the update
   *  event fires far more often than that. */
  _maybeSavePosition(status) {
    if (!this.settings.rememberPosition || !status.filePath || status.currentPage == null) return;
    if (status.currentPage === this._lastSavedPage) return;
    this._lastSavedPage = status.currentPage;
    clearTimeout(this._savePositionTimer);
    this._savePositionTimer = setTimeout(() => {
      this.settings.lastPositions[status.filePath] = status.currentPage;
      this.saveSettings();
    }, 2000);
  }

  getLastPosition(file) {
    if (!file) return null;
    return this.settings.lastPositions[file.path] ?? null;
  }

  /** The note to insert a link into: the active view if a markdown note
   *  is genuinely focused, otherwise the most recently focused one (see
   *  the active-leaf-change listener in onload() for why the plain
   *  "active view" check alone isn't enough when this is called from the
   *  player panel). Returns null only if no markdown leaf is open at all,
   *  or the remembered one has since been closed. */
  getTargetMarkdownView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const lastLeaf = this._lastMarkdownView && this._lastMarkdownView.leaf;
    if (lastLeaf && this.app.workspace.getLeavesOfType('markdown').includes(lastLeaf)) {
      return this._lastMarkdownView;
    }
    return null;
  }

  onunload() {
    this.playback.stop();
    if (this.sherpa) this.sherpa.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = deepMerge(DEFAULT_SETTINGS, saved || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Absolute filesystem path to this plugin's own folder — needed because
   *  SherpaEngine forks worker/tts-worker.js by absolute path and the
   *  worker looks for native addons under modules/<platform>/ relative to
   *  itself. Requires the desktop (FileSystemAdapter) vault, same as the
   *  child_process usage elsewhere in this plugin — there is no mobile
   *  support, consistent with Sherpa needing a native Node addon. */
  getPluginDir() {
    const basePath = this.app.vault.adapter.getBasePath
      ? this.app.vault.adapter.getBasePath()
      : null;
    if (!basePath) {
      throw new Error('PDF-Skim requires Obsidian desktop (a local vault) — mobile is not supported.');
    }
    return path.join(basePath, this.manifest.dir);
  }

  resolveModelDir() {
    const configured = this.settings.modelDir;
    if (!configured) {
      throw new Error(
        'No speech model configured yet. Open Settings -> PDF-Skim and set a model folder ' +
        '(see the plugin README for where to download one).'
      );
    }
    return path.isAbsolute(configured)
      ? configured
      : path.join(this.getPluginDir(), 'models', configured);
  }

  async getSherpaEngine() {
    if (this.sherpa && this.sherpa.ready) return this.sherpa;
    this.sherpa = new SherpaEngine(this.getPluginDir());
    const modelDir = this.resolveModelDir();
    await this.sherpa.init({
      modelDir,
      numThreads: this.settings.numThreads,
      engine: this.settings.engineOverride || undefined,
    });
    return this.sherpa;
  }

  /** The active PDF, if one is open — otherwise whatever's already
   *  loaded into the player, so "play from current page/cursor" still
   *  works while the user's focus is on a markdown note rather than the
   *  PDF tab itself. Returns null only when neither applies. */
  resolveTargetFile() {
    const active = this.app.workspace.getActiveFile();
    if (active instanceof TFile && active.extension === 'pdf') return active;
    if (this.playback.file) return this.playback.file;
    return null;
  }

  /** Extracts + filters + loads `file` into the playback controller.
   *  Doesn't seek or start playback itself — callers do that afterward
   *  so a seek can be computed once, up front, and applied to the fresh
   *  cue queue. @returns {Promise<boolean>} whether loading succeeded. */
  async _loadFile(file) {
    let engine;
    try {
      engine = await this.getSherpaEngine();
    } catch (err) {
      new Notice(`PDF-Skim: couldn't start the speech engine — ${err.message}`, 10000);
      console.error('[pdf-skim]', err);
      return false;
    }

    new Notice(`PDF-Skim: reading "${file.name}"...`);
    let segments, pageCount;
    try {
      const buffer = await this.app.vault.readBinary(file);
      const extracted = await extractPdfSegments(buffer, { pluginDir: this.getPluginDir() });
      segments = processSegments(extracted.segments, this.settings.config);
      pageCount = extracted.pageCount;
    } catch (err) {
      new Notice(`PDF-Skim: couldn't extract that PDF — ${err.message}`, 10000);
      console.error('[pdf-skim]', err);
      return false;
    }

    if (!segments.length) {
      new Notice('PDF-Skim: no readable text found in that PDF (is it scanned/image-only?).');
      return false;
    }

    await this.playback.load(file, segments, engine, this.settings.speed, pageCount);
    // Snapshot of exactly what produced these cues — see playFrom()'s
    // alreadyLoaded check, which is what actually reads this. Without it,
    // changing any filtering/pause/substitution setting after a file's
    // first load in a session had no effect on that file until either a
    // different file was loaded first or Obsidian was restarted, since
    // "same file path, non-empty cue queue" was the only condition
    // checked — true regardless of whether the config used to build that
    // queue was still current.
    this._loadedConfigJSON = JSON.stringify(this.settings.config);
    return true;
  }

  /** Single entry point for every "start playback from ___" control —
   *  the panel's Beginning/Current page/Cursor buttons and its page
   *  spinner, plus the equivalent commands, all call this.
   *  @param {'beginning'|'current-page'|'cursor'|number} mode a mode
   *    name, or an explicit 1-based page number typed into the spinner. */
  async playFrom(mode) {
    const file = this.resolveTargetFile();
    if (!file) {
      new Notice('PDF-Skim: open a PDF file first.');
      return;
    }

    // Any normal "start from ___" action means "I'm done with the
    // selection-only detour" — restore the document's real cue queue
    // before the alreadyLoaded check below, or it would see the
    // selection's ad-hoc cues and wrongly think the document itself
    // still needs (re)loading, or wrongly think it doesn't.
    if (this.playback.inSelectionMode) this.playback.returnToDocument();

    let targetPage = null;
    let targetText = null;

    if (mode === 'current-page') {
      targetPage = getCurrentPage(this.app, file);
      if (targetPage == null) {
        new Notice('PDF-Skim: couldn\'t read the PDF viewer\'s current page — make sure the PDF tab is open, then try again.', 8000);
        return;
      }
    } else if (mode === 'cursor') {
      const info = getSelectionInfo(this.app, file);
      if (!info) {
        new Notice('PDF-Skim: select some text in the PDF first, then try "Play from cursor" again.', 8000);
        return;
      }
      targetText = info.text;
      targetPage = info.page;
    } else if (typeof mode === 'number' && Number.isFinite(mode)) {
      targetPage = Math.max(1, Math.floor(mode));
    } // 'beginning' (or anything else) leaves both null

    // Re-extracting a already-loaded PDF just to seek within it would be
    // slow and pointless — only load from disk if this is a different
    // file, nothing's loaded yet, or a filtering/pause/substitution
    // setting changed since the cues currently in memory were built
    // (comparing the live config against the snapshot taken at that
    // load — see _loadFile).
    const sameFile = this.playback.file && this.playback.file.path === file.path && this.playback.cues.length > 0;
    const configUnchanged = this._loadedConfigJSON === JSON.stringify(this.settings.config);
    const alreadyLoaded = sameFile && configUnchanged;
    if (!alreadyLoaded) {
      const ok = await this._loadFile(file);
      if (!ok) return;
    }

    if (targetText) {
      const found = this.playback.seekToText(targetText, targetPage);
      if (!found) {
        if (targetPage != null) this.playback.seekToPage(targetPage);
        new Notice('PDF-Skim: couldn\'t match that exact selection — starting from the nearest page instead.', 6000);
      }
    } else if (targetPage != null) {
      this.playback.seekToPage(targetPage);
    } else {
      this.playback.seekToStart();
    }

    await this.playback.play();
  }

  async narrateActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile) || file.extension !== 'pdf') {
      new Notice('PDF-Skim: open a PDF file first.');
      return;
    }
    await this.playFrom('beginning');
  }

  /** Narrates only the text currently selected in the PDF viewer — for a
   *  multi-column layout where a page-order seek (even "play from
   *  cursor") would still read straight through whatever sits between
   *  the selected column and the next matching text. See
   *  PlaybackController.playSelectionOnly()'s doc comment for the full
   *  reasoning. */
  async playSelectionOnly() {
    const file = this.resolveTargetFile();
    if (!file) {
      new Notice('PDF-Skim: open a PDF file first.');
      return;
    }
    const info = getSelectionInfo(this.app, file);
    if (!info) {
      new Notice('PDF-Skim: select some text in the PDF first.', 6000);
      return;
    }

    const sameFile = this.playback.file && this.playback.file.path === file.path;
    const configUnchanged = this._loadedConfigJSON === JSON.stringify(this.settings.config);
    const alreadyLoaded = sameFile && configUnchanged;
    if (!alreadyLoaded) {
      const ok = await this._loadFile(file);
      if (!ok) return;
    }

    await this.playback.playSelectionOnly(info.text, info.page);
  }
}

module.exports = PdfSkimPlugin;
