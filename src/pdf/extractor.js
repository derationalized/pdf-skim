/*
  pdf/extractor.js

  Turns a PDF's raw bytes into the Segment[] shape TextPipeline.js already
  expects (see tokens.js): { type, level, page, pdfRef, tokens: [{kind:'text',...}] }.
  This is the one stage of the pipeline the uploaded code didn't include —
  everything downstream (rules/, substitutions, pause insertion) is generic
  over "a list of segments" and doesn't care that they came from a PDF.

  pdf.js gives us a bag of positioned text items per page, not paragraphs —
  there's no ground truth for "this is a heading" or "this is a list item"
  in a PDF. What follows is heuristic, not a layout-analysis model:

    - lines: group items on a page into visual lines by y-coordinate
    - body size: the most common line font size in the document, taken as
      "normal paragraph text"
    - heading: a short line set in a font notably larger than body size,
      or a line matching a numbered-heading shape ("3.2 Related Work")
    - list item: a line starting with a bullet glyph or a numbered/lettered
      marker ("1.", "a)", "iv.")
    - table row: a line with several unusually wide gaps between text runs
      (more than plain word-spacing explains), repeated for a run of
      consecutive lines — see "Table row detection" below
    - paragraph: consecutive body-sized lines with a small vertical gap and
      a consistent left margin are merged into one segment; a hyphenated
      line break ("...circu-" / "its") is rejoined without the hyphen

  This will not be perfect on every publisher's layout — two-column
  papers, dropped caps, and marginal notes are known weak spots — but it
  gives the filtering stages real structure to work with instead of one
  wall of text per page. See the README's "PDF extraction limitations"
  section.

  Table row detection: a table cell's text sits in its own narrow column,
  so a table row's line has noticeably wider gaps between its text runs
  than justified prose ever does (word-spacing) — pdf.js hands us each
  run's x position and width, so this is just arithmetic on data already
  being gathered for line-grouping, not a second pass over the document.
  A single wide gap isn't enough on its own (a run-in heading number, a
  key/value aside like "Version:   3.2", etc. can produce one too) — this
  only tags a line once *several* consecutive lines all show the pattern,
  since a real table is rows, not a one-off.  Detected rows get tagged
  `type: 'table-row'` and left in the segment stream; whether they're
  actually dropped is a pipeline-config decision (see
  rules/tables.js + defaultConfig.js's `tables` section), consistent with
  how every other extraction category here (headings, captions, boilerplate)
  is always structurally tagged and only *filtered* downstream.

  pdfRef / precise linking: each segment also carries, when available, the
  begin/end item index+offset pdf.js's own text layer uses to describe a
  selection — see tokens.js's Segment doc comment for the exact shape and
  why it has to be computed here rather than downstream.
*/

'use strict';

const path = require('path');
const fs = require('fs');
const { segment } = require('../pipeline/tokens');

const BULLET_RE = /^[\u2022\u2023\u25E6\u2043\u2219\u25CF\u25AA\u25FE\-\*]\s+/;
const NUMBERED_LIST_RE = /^(?:\(?[0-9]{1,3}[\).]|\(?[a-zA-Z][\).]|\(?[ivxlcdmIVXLCDM]{1,6}[\).])\s+/;
const HEADING_NUM_RE = /^(\d+(?:\.\d+){0,3})\.?\s+\S/;

// Table row detection thresholds — see the file header comment. Kept as
// plain constants rather than user-facing settings: they're geometric
// tuning knobs, not a behavior choice the way `tables.enabled`/`mode` is,
// and the run-length requirement already makes a false positive rare.
const TABLE_MIN_WIDE_GAPS = 2; // a row needs at least this many "cells"
const TABLE_GAP_FONT_MULTIPLE = 1.8; // gap wider than this * fontSize counts as "wide"
const TABLE_GAP_MIN_PT = 10; // floor, so a tiny-font line doesn't trip on ordinary spacing
const TABLE_MAX_ROW_WORDS = 24; // long lines with one incidental wide gap aren't a table cell
const TABLE_MIN_CONSECUTIVE_ROWS = 3; // require a real run, not one key/value aside

let lastLibBlobUrl = null;
let lastWorkerBlobUrl = null;

/** Loads pdf.js's main-thread library from a vendored copy shipped
 *  alongside this plugin (pdfjs/pdf.mjs), rather than via a bare
 *  `import('pdfjs-dist/...')` specifier.
 *
 *  Why not the bare specifier: that only works when a bundler (esbuild,
 *  in this project's normal build) resolves and inlines it at *build*
 *  time — with no bundler in the loop, it would need real npm-style
 *  node_modules resolution at *runtime* instead, which this plugin
 *  doesn't ship (no node_modules folder). Vendoring the file directly
 *  sidesteps needing either.
 *
 *  Why a Blob URL rather than reading the file path straight into
 *  import(): a plain file:// path (even via pathToFileURL, which is
 *  otherwise the correct way to build one) doesn't work here — Obsidian's
 *  renderer loads plugin code from a custom "app://obsidian.md" origin,
 *  and Electron blocks that origin from loading file:// resources at all
 *  ("Not allowed to load local resource"), including via dynamic
 *  import(). Reading the file's *text* with Node's fs (unaffected by
 *  that restriction — it's a filesystem read, not a page resource fetch)
 *  and handing the code to import() as a Blob URL instead sidesteps this
 *  entirely, exactly like the pdf.worker.js loading below already does. */
async function loadPdfJs(pluginDir) {
  if (!pluginDir) throw new Error('extractPdfSegments requires opts.pluginDir to locate the vendored pdf.js library.');
  const libPath = path.join(pluginDir, 'pdfjs', 'pdf.mjs');
  const code = fs.readFileSync(libPath, 'utf8');
  if (lastLibBlobUrl) URL.revokeObjectURL(lastLibBlobUrl); // don't leak one per narrate
  lastLibBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const pdfjsLib = await import(lastLibBlobUrl);
  return pdfjsLib;
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Groups a page's raw text items into visual lines by y-coordinate. Each
 *  returned line also carries what's needed for table-row detection
 *  (gapWidths) and for precise PDF selection links (firstItemIndex /
 *  lastItemIndex / lastItemLen — indices into pdf.js's own item array,
 *  in *its* order, captured before this function reorders anything). */
function groupIntoLines(items) {
  const withPos = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.str != null)
    .map(({ it, idx }) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      // `width` is pdf.js's own measured run width; a rough estimate
      // stands in on the off chance a given build/version omits it, only
      // used for gap-width math so imprecision there is harmless.
      width: typeof it.width === 'number' ? it.width : Math.abs(it.transform[0]) * (it.str ? it.str.length : 0),
      fontSize: Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[3]) || 10,
      hasEol: !!it.hasEOL,
      origIndex: idx,
    }));
  if (!withPos.length) return [];

  withPos.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let current = null;
  const Y_TOLERANCE = 2.5;

  for (const it of withPos) {
    if (current && Math.abs(current.y - it.y) <= Y_TOLERANCE) {
      current.items.push(it);
    } else {
      current = { y: it.y, items: [it] };
      lines.push(current);
    }
  }

  return lines.map((line, i) => {
    line.items.sort((a, b) => a.x - b.x);
    const lastItem = line.items[line.items.length - 1];
    // Vertical distance to the previous line, or null for a page's first
    // line — used by classifyLine to tell "this line has the normal
    // tight spacing of a wrapped sentence" from "there's a real gap here,
    // like before a heading or new paragraph." PDF y-coordinates increase
    // upward, so a line further down the page has a smaller y.
    const gapBefore = i > 0 ? lines[i - 1].y - line.y : null;

    // Text and gap-widths are built in one pass: both need the same
    // "gap between this item and the previous one" arithmetic, and
    // computing it twice risked the two falling out of sync.
    //
    // Why not just line.items.map(i => i.str).join(''): many PDF
    // producers express inter-word spacing purely through horizontal
    // positioning (a TJ operator's per-glyph offset array) rather than a
    // literal space character in any item's string — joining item.str
    // values directly for those PDFs glues words together
    // ("wordsrunningtogether"). The whitespace-collapse at the end makes
    // it safe to be liberal about inserting a space here: over-inserting
    // next to text that already had its own explicit space is harmless
    // (collapses right back to one), but under-inserting is the visible
    // bug — so gaps are treated as "probably a word boundary" whenever
    // they're comfortably larger than expected kerning noise, not only
    // when strictly necessary.
    let text = '';
    const gapWidths = [];
    let prevEnd = null;
    let prevFontSize = null;
    for (const it of line.items) {
      const isWhitespaceOnly = it.str.length > 0 && /^\s+$/.test(it.str);

      if (prevEnd != null) {
        const gap = isWhitespaceOnly ? it.width : it.x - prevEnd;
        if (gap > 0) {
          // pdf.js often represents a wide inter-column gap not as empty
          // space *between* two adjacent items, but as a single
          // space-character item whose own reported width spans the
          // full visual gap (its width can be 10-50x a normal
          // inter-word space at the same font size) — that has to be
          // measured directly via the item's own width, since the jump
          // into/out of it is ~0 either way.
          gapWidths.push(gap);
          // ~0.2x the font size sits comfortably below any real
          // inter-word gap and comfortably above kerning/rounding noise
          // between glyphs *within* a word — the same order of
          // magnitude pdf.js's own text-layer builder uses for this
          // decision.
          const threshold = Math.max((prevFontSize || it.fontSize) * 0.2, 1);
          if (!isWhitespaceOnly && gap > threshold && !/^\s/.test(it.str) && !/\s$/.test(text)) {
            text += ' ';
          }
        }
      }
      text += it.str;
      prevEnd = it.x + it.width;
      prevFontSize = it.fontSize;
    }
    text = text.replace(/\s+/g, ' ').trim();

    const fontSize = median(line.items.map(i => i.fontSize));
    const x = line.items[0].x;

    return {
      text, fontSize, x, y: line.y, gapBefore,
      firstItemIndex: line.items[0].origIndex,
      lastItemIndex: lastItem.origIndex,
      lastItemLen: lastItem.str.length,
      gapWidths,
    };
  }).filter(l => l.text.length > 0);
}

/** How many gaps in this line are wide enough to suggest separate table
 *  cells rather than ordinary word-spacing. */
function countWideGaps(line) {
  if (!line.gapWidths.length) return 0;
  const threshold = Math.max(line.fontSize * TABLE_GAP_FONT_MULTIPLE, TABLE_GAP_MIN_PT);
  return line.gapWidths.filter(g => g > threshold).length;
}

function looksLikeTableRow(line) {
  if (countWideGaps(line) < TABLE_MIN_WIDE_GAPS) return false;
  const wordCount = (line.text.match(/\S+/g) || []).length;
  return wordCount > 0 && wordCount <= TABLE_MAX_ROW_WORDS;
}

/** Flags `isTableRow` on every line in a run of
 *  TABLE_MIN_CONSECUTIVE_ROWS-or-more consecutive candidate lines —
 *  mutates `lines` in place. A lone candidate line is left alone; see the
 *  file header comment for why a single wide gap isn't sufficient on
 *  its own. */
function markTableRows(lines) {
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isCandidate = i < lines.length && looksLikeTableRow(lines[i]);
    if (isCandidate) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1 && i - runStart >= TABLE_MIN_CONSECUTIVE_ROWS) {
        for (let j = runStart; j < i; j++) lines[j].isTableRow = true;
      }
      runStart = -1;
    }
  }
}

function refFromLine(line) {
  return {
    beginIndex: line.firstItemIndex,
    beginOffset: 0,
    endIndex: line.lastItemIndex,
    endOffset: line.lastItemLen,
  };
}

const BARE_NUMBER_RE = /^\d{1,4}$/;
// A genuine multi-level number ("3.2", "3.2.1") is close to unambiguous as
// a heading — list items are essentially never numbered this way. A
// single-level number ("1.", "2)") is genuinely ambiguous on the digits
// alone (compare a top-level "1. Introduction" heading to a plain
// "1. Buy milk" list item) and needs the font-size signal to break the tie.
const MULTI_LEVEL_HEADING_NUM_RE = /^\d+(?:\.\d+){1,3}\.?\s+\S/;

// A standalone line set entirely in capitals — requiring at least two
// actual letters rules out a bare code/number ("F-16", "24/7") slipping
// through — is a common way to mark a section heading *without* changing
// point size at all, which the isLarge-based signal below can't see.
// Deliberately checked on the line's text alone, not font metrics: many
// technical documents (this plugin's actual target material) use
// same-size caps for headings, especially in older LaTeX/Word templates.
const ALL_CAPS_HEADING_RE = /^(?=(?:.*[A-Z]){2,})[A-Z0-9][A-Z0-9\s\-:,.'&]{0,70}$/;

// Same idea, for the extremely common case of an un-numbered heading in
// ordinary title case ("Abstract", "Related Work") — no font-size or
// capitalization signal distinguishes these from a short body sentence at
// all, so this is a closed, deliberately conservative list of words that
// are overwhelmingly section headings and almost never a complete
// sentence on their own line, rather than an attempt at a general
// "looks like a heading" classifier.
const COMMON_HEADING_WORDS = new Set([
  'abstract', 'introduction', 'conclusion', 'conclusions', 'references',
  'bibliography', 'acknowledgments', 'acknowledgements', 'appendix',
  'appendices', 'related work', 'prior work', 'background', 'discussion',
  'results', 'methodology', 'methods', 'materials and methods', 'summary',
  'overview', 'preface', 'contents', 'table of contents',
  'literature review', 'future work', 'limitations', 'notation',
  'nomenclature', 'glossary', 'index', 'motivation', 'evaluation',
  'experiments', 'experimental setup', 'implementation', 'design',
  'problem statement', 'related literature',
]);

/** Classifies one line given document-wide body font size + left margin,
 *  plus context about what came immediately before and after it on the
 *  page. Table rows are handled separately by the caller (markTableRows),
 *  since that's a run-of-lines judgment rather than a per-line one.
 *  @param {{prevLineEndsSentence?: boolean|null, hasBigGapBefore?: boolean, nextLineContinuesSentence?: boolean, nextLineAtBodyMargin?: boolean}} [context]
 *    `prevLineEndsSentence` is null when there's no previous line on the
 *    page (nothing to compare against — treated as "unknown," not as
 *    "complete," so it doesn't itself grant heading status).
 *    `hasBigGapBefore` compares this line's actual vertical gap against
 *    the document's typical line-to-line gap (see extractPdfSegments).
 *    `nextLineContinuesSentence` is true when the line immediately after
 *    this one starts with a lowercase letter — the standard signal that
 *    it's a wrapped continuation, not a new sentence.
 *    `prevLineAtSameIndent` / `nextLineReturnsToShallower` disambiguate a
 *    modestly-indented, marker-less line between a list item and a
 *    paragraph's indented first line — deliberately compared against the
 *    immediately adjacent lines' own x-positions, not the document's
 *    global body margin, which can itself be skewed on a page where a
 *    large fraction of lines are indented (a list-heavy page, or a short
 *    test document) and so isn't a reliable "flush-left" baseline to
 *    measure every line against. */
function classifyLine(line, bodySize, bodyMargin, context = {}) {
  const {
    prevLineEndsSentence = null, hasBigGapBefore = false, nextLineContinuesSentence = false,
    prevLineAtSameIndent = false, nextLineReturnsToShallower = false,
  } = context;
  const isIndented = line.x > bodyMargin + 8;
  const trimmed = line.text.trim();
  const wordCount = (line.text.match(/\S+/g) || []).length;
  const isLarge = line.fontSize >= bodySize * 1.15;

  if (BARE_NUMBER_RE.test(trimmed)) return 'standalone-short'; // page number, footer digit, etc.

  // A line starting with a lowercase letter is, for all practical
  // purposes, never the start of a new sentence or heading in English —
  // it's the wrapped continuation of whatever came before, no matter how
  // heading-shaped it would otherwise look (short, coincidentally
  // matching a keyword, etc). Checked once, up front, so it rules out
  // every heading branch below rather than needing to be threaded
  // through each one individually.
  const startsLowercase = /^[a-z]/.test(trimmed);

  // The weaker, text-only heading signals (all-caps, common keyword, and
  // the whitespace-only signal below) are suppressed specifically when
  // the previous line demonstrably did *not* finish its sentence — a
  // wrapped continuation can easily be short, or happen to echo a common
  // word, but a real heading essentially never follows directly after an
  // unfinished sentence with no paragraph break in between. Numbering and
  // a real font-size jump stay as override-capable signals regardless
  // (they're reliable enough on their own that this shouldn't suppress
  // them) — e.g. "The following sections cover:" not ending in a period
  // doesn't stop the numbered heading right after it from still being
  // recognized.
  const continuesPrevSentence = prevLineEndsSentence === false;
  const clearForWeakHeadingSignal = !startsLowercase && !continuesPrevSentence;

  const looksLikeHeadingShape = !startsLowercase && (MULTI_LEVEL_HEADING_NUM_RE.test(line.text)
    || (isLarge && (HEADING_NUM_RE.test(line.text) || wordCount <= 14)));
  if (looksLikeHeadingShape && wordCount <= 20) return 'heading';

  if (clearForWeakHeadingSignal && wordCount <= 8 && !/[a-z]/.test(trimmed) && ALL_CAPS_HEADING_RE.test(trimmed)) {
    return 'heading';
  }

  if (clearForWeakHeadingSignal && wordCount <= 5) {
    const normalized = trimmed.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    if (COMMON_HEADING_WORDS.has(normalized)) return 'heading';
  }

  // Catches a heading style none of the signals above can see at all:
  // same size as body text, normal capitalization, no numbering — set
  // apart from surrounding text purely by extra vertical whitespace
  // before it. The "doesn't end in sentence/clause punctuation" check is
  // meant to keep this from firing on an ordinary short sentence that
  // just happens to start a new paragraph — but ordinary paragraph
  // spacing (the standard gap any well-formatted document puts before a
  // new paragraph) looks *exactly* like this from whitespace alone, and
  // a paragraph's own first line is just as likely to be short and
  // punctuation-free as a real heading is, if it happens to wrap early.
  // The `!nextLineContinuesSentence` check is what actually
  // distinguishes the two: a real heading is essentially never
  // immediately followed by a lowercase-starting continuation of its own
  // clause, while a wrapped paragraph opener always is.
  if (clearForWeakHeadingSignal && !nextLineContinuesSentence
      && hasBigGapBefore && wordCount <= 10 && !/[.!?,;:]$/.test(trimmed)) {
    return 'heading';
  }

  // A marker glyph is definitive regardless of indent depth. Without one,
  // a modestly-indented short line is genuinely ambiguous between two
  // very different things: a list item (many PDF generators render
  // bullets as a vector shape rather than a text glyph at all) and the
  // first line of a new paragraph, indented the way a great many books
  // mark one with no blank line between paragraphs. Indent *depth* alone
  // can't reliably tell them apart — a typical list indent and a typical
  // paragraph first-line indent are the same order of magnitude. What
  // does distinguish them: a paragraph's own continuation line always
  // returns to the ordinary body margin, while a list item's does not
  // (it stays indented, or the next item repeats a similar indent) —
  // see extractPdfSegments, which computes nextLineAtBodyMargin.
  const hasMarkerGlyph = BULLET_RE.test(line.text) || NUMBERED_LIST_RE.test(line.text);
  if (hasMarkerGlyph) return 'list-item';
  if (isIndented && wordCount <= 30) {
    // Already inside an established run of similarly-indented lines (this
    // one continues the same depth as the line before it) — a list item,
    // full stop, regardless of what comes after (the run could end here,
    // e.g. this is the last item before the list gives way to ordinary
    // text, which would otherwise look identical to a paragraph's own
    // wrap returning to the margin).
    if (prevLineAtSameIndent) return 'list-item';
    // Otherwise this is the start of a fresh indent — only a paragraph's
    // first line if it's about to end (the very next line drops back to
    // a shallower indent); an indent that persists into the next line
    // too reads as the start of a new list instead.
    return nextLineReturnsToShallower ? 'paragraph-line' : 'list-item';
  }
  return 'paragraph-line';
}

function endsWithHyphenBreak(text) {
  return /[a-z]-$/.test(text.trim());
}

/** Whether a line's text looks like it finished its sentence — the key
 *  signal for telling "this next line is a wrapped continuation" from
 *  "this next line starts something new." Trailing closing quotes/parens
 *  after the punctuation are allowed ('"Quoted." said Smith.' style). */
function endsWithSentencePunct(text) {
  return /[.!?]['")\u201d\u2019]*\s*$/.test(text.trim());
}

/**
 * @param {ArrayBuffer} arrayBuffer raw PDF bytes
 * @param {{maxPages?: number, pluginDir: string}} opts `pluginDir` is
 *   required — pdf.js needs to load both its main library and its worker
 *   script from an absolute location, and there's no reliable way to find
 *   this plugin's own folder from inside a bundled library.
 * @returns {Promise<{segments: Array, pageCount: number}>} `segments` is
 *   Segment[] per tokens.js's shape; `pageCount` is the PDF's real page
 *   count (not just the highest page that produced a segment — a trailing
 *   blank or image-only page still counts), so the player panel's page
 *   spinner/scrubber can bound itself correctly.
 */
async function extractPdfSegments(arrayBuffer, opts = {}) {
  const pdfjsLib = await loadPdfJs(opts.pluginDir);

  {
    // pdfjs-dist v6 throws "No GlobalWorkerOptions.workerSrc specified"
    // rather than silently falling back to a main-thread "fake worker" the
    // way older versions did, so setting this is required, not an
    // optimization. See loadPdfJs()'s doc comment for why this goes
    // through a Blob URL rather than a direct file path.
    const workerPath = path.join(opts.pluginDir, 'pdf.worker.js');
    const code = fs.readFileSync(workerPath, 'utf8');
    if (lastWorkerBlobUrl) URL.revokeObjectURL(lastWorkerBlobUrl); // don't leak one per narrate
    lastWorkerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerSrc = lastWorkerBlobUrl;
  }

  const doc = await pdfjsLib.getDocument({
    data: arrayBuffer,
    // pdf.js is chatty by default about embedded fonts it can't fully
    // interpret (undefined TrueType glyph instructions, etc.) — routine
    // and harmless for text extraction specifically (we never render
    // glyphs), but floods the console during normal use if left on.
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  }).promise;
  const pageCount = opts.maxPages ? Math.min(opts.maxPages, doc.numPages) : doc.numPages;

  const pages = [];
  const allFontSizes = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = groupIntoLines(content.items);
    markTableRows(lines);
    pages.push({ pageNum: p, lines });
    for (const l of lines) allFontSizes.push(l.fontSize);
  }

  const bodySize = median(allFontSizes) || 10;
  const allMargins = pages.flatMap(p => p.lines.map(l => l.x));
  const bodyMargin = median(allMargins) || 0;
  // The median of *all* line-to-line gaps lands close to "the normal
  // single-line leading within a paragraph," the same reasoning as
  // bodySize/bodyMargin above: most lines in a document are ordinary
  // paragraph lines, so outliers (paragraph breaks, headings, column
  // jumps) don't pull the median far from that.
  const typicalLineGap = median(
    pages.flatMap(p => p.lines.map(l => l.gapBefore).filter(g => g != null && g > 0))
  ) || 0;
  const BIG_GAP_MULTIPLE = 1.4;

  const segments = [];
  let paraBuffer = null; // { text, page, pdfRef, pdfRefPage }
  // Deliberately declared outside the page loop below: a sentence that
  // wraps across a page break deserves the same "don't treat this
  // continuation as a heading" guard as one that wraps within a page (see
  // classifyLine's clearForWeakHeadingSignal) — resetting this per page
  // meant a continuation landing as the very first line of a new page had
  // no prior-line context at all, which defaults to "unknown" rather than
  // "still mid-sentence," letting the weaker heading signals (all-caps, a
  // common heading word standing alone) fire on what's really just a
  // wrapped word or two. Whether the paragraph itself carries across the
  // boundary too is decided per-page below, in the same spirit.

  function flushParagraph() {
    if (paraBuffer && paraBuffer.text.trim()) {
      segments.push(segment('paragraph', paraBuffer.text.trim(), { page: paraBuffer.page, pdfRef: paraBuffer.pdfRef }));
    }
    paraBuffer = null;
  }

  let prevLineText = null;
  let prevLine = null;
  for (const { pageNum, lines } of pages) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.isTableRow) {
        flushParagraph();
        segments.push(segment('table-row', line.text, { page: pageNum, pdfRef: refFromLine(line) }));
        prevLineText = line.text;
        prevLine = line;
        continue;
      }

      const nextLine = lines[li + 1];
      const context = {
        prevLineEndsSentence: prevLineText == null ? null : endsWithSentencePunct(prevLineText),
        hasBigGapBefore: line.gapBefore != null && typicalLineGap > 0 && line.gapBefore > typicalLineGap * BIG_GAP_MULTIPLE,
        nextLineContinuesSentence: !!nextLine && /^[a-z]/.test(nextLine.text.trim()),
        prevLineAtSameIndent: !!prevLine && Math.abs(line.x - prevLine.x) <= 8,
        nextLineReturnsToShallower: !!nextLine && (line.x - nextLine.x) > 8,
      };
      const kind = classifyLine(line, bodySize, bodyMargin, context);
      prevLineText = line.text;
      prevLine = line;

      if (kind === 'heading') {
        flushParagraph();
        segments.push(segment('heading', line.text, { page: pageNum, pdfRef: refFromLine(line) }));
        continue;
      }

      if (kind === 'list-item') {
        flushParagraph();
        const cleaned = line.text.replace(BULLET_RE, '').replace(NUMBERED_LIST_RE, '');
        segments.push(segment('list-item', cleaned, { page: pageNum, pdfRef: refFromLine(line) }));
        continue;
      }

      if (kind === 'standalone-short') {
        // A bare short number (typically a page number) never gets merged
        // into surrounding body text — if it did, the boilerplate-pattern
        // filter downstream (which matches whole-segment text) could never
        // catch it, since it'd just be a substring buried mid-paragraph.
        flushParagraph();
        segments.push(segment('paragraph', line.text, { page: pageNum, pdfRef: refFromLine(line) }));
        continue;
      }

      // Plain body line: either continues the paragraph in progress or
      // starts a new one. Three ways a new paragraph can start here:
      //   1. Nothing is in progress yet.
      //   2. This line is indented and paraBuffer already looks like a
      //      finished sentence — classifyLine has already ruled out this
      //      being a list item (via nextLineAtBodyMargin), so an indent
      //      reaching here is a paragraph's first line, marked the
      //      standard way a great many books do it: indentation alone,
      //      no blank-line gap between paragraphs at all.
      // Otherwise it's a continuation: a hyphenated line-break is
      // rejoined without the hyphen or an inserted space, anything else
      // joins with a space.
      const looksLikeIndentedParaStart = paraBuffer
        && line.x > bodyMargin + 8
        && endsWithSentencePunct(paraBuffer.text);
      if (looksLikeIndentedParaStart) flushParagraph();

      if (!paraBuffer) {
        paraBuffer = { text: line.text, page: pageNum, pdfRef: refFromLine(line), pdfRefPage: pageNum };
      } else if (endsWithHyphenBreak(paraBuffer.text)) {
        paraBuffer.text = paraBuffer.text.replace(/-$/, '') + line.text;
        if (paraBuffer.pdfRefPage === pageNum) {
          paraBuffer.pdfRef.endIndex = line.lastItemIndex;
          paraBuffer.pdfRef.endOffset = line.lastItemLen;
        }
      } else {
        paraBuffer.text += ' ' + line.text;
        if (paraBuffer.pdfRefPage === pageNum) {
          paraBuffer.pdfRef.endIndex = line.lastItemIndex;
          paraBuffer.pdfRef.endOffset = line.lastItemLen;
        }
      }
    }
    // A page boundary is not, by itself, a paragraph boundary — the gap
    // between the bottom margin of one page and the top margin of the
    // next is just where the paper ends, not a real gap the author put
    // there, and a huge fraction of sentences wrap across it with
    // nothing else marking a break. Only flush here if the paragraph in
    // progress looks genuinely finished (ends in sentence-final
    // punctuation); otherwise let it carry into the next page and keep
    // accumulating there, so what's really one continuous sentence
    // doesn't get an incorrect pause inserted at the seam. `pdfRef` stops
    // extending once a paragraph crosses a page boundary either way
    // (pdfRefPage check above) — its begin/end indices are positions
    // within one page's own text-item list, not a document-wide space,
    // so continuing to extend them past the page they started on would
    // point a "precise selection" lookup at the wrong page's content.
    if (paraBuffer && endsWithSentencePunct(paraBuffer.text)) {
      flushParagraph();
    }
  }
  flushParagraph(); // whatever's left — e.g. the document's last paragraph

  return { segments, pageCount };
}

module.exports = { extractPdfSegments, groupIntoLines, classifyLine, median };
