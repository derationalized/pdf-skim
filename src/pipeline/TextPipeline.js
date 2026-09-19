/*
  TextPipeline.js

  Composes every rule into one ordered pass over a document's segments and
  flattens the result into a flat token stream: a sequence of {kind:'text'}
  and {kind:'pause', ms} tokens. That flat stream is the contract with the
  speech backend — it doesn't know or care about segments, headings, or
  filtering; it just walks the tokens, batching runs of text into synthesis
  calls and turning pause tokens into exact silence between them.

  Order is deliberate, not arbitrary:
    1. Whole-document structural rules first (truncate at References,
       dedupe repeated headers/footers, collapse detected table rows) —
       no point running per-segment filters on content that's about to be
       discarded anyway.
    2. Per-segment content rules, widest cuts first: drop whole boilerplate
       segments, then whole caption segments, before narrower inline spans
       (inline captions, then bracket contents).
    3. Cosmetic text transforms last (heading normalization, then
       substitutions) — substitutions in particular should never touch text
       that's about to be removed by an earlier stage, so they run after
       all the content-removal rules, not before.
    4. Structural pause insertion, once the segment list is final.

  processSegments() vs process(): the original contract only needed a flat
  token stream for the speech backend. The Obsidian plugin also needs to
  know, for any given point in playback, which page it came from (to jump
  back into the PDF, or to write a link into a note) — information that
  process()'s final flatMap throws away. processSegments() exposes the
  pipeline's output one step earlier, as the segment list (each still
  carrying its `page`), so callers that need that mapping don't have to
  duplicate the whole stage list above. process() is unchanged and is now
  just processSegments(...).flatMap(...).
*/

'use strict';

const { filterBoilerplate, filterRepeatedHeadersFooters } = require('./rules/boilerplateAndHeaderFooter');
const { filterTableRows } = require('./rules/tables');
const { applyBrackets } = require('./rules/brackets');
const { applyStandaloneCaption, applyInlineCaptions } = require('./rules/figuresAndTables');
const { stopAtReferences, normalizeHeading, insertStructuralPauses } = require('./rules/structure');
const { applySubstitutionsTracked } = require('./substitutions');
const { plainText, mapText } = require('./tokens');

function processSegments(segments, config) {
  let list = segments;

  list = stopAtReferences(list, config.stopAtReferences);
  list = filterRepeatedHeadersFooters(list, config.removeRepeatedHeadersFooters);
  list = filterTableRows(list, config.tables, config.pauses.tableMs);

  list = list
    .map(seg => filterBoilerplate(seg, config.removeBoilerplate))
    .filter(Boolean);

  list = list
    .map(seg => applyStandaloneCaption(seg, config.figuresAndTables, plainText, config.pauses.captionMs))
    .filter(Boolean);

  list = list.map(seg => applyInlineCaptions(seg, config.figuresAndTables, config.pauses.captionMs));
  list = list.map(seg => applyBrackets(seg, config.brackets, config.pauses.bracketMs));

  list = list.map(seg => normalizeHeading(seg, config.headings));

  list = list.map(seg => ({
    ...seg,
    tokens: mapText(seg.tokens, (t) => {
      const { result, applied } = applySubstitutionsTracked(t, config.substitutions);
      return applied.length ? { value: result, debugTag: `substituted: ${applied.join(', ')}` } : result;
    }),
  }));

  list = insertStructuralPauses(list, config.structuralPauses);

  return list;
}

function process(segments, config) {
  return processSegments(segments, config).flatMap(seg => seg.tokens);
}

module.exports = { process, processSegments };
