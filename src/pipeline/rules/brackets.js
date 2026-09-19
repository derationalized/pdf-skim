/*
  rules/brackets.js

  Independently configurable filtering for ( ), [ ], and { } content —
  citations, asides, cross-references. Each bracket type has its own
  enabled flag, minimum-word-count threshold, "always strip if
  citation-shaped regardless of length" flag, and replacement string.

  Replacement string is user-entered free text now, not a hardcoded
  "citation omitted." If the user leaves it blank, the cut content becomes
  a pause token (exact silence) instead of a spoken marker — a deliberate
  third option, not just "empty string happens to render as nothing."
*/

'use strict';

const { text, pause } = require('../tokens');
const { CITATION_SHAPE_RE } = require('../patterns');

const BRACKET_CHARS = {
  parens: ['(', ')'],
  square: ['[', ']'],
  curly: ['{', '}'],
};

function countWords(s) {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Finds top-level bracket spans with simple depth tracking — sufficient for
// prose, which doesn't nest the same bracket type deeply.
function findBracketSpans(str, open, close) {
  const spans = [];
  let depth = 0, start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === close && depth > 0) {
      depth--;
      if (depth === 0) spans.push([start, i]);
    }
  }
  return spans;
}

function decideCut(inner, config) {
  if (!config.enabled) return { cut: false };
  const isCitation = config.alwaysStripCitations && CITATION_SHAPE_RE.test(inner.trim());
  const longEnough = countWords(inner) >= (config.minWords || 0);
  if (!isCitation && !longEnough) return { cut: false };
  return { cut: true, marker: (config.replacement || '').trim() };
}

/** Runs one bracket type's filter over a single string, returning an array
 *  of text/pause tokens (not a string) so a silent cut becomes a real pause
 *  token rather than an empty-string sentinel to parse back out later. */
function applyBracketFilter(str, bracketKey, config, pauseMs) {
  const [open, close] = BRACKET_CHARS[bracketKey];
  const spans = findBracketSpans(str, open, close);
  if (!spans.length) return [text(str)];

  const out = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    const inner = str.slice(s + 1, e);
    const { cut, marker } = decideCut(inner, config);
    const before = str.slice(cursor, s);
    if (before) out.push(text(before));

    if (!cut) out.push(text(str.slice(s, e + 1)));
    else if (marker) out.push(text(marker, `bracket-${bracketKey}-replaced`));
    else out.push(pause(pauseMs, `bracket-${bracketKey}`));

    cursor = e + 1;
  }
  const tail = str.slice(cursor);
  if (tail) out.push(text(tail));
  return out;
}

/** Runs all three bracket types over a segment, in sequence, feeding each
 *  stage's output back in as the next stage's input so adjacent/nested
 *  bracket types compose correctly (e.g. "(see [12])"). */
function applyBrackets(segment, config, pauseMs) {
  const tokens = [];
  for (const tok of segment.tokens) {
    if (tok.kind !== 'text') { tokens.push(tok); continue; }

    let pieces = [tok];
    for (const key of Object.keys(BRACKET_CHARS)) {
      const cfg = config[key];
      if (!cfg || !cfg.enabled) continue;
      const next = [];
      for (const piece of pieces) {
        if (piece.kind !== 'text') { next.push(piece); continue; }
        next.push(...applyBracketFilter(piece.value, key, cfg, pauseMs));
      }
      pieces = next;
    }
    tokens.push(...pieces);
  }
  return { ...segment, tokens };
}

module.exports = { applyBrackets, applyBracketFilter, findBracketSpans, BRACKET_CHARS };
