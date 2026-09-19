/*
  ui/PlayerView.js

  The visible control panel, opened in a workspace leaf (default: right
  sidebar) via the ribbon icon or command palette. Subscribes to
  PlaybackController's 'update' events rather than the controller
  reaching into this view directly, so this is just one of potentially
  several listeners (the status bar item is another).

  Layout, top to bottom:
    - title (file name currently loaded)
    - "Start playback from" — a page-number spinner plus Beginning /
      Current page / Cursor buttons, a "selection only" button for
      multi-column layouts (see PlaybackController.playSelectionOnly),
      and a Resume hint when a saved position exists for the active PDF.
      This is the answer to "it only ever plays from the very start":
      every one of these routes through plugin.playFrom() (or
      plugin.playSelectionOnly()), which loads the PDF if needed and then
      seeks before playback begins.
    - a banner, shown only while selection-only playback is active, with
      a button back to normal document playback
    - transport: sentence skip back/forward, play/pause, stop, and
      heading skip back/forward (for hopping past a run of section
      headings read back-to-back — see PlaybackController.jumpToHeading)
    - a page scrubber (drag to seek) — replaces the old cue-count
      progress bar, which was a meaningless "3,412 / 9,801" style
      fraction on a long document. Page number is something the reader
      actually reasons about.
    - a one-line "now reading" preview of the current cue's text, mostly
      useful for confirming a cursor/page seek landed where expected
    - speed slider, speaker dropdown (multi-speaker models only), and
      the existing "insert link to current passage" action
*/

'use strict';

const { ItemView, Notice, setIcon } = require('obsidian');

const VIEW_TYPE = 'pdf-skim-player';

class PlayerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this._onUpdate = (status) => this._render(status);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'PDF-Skim'; }
  getIcon() { return 'audio-lines'; }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('pdf-skim-player');

    this.titleEl = root.createEl('div', { cls: 'pdf-skim-player-title', text: 'No PDF loaded' });

    // ---- Start playback from ----
    root.createEl('div', { cls: 'pdf-skim-player-section-label', text: 'Start playback from' });

    const startRow = root.createEl('div', { cls: 'pdf-skim-player-row' });
    this.pageInput = startRow.createEl('input', { type: 'number', cls: 'pdf-skim-page-input' });
    this.pageInput.min = '1';
    this.pageInput.step = '1';
    this.pageInput.title = 'Page to start from — press Enter, or use the spinner arrows';
    this.pageInput.onchange = () => {
      const n = Number(this.pageInput.value);
      if (Number.isFinite(n) && n >= 1) this.plugin.playFrom(Math.floor(n));
    };

    this.beginBtn = startRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.beginBtn, 'skip-back');
    this.beginBtn.title = 'Play from the beginning';
    this.beginBtn.onclick = () => this.plugin.playFrom('beginning');

    this.currentPageBtn = startRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.currentPageBtn, 'file-text');
    this.currentPageBtn.title = 'Play from the page currently open in the PDF viewer';
    this.currentPageBtn.onclick = () => this.plugin.playFrom('current-page');

    this.cursorBtn = startRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.cursorBtn, 'text-cursor-input');
    this.cursorBtn.title = 'Play from the text currently selected in the PDF (best way to skip a heading pile-up)';
    this.cursorBtn.onclick = () => this.plugin.playFrom('cursor');

    this.selectionOnlyBtn = startRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.selectionOnlyBtn, 'columns-2');
    this.selectionOnlyBtn.title = 'Play ONLY the selected text — for a multi-column page, select just the column you want first';
    this.selectionOnlyBtn.onclick = () => this.plugin.playSelectionOnly();

    this.resumeRow = root.createEl('div', { cls: 'pdf-skim-player-row pdf-skim-resume-row' });
    this.resumeBtn = this.resumeRow.createEl('button', { cls: 'pdf-skim-resume-btn' });
    this.resumeBtn.onclick = () => { if (this._resumePage) this.plugin.playFrom(this._resumePage); };
    this.resumeRow.style.display = 'none';

    this.selectionBanner = root.createEl('div', { cls: 'pdf-skim-selection-banner' });
    this.selectionBanner.createSpan({ text: 'Playing selection only' });
    this.returnToDocBtn = this.selectionBanner.createEl('button', { text: '↩ Return to document' });
    this.returnToDocBtn.onclick = () => this.plugin.playback.returnToDocument();
    this.selectionBanner.style.display = 'none';

    // ---- Transport ----
    root.createEl('div', { cls: 'pdf-skim-player-section-label', text: 'Playback' });
    const transportRow = root.createEl('div', { cls: 'pdf-skim-player-row pdf-skim-transport-row' });

    this.prevHeadingBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.prevHeadingBtn, 'chevrons-left');
    this.prevHeadingBtn.title = 'Previous heading';
    this.prevHeadingBtn.onclick = () => {
      if (!this.plugin.playback.jumpToHeading(-1)) new Notice('PDF-Skim: no earlier heading found.');
    };

    this.skipBackBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.skipBackBtn, 'skip-back');
    this.skipBackBtn.title = 'Previous sentence';
    this.skipBackBtn.onclick = () => this.plugin.playback.skip(-1);

    this.playPauseBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn pdf-skim-play-btn' });
    setIcon(this.playPauseBtn, 'play');
    this.playPauseBtn.title = 'Play / pause';
    this.playPauseBtn.onclick = () => this.plugin.playback.togglePlayPause();

    this.stopBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.title = 'Stop';
    this.stopBtn.onclick = () => this.plugin.playback.stop();

    this.skipFwdBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.skipFwdBtn, 'skip-forward');
    this.skipFwdBtn.title = 'Next sentence';
    this.skipFwdBtn.onclick = () => this.plugin.playback.skip(1);

    this.nextHeadingBtn = transportRow.createEl('button', { cls: 'pdf-skim-icon-btn' });
    setIcon(this.nextHeadingBtn, 'chevrons-right');
    this.nextHeadingBtn.title = 'Next heading';
    this.nextHeadingBtn.onclick = () => {
      if (!this.plugin.playback.jumpToHeading(1)) new Notice('PDF-Skim: no later heading found.');
    };

    // ---- Page scrubber ----
    const scrubRow = root.createEl('div', { cls: 'pdf-skim-player-row' });
    this.pageScrubber = scrubRow.createEl('input', { type: 'range' });
    this.pageScrubber.min = '1';
    this.pageScrubber.max = '1';
    this.pageScrubber.step = '1';
    this.pageScrubber.title = 'Drag to seek to a page';
    // 'change' (fires on release), not 'input' (fires continuously) — a
    // seek stops the currently-sounding cue, so firing it per pixel of
    // drag would just chop up audio for no benefit.
    this.pageScrubber.onchange = () => this.plugin.playback.seekToPage(Number(this.pageScrubber.value));
    this.pageLabel = scrubRow.createEl('span', { cls: 'pdf-skim-player-progress-label' });

    // ---- Now reading ----
    this.nowReadingEl = root.createEl('div', { cls: 'pdf-skim-now-reading' });
    // Hidden unless Settings -> PDF-Skim -> Debug mode is on (see _render) —
    // shows the same window of narration annotated with why each pause/
    // replacement happened, entirely separate from what's actually sent
    // to the speech engine.
    this.debugTextEl = root.createEl('div', { cls: 'pdf-skim-debug-text' });

    // ---- Speed ----
    const speedRow = root.createEl('div', { cls: 'pdf-skim-player-row' });
    speedRow.createEl('label', { text: 'Speed' });
    this.speedSlider = speedRow.createEl('input', { type: 'range' });
    this.speedSlider.min = '0.5';
    this.speedSlider.max = '2.0';
    this.speedSlider.step = '0.05';
    this.speedLabel = speedRow.createEl('span', { cls: 'pdf-skim-player-speed-label' });
    this.speedSlider.oninput = () => {
      const v = Number(this.speedSlider.value);
      this.plugin.playback.setSpeed(v);
      this.plugin.settings.speed = v;
      this.plugin.saveSettings();
    };

    this.speakerRow = root.createEl('div', { cls: 'pdf-skim-player-row' });
    this.speakerRow.createEl('label', { text: 'Speaker' });
    this.speakerSelect = this.speakerRow.createEl('select');
    this.speakerSelect.onchange = () => this.plugin.playback.setSpeaker(Number(this.speakerSelect.value));
    this.speakerRow.style.display = 'none'; // shown only for multi-speaker models

    const linkRow = root.createEl('div', { cls: 'pdf-skim-player-row' });
    this.linkBtn = linkRow.createEl('button', { text: 'Insert link to current passage' });
    this.linkBtn.onclick = () => this.plugin.playback.insertLinkAtCursor();

    this.plugin.playback.on('update', this._onUpdate);
    // Switching which file/PDF tab is active changes what "current page"
    // and the Resume hint should mean, even with no playback state change.
    this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => this._render(this.plugin.playback.getStatus())));

    this._render(this.plugin.playback.getStatus());
  }

  async onClose() {
    this.plugin.playback.off('update', this._onUpdate);
  }

  _render(status) {
    this.titleEl.setText(status.fileName ? status.fileName : 'No PDF loaded');
    setIcon(this.playPauseBtn, status.state === 'playing' ? 'pause' : 'play');

    // Keep the spinner in sync with playback unless the user is actively
    // typing in it — don't yank a half-typed page number out from under them.
    if (document.activeElement !== this.pageInput) {
      this.pageInput.value = status.currentPage != null ? String(status.currentPage) : '';
    }
    if (status.totalPages) this.pageInput.max = String(status.totalPages);

    const totalPages = status.totalPages || 1;
    this.pageScrubber.max = String(totalPages);
    this.pageScrubber.value = String(status.currentPage || 1);
    const pct = status.totalCues ? Math.round((Math.max(0, status.cueIndex) / status.totalCues) * 100) : 0;
    this.pageLabel.setText(
      status.currentPage != null ? `Page ${status.currentPage}${status.totalPages ? ` / ${status.totalPages}` : ''} · ${pct}%` : ''
    );

    this.nowReadingEl.setText(status.cueText ? `“${this._truncate(status.cueText, 90)}”` : '');

    if (status.debugText) {
      // Auto-follows the live position (scrolls to bottom, where the
      // newest content lands) unless the user has manually scrolled away
      // from the bottom to look back at history — checked *before*
      // setText() below, since that changes scrollHeight.
      const wasNearBottom = this.debugTextEl.scrollHeight - this.debugTextEl.scrollTop - this.debugTextEl.clientHeight < 20;
      this.debugTextEl.setText(status.debugText);
      this.debugTextEl.style.display = 'block';
      if (wasNearBottom) this.debugTextEl.scrollTop = this.debugTextEl.scrollHeight;
    } else {
      this.debugTextEl.setText('');
      this.debugTextEl.style.display = 'none';
    }

    this.selectionBanner.style.display = status.selectionMode ? '' : 'none';

    this._renderResumeHint(status);

    this.speedSlider.value = String(status.speed);
    this.speedLabel.setText(`${status.speed.toFixed(2)}x`);

    if (status.numSpeakers > 1) {
      this.speakerRow.style.display = '';
      if (this.speakerSelect.options.length !== status.numSpeakers) {
        this.speakerSelect.empty();
        for (let i = 0; i < status.numSpeakers; i++) {
          this.speakerSelect.createEl('option', { text: `Speaker ${i}`, value: String(i) });
        }
      }
      this.speakerSelect.value = String(status.sid);
    } else {
      this.speakerRow.style.display = 'none';
    }
  }

  /** Shows "Resume page N" when the active PDF has a remembered position
   *  that playback isn't already sitting on — e.g. right after opening
   *  the panel, before anything's been narrated this session. */
  _renderResumeHint(status) {
    if (status.selectionMode) {
      this.resumeRow.style.display = 'none';
      this._resumePage = null;
      return;
    }
    const active = this.plugin.app.workspace.getActiveFile();
    const isPdf = active && active.extension === 'pdf';
    const lastPage = isPdf ? this.plugin.getLastPosition(active) : null;
    const alreadyThere = status.filePath === (active && active.path) && status.currentPage === lastPage;

    if (!lastPage || alreadyThere) {
      this.resumeRow.style.display = 'none';
      this._resumePage = null;
      return;
    }
    this._resumePage = lastPage;
    this.resumeBtn.setText(`↩ Resume "${active.basename}" at page ${lastPage}`);
    this.resumeRow.style.display = '';
  }

  _truncate(str, max) {
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  }
}

async function activatePlayerView(plugin) {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE);
  if (existing.length) {
    workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = workspace.getRightLeaf(false);
  if (!leaf) { new Notice('PDF-Skim: could not open the player panel.'); return; }
  await leaf.setViewState({ type: VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
}

module.exports = { PlayerView, VIEW_TYPE, activatePlayerView };
