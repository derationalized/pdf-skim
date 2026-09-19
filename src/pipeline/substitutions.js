/*
  substitutions.js

  One generalized text-substitution pass, deliberately used for two
  different-feeling purposes:
    - "abbreviation expansion"   e.g. "e.g."  -> "for example"
    - "custom pronunciation"     e.g. "CMOS"  -> "sea moss"
  Both are just "replace this written form with a form the synthesis engine
  will say the way I want" — no reason to build two separate features/config
  sections for the same mechanism.

  A pronunciation entry works by plain text substitution: swap the acronym
  for a phonetic respelling *before* synthesis, and rely on the engine's own
  grapheme-to-phoneme handling of the replacement text to land close to the
  intended pronunciation. That's why "CMOS" -> "sea moss" works but you
  can't hand it IPA directly — sherpa's VITS/Kokoro models take plain text
  in, not phonemes.
*/

'use strict';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{match:string, replace:string, wholeWord?:boolean, caseSensitive?:boolean}} entry
 */
function compileEntry(entry) {
  const flags = entry.caseSensitive ? 'g' : 'gi';
  const body = entry.wholeWord === false
    ? escapeRegExp(entry.match)
    : `\\b${escapeRegExp(entry.match)}\\b`;
  return { re: new RegExp(body, flags), replace: entry.replace };
}

function applySubstitutions(str, entries) {
  let out = str;
  for (const entry of entries) {
    if (!entry.match) continue;
    let re, replace;
    try {
      ({ re, replace } = compileEntry(entry));
    } catch {
      continue; // skip a malformed entry rather than crash the whole pipeline
    }
    out = out.replace(re, replace);
  }
  return out;
}

/** Same substitution pass as applySubstitutions, but also reports which
 *  entries actually matched something — for the debug-mode narration
 *  overlay only (see tokens.js's mapText/text doc comment). Kept as a
 *  separate function rather than an option on applySubstitutions so the
 *  common case stays a plain string in, string out call. */
function applySubstitutionsTracked(str, entries) {
  let out = str;
  const applied = [];
  for (const entry of entries) {
    if (!entry.match) continue;
    let re, replace;
    try {
      ({ re, replace } = compileEntry(entry));
    } catch {
      continue;
    }
    if (re.test(out)) applied.push(`${entry.match}\u2192${entry.replace}`);
    re.lastIndex = 0; // .test() above advanced it (global flag); replace() below needs it reset
    out = out.replace(re, replace);
  }
  return { result: out, applied };
}

// Sensible starting set so the settings UI isn't a blank list on first
// launch. Every entry here is just data — freely editable, removable, or
// reorderable by the user; nothing about the engine treats these specially.
const DEFAULT_SUBSTITUTIONS = [
  { match: 'e.g.', replace: 'for example', wholeWord: false, caseSensitive: false },
  { match: 'i.e.', replace: 'that is', wholeWord: false, caseSensitive: false },
  { match: 'et al.', replace: 'and colleagues', wholeWord: false, caseSensitive: false },
  { match: 'etc.', replace: 'and so on', wholeWord: false, caseSensitive: false },
  { match: 'cf.', replace: 'compare', wholeWord: false, caseSensitive: false },
  { match: 'vs.', replace: 'versus', wholeWord: false, caseSensitive: false },
  { match: 'approx.', replace: 'approximately', wholeWord: false, caseSensitive: false },
  { match: 'fig.', replace: 'figure', wholeWord: false, caseSensitive: false },
  { match: 'figs.', replace: 'figures', wholeWord: false, caseSensitive: false },
  { match: 'eq.', replace: 'equation', wholeWord: false, caseSensitive: false },
  { match: 'eqn.', replace: 'equation', wholeWord: false, caseSensitive: false },
  { match: 'sec.', replace: 'section', wholeWord: false, caseSensitive: false },
  { match: 'vol.', replace: 'volume', wholeWord: false, caseSensitive: false },
  { match: 'ibid.', replace: 'in the same source', wholeWord: false, caseSensitive: false },
];

module.exports = { applySubstitutions, applySubstitutionsTracked, compileEntry, escapeRegExp, DEFAULT_SUBSTITUTIONS };
