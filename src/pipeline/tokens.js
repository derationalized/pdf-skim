/*
  tokens.js

  A Segment's `tokens` array is the pipeline's internal representation of
  "what to say and where to pause." Plain strings can't carry pause
  information cleanly, and baking pauses into text (extra punctuation,
  magic substrings) is exactly the hack the old SAPI-based prototype had to
  resort to, because a browser TTS API gives you no control over pause
  length once you've handed it a string.

  That constraint doesn't apply anymore. The speech backend (SherpaEngine)
  hands back raw PCM per synthesis call, and playback schedules those
  buffers itself — so a `pause` token can become an *exact* span of silence
  spliced between two audio buffers. This representation maps directly onto
  the final audio, not just the synthesized text.

  A Segment looks like:
    {
      type: 'heading' | 'paragraph' | 'list-item' | 'table-row' | 'raw',
      level: 1,        // heading depth / list nesting depth, or null
      page: 42,         // or null
      pdfRef: { beginIndex, beginOffset, endIndex, endOffset } | null,
      tokens: [ {kind:'text', value:'...'}, {kind:'pause', ms:200}, ... ],
    }

  A pause token can optionally carry `reason` (e.g. 'paragraph-gap',
  'before-heading', 'bracket-parens') and a text token can optionally
  carry `debugTag` (e.g. 'substituted', 'caption-replaced') — set by
  whichever rule made that decision, purely for the debug-mode narration
  overlay (see PlaybackController's buildCueQueue and Settings' "Debug
  mode" toggle). Neither field is ever sent to the speech engine — only
  `value`/`ms` are. A rule that doesn't pass one just omits it; nothing
  downstream requires it to be present.

  pdfRef, when present, is exactly the shape Obsidian's own PDF viewer
  expects for a `[[file.pdf#page=N&selection=<beginIndex>,<beginOffset>,
  <endIndex>,<endOffset>]]` deep link — beginIndex/endIndex are indices
  into that page's pdf.js `getTextContent().items` array (in pdf.js's own
  order, not the visual line order this pipeline reorders things into),
  and *Offset is a character offset within that item's string. Only
  extractor.js can compute this (it's the one place with access to
  pdf.js's raw per-item positions); every other stage just needs to
  carry it through untouched, which the `{ ...segment, ... }` spread
  pattern used throughout rules/ already does for free.
*/

'use strict';

function text(value, debugTag) {
  return debugTag ? { kind: 'text', value, debugTag } : { kind: 'text', value };
}

function pause(ms, reason) {
  return reason ? { kind: 'pause', ms, reason } : { kind: 'pause', ms };
}

function isBlank(tokens) {
  return !tokens.some(t => t.kind === 'text' && t.value.trim().length > 0);
}

function plainText(tokens) {
  return tokens.filter(t => t.kind === 'text').map(t => t.value).join('');
}

function mapText(tokens, fn) {
  return tokens.map((t) => {
    if (t.kind !== 'text') return t;
    const result = fn(t.value);
    // fn can return either a plain string (the common case — most rules
    // don't need to report anything for the debug overlay) or
    // {value, debugTag} when it does. Only text() itself constructs the
    // final token shape, so this is the one place both forms need
    // handling.
    return typeof result === 'string' ? { ...t, value: result } : { ...t, ...result };
  });
}

/** Convenience constructor for tests and for any stage still working with
 *  plain strings (e.g. a not-yet-built structural parser). */
function segment(type, str, opts = {}) {
  return {
    type,
    level: opts.level || null,
    page: opts.page != null ? opts.page : null,
    pdfRef: opts.pdfRef || null,
    tokens: [text(str)],
  };
}

module.exports = { text, pause, isBlank, plainText, mapText, segment };
