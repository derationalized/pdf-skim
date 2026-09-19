/*
  rules/structure.js

  stopAtReferences — whole-document. Truncates the segment stream once a
  References/Bibliography-style heading is reached, so the endless
  citation list at the back of a paper or textbook chapter never gets
  synthesized at all.

  normalizeHeading — per-segment, cosmetic. "3.2 Related Work" becomes
  "Section 3.2." + a short pause + "Related Work", so numbered headings
  don't run the section number straight into the title.

  insertStructuralPauses — whole-document. Inserts exact-duration silence
  between segments based on the structural transition (paragraph ->
  heading, heading -> body, between list items, ...). This is the piece
  that was flatly impossible to do precisely over the old SAPI/browser
  speechSynthesis backend and is now just arithmetic, because pauses are
  real silence spliced into the audio rather than a request to an OS API
  that may or may not honor timing.
*/

'use strict';

const { text, pause, plainText } = require('../tokens');
const { REFERENCES_HEADING_RE } = require('../patterns');

function stopAtReferences(segments, config) {
  if (!config.enabled) return segments;
  const idx = segments.findIndex(seg =>
    seg.type === 'heading' && REFERENCES_HEADING_RE.test(plainText(seg.tokens).trim()));
  return idx === -1 ? segments : segments.slice(0, idx);
}

const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;

function normalizeHeading(segment, config) {
  if (!config.enabled || segment.type !== 'heading') return segment;
  const t = plainText(segment.tokens).trim();
  const m = t.match(NUMBERED_HEADING_RE);
  if (!m) return segment;
  return {
    ...segment,
    tokens: [text(`Section ${m[1]}.`), pause(config.pauseAfterNumberMs || 150, 'section-number'), text(m[2])],
  };
}

function insertStructuralPauses(segments, config) {
  if (!config.enabled) return segments;

  const out = [];
  segments.forEach((seg, i) => {
    out.push(seg);
    const next = segments[i + 1];
    if (!next) return;

    // Most specific transition wins outright — deliberately NOT a max() of
    // every applicable rule, since some specific pauses (e.g. between list
    // items) are meant to be *shorter* than the generic default, not longer.
    let ms;
    let reason;
    if (seg.type === 'list-item' && next.type === 'list-item') {
      ms = config.betweenListItemsMs || 0;
      reason = 'between-list-items';
    } else if (next.type === 'list-item' && seg.type !== 'list-item') {
      ms = config.beforeListMs || 0;
      reason = 'before-list';
    } else if (seg.type === 'heading') {
      ms = config.afterHeadingMs || 0;
      reason = 'after-heading';
    } else if (next.type === 'heading') {
      ms = config.beforeHeadingMs || 0;
      reason = 'before-heading';
    } else {
      ms = config.betweenParagraphsMs || 0;
      reason = 'paragraph-gap';
    }

    if (ms > 0) out.push({ type: 'pause-marker', level: null, page: seg.page, tokens: [pause(ms, reason)] });
  });
  return out;
}

module.exports = { stopAtReferences, normalizeHeading, insertStructuralPauses };
