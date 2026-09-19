/*
  rules/boilerplateAndHeaderFooter.js

  Two related but structurally different rules:

  filterBoilerplate — per-segment. Drops a segment entirely if its full
  text matches one of a list of patterns (page numbers, DOI/ISBN lines,
  copyright notices, ...). Patterns are plain regex source strings, so
  they're extendable from settings without a settings-UI-specific
  mini-language, and default to a starter list covering the common cases
  from the spec doc.

  filterRepeatedHeadersFooters — whole-document. Running headers/footers
  don't have a fixed wording you can hardcode in advance (every book's
  header is different), so instead of pattern-matching, this finds short
  lines that repeat across a large fraction of pages and drops them
  empirically. Needs the full segment list, since "repeats across pages"
  is a document-level property, not a per-segment one.
*/

'use strict';

const { plainText } = require('../tokens');
const { DEFAULT_BOILERPLATE_PATTERNS } = require('../patterns');

function filterBoilerplate(segment, config) {
  if (!config.enabled) return segment;
  const t = plainText(segment.tokens).trim();
  if (!t) return segment;

  const patterns = config.patterns && config.patterns.length ? config.patterns : DEFAULT_BOILERPLATE_PATTERNS;
  for (const src of patterns) {
    let re;
    try { re = new RegExp(src, 'i'); } catch { continue; } // skip a typo'd pattern rather than crash the pipeline
    if (re.test(t)) return null;
  }
  return segment;
}

function filterRepeatedHeadersFooters(segments, config) {
  if (!config.enabled) return segments;

  const counts = new Map();
  for (const seg of segments) {
    const t = plainText(seg.tokens).trim();
    // Headers/footers are short; don't dedupe body paragraphs that happen
    // to repeat (e.g. a repeated code snippet or refrain).
    if (!t || t.length > 80) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  const pageCount = new Set(segments.map(s => s.page).filter(p => p != null)).size || 1;
  const threshold = Math.max(3, Math.ceil(pageCount * (config.minRepeatFraction != null ? config.minRepeatFraction : 0.3)));

  return segments.filter(seg => {
    const t = plainText(seg.tokens).trim();
    return !(t && t.length <= 80 && counts.get(t) >= threshold);
  });
}

module.exports = { filterBoilerplate, filterRepeatedHeadersFooters };
