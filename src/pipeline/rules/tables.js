/*
  rules/tables.js

  The actual table-shape *detection* happens in extractor.js, the only
  stage with access to pdf.js's raw item positions — that stage tags each
  row it finds as its own `type: 'table-row'` segment. This rule decides
  what to do with them, list-level (like filterRepeatedHeadersFooters)
  rather than per-segment (like most other rules/ modules): a table is a
  *run* of consecutive table-row segments, and collapsing that whole run
  into a single marker/pause reads far better than replacing each row one
  at a time, which would speak (or silently pause for) every single row.
  Same enabled/mode/replacement shape as figuresAndTables.js on purpose,
  for a consistent settings UI.
*/

'use strict';

const { text, pause } = require('../tokens');

function filterTableRows(segments, config, pauseMs) {
  if (!config.enabled) return segments;

  const out = [];
  let i = 0;
  while (i < segments.length) {
    if (segments[i].type !== 'table-row') {
      out.push(segments[i]);
      i++;
      continue;
    }

    let j = i;
    while (j < segments.length && segments[j].type === 'table-row') j++;

    if (config.mode === 'keep') {
      out.push(...segments.slice(i, j));
    } else if (config.mode === 'replace') {
      const marker = (config.replacement || '').trim();
      out.push({ ...segments[i], tokens: marker ? [text(marker, 'table-replaced')] : [pause(pauseMs, 'table')] });
    } // 'skip' (or anything else): drop the whole run, push nothing

    i = j;
  }
  return out;
}

module.exports = { filterTableRows };
