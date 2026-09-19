/*
  rules/figuresAndTables.js

  Handles two distinct shapes of the same problem:
    1. A standalone caption segment ("Figure 4.2: Block diagram of the...")
       — can be skipped entirely, replaced with a marker/pause, or kept.
    2. An inline reference inside ordinary prose ("...as shown in (Fig 3.1)")
       — dropping the whole sentence would be too aggressive, so inline
       references only ever get replaced with a marker or a pause, never
       full segment removal.

  `keywords` is a plain user-editable string list — "figure", "table",
  "listing", "algorithm", whatever the user's material uses — matched
  case-insensitively against a leading "<keyword> <number>" pattern.
*/

'use strict';

const { text, pause } = require('../tokens');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCaptionRegex(keywords) {
  const kws = keywords.map(escapeRegExp).join('|');
  return new RegExp(`^(?:${kws})\\.?\\s*\\d+[a-z]?(?:\\.\\d+)?\\s*[:.\\-\u2013]?\\s*`, 'i');
}

function buildInlineCaptionRegex(keywords) {
  const kws = keywords.map(escapeRegExp).join('|');
  return new RegExp(`\\(\\s*(?:see\\s+)?(?:${kws})\\.?\\s*\\d+[a-z]?(?:\\.\\d+)?\\s*\\)`, 'gi');
}

function markerFor(config) {
  return (config.replacement || '').trim(); // '' => caller inserts a pause
}

/** @returns {object|null} the (possibly transformed) segment, or null if it
 *  should be dropped entirely. */
function applyStandaloneCaption(segment, config, plainTextOf, pauseMs) {
  if (!config.enabled || !config.keywords.length) return segment;
  const t = plainTextOf(segment.tokens).trim();
  if (!buildCaptionRegex(config.keywords).test(t)) return segment;

  if (config.mode === 'keep') return segment;
  if (config.mode === 'skip') return null;

  const marker = markerFor(config);
  return { ...segment, tokens: marker ? [text(marker, 'caption-replaced')] : [pause(pauseMs, 'caption')] };
}

function applyInlineCaptions(segment, config, pauseMs) {
  if (!config.enabled || !config.keywords.length || config.mode === 'keep') return segment;
  const re = buildInlineCaptionRegex(config.keywords);
  const marker = markerFor(config);

  const tokens = [];
  for (const tok of segment.tokens) {
    if (tok.kind !== 'text') { tokens.push(tok); continue; }
    re.lastIndex = 0;
    if (!re.test(tok.value)) { tokens.push(tok); continue; }

    re.lastIndex = 0;
    let cursor = 0, m;
    while ((m = re.exec(tok.value))) {
      const before = tok.value.slice(cursor, m.index);
      if (before) tokens.push(text(before));
      if (marker) tokens.push(text(marker, 'caption-inline-replaced'));
      else tokens.push(pause(pauseMs, 'caption-inline'));
      cursor = m.index + m[0].length;
    }
    const tail = tok.value.slice(cursor);
    if (tail) tokens.push(text(tail));
  }
  return { ...segment, tokens };
}

module.exports = { applyStandaloneCaption, applyInlineCaptions, buildCaptionRegex, buildInlineCaptionRegex };
