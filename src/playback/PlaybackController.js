/*
  playback/PlaybackController.js

  Bridges TextPipeline's segment list to actual sound. Not part of the
  reviewed code — this is the piece that was missing between "here's a
  flat token stream" and "audio is coming out of my speakers."

  Cue queue: each pipeline segment becomes one or more cues:
    { kind:'speech', text, page }  — one sentence-sized chunk of text
    { kind:'silence', ms, page }   — an exact-duration gap
  Chunking to sentence size (rather than one speak() call per paragraph)
  keeps individual synthesis calls short, which matters for two things:
  perceived latency before audio starts, and skip() being able to land on
  a nearby sentence instead of the start of a whole paragraph.

  Page tracking: every cue carries the source segment's `page`, so
  "insert link to current passage" can always answer "what page is
  playing right now" without re-deriving it from the flat, page-less
  token stream that TextPipeline.process() returns. Each cue also carries
  the source segment's `type` ('heading' | 'paragraph' | 'list-item' |
  'table-row' | 'raw'), a `segStart` flag marking the first cue of that
  segment, and `pdfRef` (the segment's precise begin/end item+offset in
  the PDF, from extractor.js, or null) — `type`+`segStart` are what let
  jumpToHeading() hop over a run of back-to-back section headings, and
  `pdfRef` is what lets insertLinkAtCursor() link to the exact passage
  rather than just the page it's on.

  Seeking: skip(), seekToPage(), seekToText(), and jumpToHeading() all
  funnel through _jumpTo(), which is the one place that stops whatever
  cue is currently sounding, retargets the queue, and — critically —
  normalizes playback state so a subsequent play() actually restarts the
  loop instead of taking play()'s "just un-suspend the AudioContext"
  shortcut meant for plain pause/resume (see the comment on _jumpTo).

  Synthesis pipelining: _runLoop() used to call engine.speak() for cue N,
  await the full result, play it, and only *then* call engine.speak() for
  cue N+1 — meaning cue N+1's synthesis latency landed as an audible gap
  after cue N's audio ended, worse on longer/more complex sentences that
  simply take longer to synthesize. _startSynthesis()/_speakCue() now
  kick off cue N+1's synthesis as soon as cue N's own result comes back
  (i.e. right as cue N's audio starts playing), so the two overlap; only
  the very first cue in a play() session still pays that latency audibly,
  since there's nothing playing yet to hide it behind.

  Selection-only playback: playSelectionOnly() narrates arbitrary text
  (typically a PDF text selection) without touching the document's real
  cue queue — see its own doc comment for why "play from cursor" isn't
  enough for multi-column layouts. It works by swapping `this.cues` out
  for a one-off queue built from that text and snapshotting the real one;
  returnToDocument() (called automatically by anything that starts a
  normal document seek) puts it back.

  State broadcasting: this is an EventEmitter, not something that reaches
  into a specific DOM element itself — it emits 'update' with a plain
  status snapshot on every state change, and doesn't know or care who's
  listening. Both the status bar item and the player panel view subscribe
  to the same event rather than the controller special-casing either one.
*/

'use strict';

const { EventEmitter } = require('events');
const { processSegments } = require('../pipeline/TextPipeline');
const { segment } = require('../pipeline/tokens');

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(])/;
const MAX_CHUNK_CHARS = 280;

// Maps the punctuation character that triggered a split to the config key
// holding its pause duration. Kept as three separate lookups (rather than
// one flat object) because a sentence-ending mark and a clause mark need
// different surrounding-context rules to avoid false splits (see
// PUNCT_SPLIT_RE below) even though both ultimately just look up a
// duration the same way.
const SENTENCE_END_MS_KEY = { '.': 'periodMs', '?': 'questionMs', '!': 'exclamationMs' };
const CLAUSE_MS_KEY = { ',': 'commaMs', ':': 'colonMs', ';': 'semicolonMs' };
const BRACKET_MS_KEY = { '(': 'beforeParenMs', '[': 'beforeSquareMs', '{': 'beforeCurlyMs' };

// Parallel to the *_MS_KEY maps above, purely for the debug-mode narration
// overlay — human-readable labels for the same punctuation-triggered pause
// decisions, not used for anything that reaches the speech engine.
const SENTENCE_END_REASON = { '.': 'period', '?': 'question', '!': 'exclamation' };
const CLAUSE_REASON = { ',': 'comma', ':': 'colon', ';': 'semicolon' };
const BRACKET_REASON = { '(': 'before-paren', '[': 'before-square', '{': 'before-curly' };

// A period ending one of these (case-insensitive) almost never ends a
// sentence — without this, "Mr. Smith arrived." splits into "Mr." and
// "Smith arrived.", inserting a pause named for a sentence boundary
// that isn't really there. Deliberately small and specific to common
// English titles/academic abbreviations (this plugin's actual target
// material), not a general abbreviation-detection model.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx',
  'fig', 'figs', 'eq', 'eqs', 'no', 'nos', 'vol', 'vols', 'ed', 'eds',
  'al', 'cf', 'ca', 'e.g', 'i.e',
]);
function endsWithAbbreviation(textBeforePunct) {
  const wordMatch = /([A-Za-z.]+)$/.exec(textBeforePunct);
  if (!wordMatch) return false;
  return ABBREVIATIONS.has(wordMatch[1].toLowerCase());
}

// Three alternatives, each a different kind of split point:
//   1. [.!?] followed by whitespace, only when what follows *looks like*
//      a new sentence starting (capital letter, digit, quote, or open
//      paren) — the same guard the old sentence-only splitter used, still
//      needed here for the same reason: without it, "Mr. Smith" and
//      "v3.14" both get mis-split as sentence boundaries.
//   2. [,;:] followed by whitespace — requiring the whitespace is what
//      keeps "3:30" and "1,000" intact, since there's no space right
//      after the mark in either case.
//   3. A lookahead (zero-width, consumes nothing) right before an opening
//      bracket, so the pause lands *before* the bracket while the bracket
//      itself still starts the following piece rather than being
//      stranded on its own. Also requires a lookbehind for whitespace (or
//      start-of-string) immediately before the bracket — without it, an
//      opening bracket with no preceding space, e.g. a citation
//      ("Smith(2020)"), math notation ("f(x)"), or a plural
//      ("output(s)"), gets treated as a split point too, cutting a single
//      word in half into two separate synthesis calls. Each half is then
//      spoken with zero context for the other, which is what actually
//      caused the reported mispronunciation: it's not that the pause
//      itself sounds wrong, it's that "Smith" and "(2020)" (or "f" and
//      "(x)") were never one sentence to begin with by the time either
//      reached the TTS engine.
const PUNCT_SPLIT_RE = /([.!?])\s+(?=[A-Z0-9"'\u201c(])|([,;:])\s+|(?<=\s|^)(?=[([{])/g;

function legacySentenceSplit(trimmed) {
  let pieces = trimmed.split(SENTENCE_SPLIT_RE);
  // A sentence-splitter regex doesn't help long lists/table rows that have
  // no terminal punctuation; fall back to splitting oversized pieces on
  // commas/semicolons so no single speak() call is absurdly long.
  pieces = pieces.flatMap(p => {
    if (p.length <= MAX_CHUNK_CHARS) return [p];
    return p.split(/(?<=[,;:])\s+/);
  });
  return pieces.map(p => p.trim()).filter(Boolean);
}

/** Hard length cap regardless of punctuation — an unpunctuated run (rare,
 *  but possible: a long list item rendered as one line, a run-on caption)
 *  could otherwise produce one absurdly long synthesis call. Splits on
 *  whitespace near the limit rather than mid-word; only the final
 *  sub-piece keeps the original trailing pause, since the others aren't
 *  real punctuation boundaries. */
function capLength(piece) {
  if (piece.text.length <= MAX_CHUNK_CHARS) return [piece];
  const words = piece.text.split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > MAX_CHUNK_CHARS) {
      out.push({ text: cur, pauseAfterMs: 0 });
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) out.push({ text: cur, pauseAfterMs: piece.pauseAfterMs, pauseReason: piece.pauseReason });
  return out;
}

/** Splits one text token into speakable pieces, each carrying the silence
 *  (in ms) that should follow it. With punctuationPauses disabled, this is
 *  just the old sentence-only chunking with no inserted silence — chunk
 *  boundaries still matter even then, for latency and for skip() landing
 *  on a nearby sentence, but the gap between them is left entirely to the
 *  TTS engine's own trailing decay, same as before this feature existed.
 *  @param {string} str
 *  @param {object} [cfg] config.punctuationPauses
 *  @returns {{text: string, pauseAfterMs: number}[]} */
function splitIntoSpeechCues(str, cfg) {
  const trimmed = str.trim();
  if (!trimmed) return [];

  if (!cfg || !cfg.enabled) {
    return legacySentenceSplit(trimmed).map(text => ({ text, pauseAfterMs: 0 }));
  }

  const pieces = [];
  let last = 0;
  PUNCT_SPLIT_RE.lastIndex = 0;
  let m;
  while ((m = PUNCT_SPLIT_RE.exec(trimmed))) {
    const [full, sentenceChar, clauseChar] = m;
    if (!sentenceChar && !clauseChar) {
      // The zero-width bracket lookahead: split *before* the bracket
      // without consuming it, so it starts the next piece. Zero-width
      // matches don't advance lastIndex on their own, which would spin
      // the loop forever on the same position — advance it manually.
      const text = trimmed.slice(last, m.index).trim();
      const bracketChar = trimmed[m.index];
      if (text) pieces.push({ text, pauseAfterMs: (cfg[BRACKET_MS_KEY[bracketChar]]) || 0, pauseReason: BRACKET_REASON[bracketChar] });
      last = m.index;
      PUNCT_SPLIT_RE.lastIndex = m.index + 1;
    } else if (sentenceChar === '.' && endsWithAbbreviation(trimmed.slice(last, m.index))) {
      // Not a real sentence boundary — keep scanning without splitting
      // here; the eventual real split point will still capture this
      // whole stretch as one piece.
      continue;
    } else {
      const endOfPunct = m.index + (sentenceChar || clauseChar).length;
      const text = trimmed.slice(last, endOfPunct).trim();
      const key = sentenceChar ? SENTENCE_END_MS_KEY[sentenceChar] : CLAUSE_MS_KEY[clauseChar];
      const reason = sentenceChar ? SENTENCE_END_REASON[sentenceChar] : CLAUSE_REASON[clauseChar];
      if (text) pieces.push({ text, pauseAfterMs: cfg[key] || 0, pauseReason: reason });
      last = m.index + full.length;
    }
  }
  const tail = trimmed.slice(last).trim();
  if (tail) pieces.push({ text: tail, pauseAfterMs: 0 });

  return pieces.flatMap(capLength);
}

/** Segment[] (from TextPipeline.processSegments) -> Cue[]
 *  @param {object} [punctCfg] config.punctuationPauses */
function buildCueQueue(segments, punctCfg) {
  const cues = [];
  for (const seg of segments) {
    let segStartAssigned = false;
    for (const tok of seg.tokens) {
      if (tok.kind === 'pause') {
        if (tok.ms > 0) cues.push({ kind: 'silence', ms: tok.ms, page: seg.page, type: seg.type, segStart: false, pdfRef: seg.pdfRef || null, reason: tok.reason || null });
      } else if (tok.kind === 'text') {
        for (const piece of splitIntoSpeechCues(tok.value, punctCfg)) {
          cues.push({ kind: 'speech', text: piece.text, page: seg.page, type: seg.type, segStart: !segStartAssigned, pdfRef: seg.pdfRef || null, debugTag: tok.debugTag || null });
          segStartAssigned = true;
          if (piece.pauseAfterMs > 0) {
            cues.push({ kind: 'silence', ms: piece.pauseAfterMs, page: seg.page, type: seg.type, segStart: false, pdfRef: seg.pdfRef || null, reason: piece.pauseReason || null });
          }
        }
      }
    }
  }
  return cues;
}

class PlaybackController extends EventEmitter {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.cues = [];
    this.index = -1;
    // `this.index` follows _runLoop's "always increment before playing"
    // convention, which means _jumpTo deliberately parks it one cue
    // *behind* wherever a seek actually landed whenever playback isn't
    // immediately resumed (see _jumpTo's comment) — correct for _runLoop
    // itself, but wrong for anything that needs "where are we right now,
    // logically" (skip() and jumpToHeading() both compute their target as
    // an offset from the current position). _currentCueIndex is the
    // single source of truth for that instead, kept in sync in both
    // places this.index changes (_jumpTo and _runLoop's own increment) so
    // repeated skip()/jumpToHeading() calls between play() resumes still
    // advance one cue at a time instead of re-landing on the same one.
    this._currentCueIndex = -1;
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.file = null;
    this.currentPage = null;
    this.pageCount = null;
    this.audioCtx = null;
    this.sourceNode = null;
    this._playToken = 0; // bumped on stop/skip so an in-flight speak() result is dropped
    this._prefetch = null; // { index, token, promise } — see _startSynthesis
    this._selectionSnapshot = null; // set while playSelectionOnly()'s cues are active
  }

  /** True while playSelectionOnly()'s cues are loaded in place of the
   *  document's own cue queue. */
  get inSelectionMode() {
    return this._selectionSnapshot != null;
  }

  /** Plain-object snapshot for anything rendering playback state. */
  getStatus() {
    const cue = this._currentCueIndex >= 0 && this._currentCueIndex < this.cues.length ? this.cues[this._currentCueIndex] : null;
    const debugMode = !!(this.plugin.settings && this.plugin.settings.config && this.plugin.settings.config.debugMode);
    return {
      state: this.state,
      fileName: this.file ? this.file.basename : null,
      filePath: this.file ? this.file.path : null,
      currentPage: this.currentPage,
      totalPages: this.pageCount || null,
      cueIndex: this._currentCueIndex,
      totalCues: this.cues.length,
      cueText: cue && cue.kind === 'speech' ? cue.text : null,
      debugText: debugMode ? this._buildDebugText() : null,
      speed: this.speed || 1.0,
      numSpeakers: this.engine ? this.engine.numSpeakers : 0,
      sid: this.sid || 0,
      selectionMode: this.inSelectionMode,
    };
  }

  /** Renders a short window of cues around the current position as one
   *  annotated string — inline {pause: reason, Nms} markers where a
   *  silence cue sits, and a [debugTag] prefix on any speech cue a rule
   *  tagged (currently just substitutions). This is a *display-only*
   *  reconstruction built from the same cues already used for playback,
   *  never fed back into anything that reaches the speech engine — it
   *  exists so a filtering-heuristic bug (a pause landing somewhere it
   *  shouldn't, a substitution firing on the wrong word) is visible
   *  directly against real narration instead of having to guess from the
   *  audio alone. Windowed rather than whole-document for the obvious
   *  reason: rebuilding this on every single cue advance is cheap only if
   *  it stays small. */
  _buildDebugText() {
    if (!this.cues.length || this._currentCueIndex < 0) {
      return 'Debug mode is on — narrate a PDF to see pause and substitution decisions here as they happen.';
    }
    const WINDOW_BEFORE = 8; // enough to scroll back and see recent context after pausing
    const WINDOW_AFTER = 2;
    const start = Math.max(0, this._currentCueIndex - WINDOW_BEFORE);
    const end = Math.min(this.cues.length, this._currentCueIndex + WINDOW_AFTER + 1);

    const parts = [];
    if (start > 0) parts.push('…');
    for (let i = start; i < end; i++) {
      const c = this.cues[i];
      const isCurrent = i === this._currentCueIndex;
      if (c.kind === 'silence') {
        parts.push(`{pause: ${c.reason || 'unlabeled'}, ${c.ms}ms}`);
      } else {
        const tag = c.debugTag ? `[${c.debugTag}] ` : '';
        const spoken = `${tag}${c.text}`;
        parts.push(isCurrent ? `▶${spoken}◀` : spoken);
      }
    }
    if (end < this.cues.length) parts.push('…');
    return parts.join(' ');
  }

  _emitUpdate() {
    this.emit('update', this.getStatus());
  }

  /** @param {import('obsidian').TFile} file
   *  @param {number} [pageCount] the PDF's real page count, from
   *    extractor.js — used to bound the panel's page spinner/scrubber;
   *    falls back to the highest page any cue landed on if omitted. */
  async load(file, segments, engine, speed, pageCount) {
    this.stop();
    this._selectionSnapshot = null; // loading a document always exits selection mode
    this.file = file;
    this.engine = engine;
    this.speed = speed || 1.0;
    this.sid = 0;
    this.cues = buildCueQueue(segments, this.plugin.settings.config.punctuationPauses);
    this.pageCount = pageCount || (this.cues.length ? this.cues[this.cues.length - 1].page : null);
    this.index = -1;
    this._currentCueIndex = -1;
    this.currentPage = this.cues.length ? this.cues[0].page : null;
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    this._emitUpdate();
  }

  setSpeed(speed) {
    this.speed = speed;
    this._emitUpdate();
  }

  setSpeaker(sid) {
    this.sid = sid;
    this._emitUpdate();
  }

  async play() {
    if (!this.cues.length) return;
    if (this.state === 'paused' && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
      this.state = 'playing';
      this._emitUpdate();
      return;
    }
    if (this.state === 'playing') return;
    // A seek that landed here from 'paused' (see _jumpTo) can leave the
    // AudioContext suspended even though state was normalized to
    // 'stopped' — resuming it is a harmless no-op if it's already
    // running, but required if it isn't.
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch { /* ignore */ }
    }
    this.state = 'playing';
    this._emitUpdate();
    this._runLoop();
  }

  async pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    if (this.audioCtx) await this.audioCtx.suspend();
    this._emitUpdate();
  }

  async togglePlayPause() {
    if (this.state === 'playing') await this.pause();
    else await this.play();
  }

  stop() {
    this._playToken++;
    this.state = 'stopped';
    this._prefetch = null;
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode = null;
    }
    this._emitUpdate();
  }

  /** Jumps to the next/previous cue boundary and keeps playing.
   *  @param {1|-1} direction */
  skip(direction) {
    if (!this.cues.length) return;
    this._jumpTo(this._currentCueIndex + direction);
  }

  /** Every seek (skip, page, text match, heading hop) funnels through
   *  here. `targetIndex` is the cue that should play *next*, not an
   *  offset — _runLoop() always increments before playing, so this
   *  parks `this.index` one short of the target and lets that increment
   *  land exactly on it.
   *
   *  If playback was actively running, the loop is restarted so the new
   *  target starts sounding immediately. Otherwise state is normalized
   *  to 'stopped' rather than left as whatever it was (typically
   *  'paused') — play()'s paused branch just un-suspends the
   *  AudioContext to continue whatever buffer was already scheduled,
   *  which after a seek is nothing; forcing 'stopped' makes the next
   *  play() take the normal _runLoop() path instead. */
  _jumpTo(targetIndex) {
    if (!this.cues.length) return;
    const clamped = Math.max(0, Math.min(this.cues.length - 1, targetIndex));
    const wasPlaying = this.state === 'playing';
    this._playToken++;
    this._prefetch = null;
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch { /* already stopped */ } this.sourceNode = null; }
    this.index = clamped - 1;
    this._currentCueIndex = clamped;
    this.currentPage = this.cues[clamped].page; // update now, don't wait for _runLoop to get there
    if (wasPlaying) {
      this.state = 'playing';
      this._runLoop();
    } else {
      this.state = 'stopped';
    }
    this._emitUpdate();
  }

  /** Resets to "nothing played yet, first cue plays next," equivalent
   *  to a fresh load(). _jumpTo(0) already parks `index` at -1 for
   *  exactly this reason. */
  seekToStart() {
    this._jumpTo(0);
  }

  /** Index of the first cue on or after `page`, or the last cue if the
   *  document doesn't reach that page. -1 only when there are no cues. */
  findCueIndexForPage(page) {
    if (!this.cues.length) return -1;
    const idx = this.cues.findIndex(c => c.page != null && c.page >= page);
    return idx === -1 ? this.cues.length - 1 : idx;
  }

  seekToPage(page) {
    const idx = this.findCueIndexForPage(page);
    if (idx === -1) return false;
    this._jumpTo(idx);
    return true;
  }

  /** Fuzzy-matches selected PDF text against cue text. Not an exact
   *  lookup on purpose: TextPipeline may have reworded or dropped
   *  surrounding material (citations, substitutions, captions), so the
   *  raw selection often won't appear byte-for-byte in any single cue —
   *  cues are also chunked at sentence boundaries (see
   *  splitIntoSpeechCues), so a selection starting mid-sentence won't
   *  exactly prefix-match any single cue either.
   *
   *  Staged by page on purpose, not just "prefer hintPage": trying the
   *  exact page alone first, before ever widening the search, avoids a
   *  short/generic cue on some *other* page winning a match ahead of the
   *  real (but only loosely-matching) one on the actual page — which is
   *  exactly what "start reading a bit before/after where I selected"
   *  turned out to be, on inspection: the old single-pass version would
   *  gladly accept a same-page-or-later cue anywhere in the rest of the
   *  document if the true match's wording had drifted enough (via
   *  substitutions) not to satisfy MIN_MATCH_LEN below. */
  findCueIndexForText(rawText, hintPage) {
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const needle = norm(rawText).slice(0, 80);
    if (!needle) return -1;
    const short = needle.slice(0, 40);

    // A match under this length is too easily coincidental — a short cue
    // ("Introduction", a lone list-item number, a one-line boilerplate
    // fragment) can trivially appear as a substring of an unrelated
    // 80-character needle purely by chance, which is what let an earlier
    // version of this function occasionally match a cue nowhere near the
    // real selection. 20 chars is roughly "a few words," long enough that
    // an accidental match is unlikely, short enough that reworded text
    // still matches.
    const MIN_MATCH_LEN = 20;

    const matches = (cue) => {
      if (cue.kind !== 'speech') return false;
      const hay = norm(cue.text);
      if (hay.length >= MIN_MATCH_LEN && hay.includes(short)) return true;
      const hayPrefix = hay.slice(0, 40);
      return hayPrefix.length >= MIN_MATCH_LEN && needle.includes(hayPrefix);
    };

    if (hintPage != null) {
      const onExactPage = this.cues.findIndex(c => c.page === hintPage && matches(c));
      if (onExactPage !== -1) return onExactPage;
      const onOrAfter = this.cues.findIndex(c => c.page != null && c.page >= hintPage && matches(c));
      if (onOrAfter !== -1) return onOrAfter;
    }
    return this.cues.findIndex(matches);
  }

  seekToText(rawText, hintPage) {
    const idx = this.findCueIndexForText(rawText, hintPage);
    if (idx === -1) return false;
    this._jumpTo(idx);
    return true;
  }

  /** Jumps to the next/previous segment boundary marked as a heading —
   *  a quick way to hop past a run of section/sub-section headings that
   *  get read back-to-back before any body text, a known side effect of
   *  how little real structure a PDF encodes (see extractor.js).
   *  @param {1|-1} direction
   *  @returns {boolean} false if there's no heading further in that
   *    direction (playback position is left unchanged). */
  jumpToHeading(direction) {
    if (!this.cues.length) return false;
    let i = this._currentCueIndex + direction;
    while (i >= 0 && i < this.cues.length) {
      if (this.cues[i].type === 'heading' && this.cues[i].segStart) {
        this._jumpTo(i);
        return true;
      }
      i += direction;
    }
    return false;
  }

  /** Narrates `rawText` verbatim, once, in place of the document's own
   *  cue queue — for text selected across a multi-column layout, where
   *  even "play from cursor" can't help: a page-order seek still reads
   *  straight through whatever's positioned between the selected column
   *  and the next matching text, since pdf.js (and this plugin's line
   *  grouping) has no notion of column boundaries to seek around. Playing
   *  only the exact selection sidesteps the problem entirely instead of
   *  trying to detect columns, which — per the README's PDF extraction
   *  limitations — isn't reliably possible from position data alone.
   *
   *  Runs the same substitutions/pronunciation pass as normal document
   *  text (so numbers, abbreviations, etc. still sound right), but never
   *  structural filtering (boilerplate/table/caption rules) — a manual
   *  selection is an explicit "narrate this," not something to
   *  second-guess.
   *
   *  Swaps `this.cues` out temporarily; returnToDocument() restores the
   *  original queue afterward. Anything that starts a normal document
   *  seek (playFrom(), effectively) calls returnToDocument() first, so
   *  this is always a one-off detour, never a dead end.
   *  @returns {Promise<boolean>} false if there was nothing to narrate. */
  async playSelectionOnly(rawText, page) {
    const seg = segment('paragraph', rawText, { page: page != null ? page : this.currentPage });
    const config = this.plugin.settings.config;
    const processed = processSegments([seg], {
      ...config,
      removeBoilerplate: { enabled: false },
      removeRepeatedHeadersFooters: { enabled: false },
      tables: { enabled: false },
      figuresAndTables: { ...config.figuresAndTables, enabled: false },
      structuralPauses: { enabled: false },
    });
    const cues = buildCueQueue(processed, config.punctuationPauses);
    if (!cues.length) return false;

    if (!this._selectionSnapshot) {
      this._selectionSnapshot = {
        cues: this.cues,
        index: this.index,
        currentCueIndex: this._currentCueIndex,
        currentPage: this.currentPage,
        pageCount: this.pageCount,
      };
    }

    this._playToken++;
    this._prefetch = null;
    if (this.sourceNode) { try { this.sourceNode.stop(); } catch { /* already stopped */ } this.sourceNode = null; }
    this.cues = cues;
    this.index = -1;
    this._currentCueIndex = -1;
    this.currentPage = cues[0].page;
    this.pageCount = null; // not a real page range — the panel shows "selection" instead
    this.state = 'stopped';
    this._emitUpdate();

    await this.play();
    return true;
  }

  /** Restores the document's cue queue after playSelectionOnly(). A
   *  no-op if selection-only playback isn't active. */
  returnToDocument() {
    if (!this._selectionSnapshot) return;
    this.stop();
    const s = this._selectionSnapshot;
    this._selectionSnapshot = null;
    this.cues = s.cues;
    this.index = s.index;
    this._currentCueIndex = s.currentCueIndex;
    this.currentPage = s.currentPage;
    this.pageCount = s.pageCount;
    this._emitUpdate();
  }

  /** Fires off synthesis for `index` ahead of when it's actually needed,
   *  so its latency overlaps with the current cue's audio instead of
   *  landing as an audible gap after it — the dominant cause of "long
   *  pause after some phrases" on sentences that simply take longer to
   *  synthesize. Returns null for silence cues / past the end of the
   *  queue, where there's nothing to prefetch. */
  _startSynthesis(index, token) {
    if (index < 0 || index >= this.cues.length) return null;
    const cue = this.cues[index];
    if (cue.kind !== 'speech') return null;
    const promise = this.engine.speak(cue.text, { speed: this.speed, sid: this.sid }).catch((err) => {
      console.error('[pdf-skim] synthesis failed, skipping chunk:', err);
      return null;
    });
    return { index, token, promise };
  }

  async _runLoop() {
    const myToken = this._playToken;
    while (this.state === 'playing' && this.index < this.cues.length - 1) {
      this.index++;
      this._currentCueIndex = this.index;
      const cue = this.cues[this.index];
      this.currentPage = cue.page;
      this._emitUpdate();

      const prefetched = (this._prefetch && this._prefetch.index === this.index && this._prefetch.token === myToken)
        ? this._prefetch
        : null;
      this._prefetch = null;

      if (cue.kind === 'silence') {
        // Nothing to prefetch a silence cue itself, but the *next* cue's
        // synthesis can still happen during the wait instead of after it.
        this._prefetch = this._startSynthesis(this.index + 1, myToken);
        await this._sleep(cue.ms);
      } else {
        await this._speakCue(cue, myToken, prefetched);
      }
      if (myToken !== this._playToken) return; // stopped/skipped mid-cue
    }
    if (this.index >= this.cues.length - 1 && myToken === this._playToken) {
      this.state = 'stopped';
      this._emitUpdate();
    }
  }

  async _speakCue(cue, myToken, prefetched) {
    let result;
    if (prefetched) {
      result = await prefetched.promise;
    } else {
      try {
        result = await this.engine.speak(cue.text, { speed: this.speed, sid: this.sid });
      } catch (err) {
        console.error('[pdf-skim] synthesis failed, skipping chunk:', err);
        return;
      }
    }
    if (myToken !== this._playToken) return;
    if (!result) return; // a failed prefetch resolved to null; already logged

    // Kick off the *next* cue's synthesis now, while this cue's audio is
    // about to play below, instead of waiting until it's finished.
    this._prefetch = this._startSynthesis(this.index + 1, myToken);

    const buffer = this.audioCtx.createBuffer(1, result.samples.length, result.sampleRate);
    buffer.copyToChannel(result.samples, 0);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    this.sourceNode = src;

    await new Promise(resolve => {
      src.onended = resolve;
      src.start();
    });
    if (this.sourceNode === src) this.sourceNode = null;
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const id = setTimeout(resolve, ms);
      // Not cancelled on stop()/skip() — the loop re-checks _playToken right
      // after awaiting, so a stale timeout just resolves into a no-op.
      this._pendingTimeout = id;
    });
  }

  /** Inserts a link back to the currently-playing passage at the editor
   *  cursor — a precise `&selection=...` deep link when the current cue
   *  has a pdfRef (see tokens.js), otherwise a plain page link. */
  insertLinkAtCursor() {
    const { Notice } = require('obsidian');
    const view = this.plugin.getTargetMarkdownView();
    if (!view) {
      new Notice('PDF-Skim: open a note to insert a link into.');
      return;
    }
    if (!this.file || this.currentPage == null) {
      new Notice('PDF-Skim: nothing is playing yet.');
      return;
    }
    const cue = this._currentCueIndex >= 0 && this._currentCueIndex < this.cues.length ? this.cues[this._currentCueIndex] : null;
    const ref = cue && cue.pdfRef;
    const link = ref
      ? `[[${this.file.basename}#page=${this.currentPage}&selection=${ref.beginIndex},${ref.beginOffset},${ref.endIndex},${ref.endOffset}]]`
      : `[[${this.file.basename}#page=${this.currentPage}]]`;
    view.editor.replaceSelection(`${link} `);
  }
}

module.exports = { PlaybackController, buildCueQueue, splitIntoSpeechCues };
