'use strict';

const { DEFAULT_BOILERPLATE_PATTERNS } = require('./patterns');
const { DEFAULT_SUBSTITUTIONS } = require('./substitutions');

const DEFAULT_CONFIG = {
  removeBoilerplate: { enabled: true, patterns: DEFAULT_BOILERPLATE_PATTERNS },
  removeRepeatedHeadersFooters: { enabled: true, minRepeatFraction: 0.1 },
  stopAtReferences: { enabled: false },

  brackets: {
    parens: { enabled: false, minWords: 4, alwaysStripCitations: true, replacement: '' },
    square: { enabled: true, minWords: 0, alwaysStripCitations: true, replacement: '' },
    curly: { enabled: true, minWords: 0, alwaysStripCitations: false, replacement: '' },
  },

  figuresAndTables: {
    enabled: true,
    mode: 'skip', // 'replace' | 'skip' | 'keep' (standalone captions only — inline refs never fully drop)
    keywords: ['figure', 'fig', 'table', 'tbl'],
    replacement: 'figure omitted', // blank => silent pause
  },

  tables: {
    enabled: true,
    mode: 'replace', // 'skip' | 'replace' | 'keep' — applies to a whole detected table, not row-by-row
    replacement: 'table omitted', // blank => silent pause; used only in 'replace' mode
  },

  headings: { enabled: true, pauseAfterNumberMs: 120 },

  structuralPauses: {
    enabled: true,
    betweenParagraphsMs: 100,
    afterHeadingMs: 80,
    beforeHeadingMs: 120,
    beforeListMs: 25,
    betweenListItemsMs: 20,
  },

  // Pauses within a sentence/paragraph, at the punctuation-mark level —
  // distinct from structuralPauses above, which only operates between
  // whole paragraphs/headings/list items. On by default with modest
  // values: the TTS engine already inserts its own prosodic pausing for
  // these, and every pause here is on top of that, not a replacement for
  // it (see the comment on splitIntoSpeechCues in PlaybackController.js)
  // — raise these if narration still feels rushed even with a good voice
  // model, or lower/disable if it feels choppy with one that already
  // paces itself well.
  punctuationPauses: {
    enabled: true,
    periodMs: 80,
    questionMs: 110,
    exclamationMs: 100,
    commaMs: 5,
    colonMs: 15,
    semicolonMs: 20,
    beforeParenMs: 5,
    beforeSquareMs: 10,
    beforeCurlyMs: 10,
  },

  pauses: {
    captionMs: 0, // silence used when a caption/inline reference is cut silently
    bracketMs: 0, // silence used when a bracketed aside is cut silently
    tableMs: 0, // silence used when a detected table is cut silently
  },

  substitutions: DEFAULT_SUBSTITUTIONS,

  // Purely a display setting — never changes what's sent to the speech
  // engine. When on, the player panel's "now reading" line shows the
  // same text plus inline markers for every pause/replacement decision
  // that was made getting there (e.g. "{pause: before-heading}",
  // "[substituted: CMOS→sea moss]"), meant for tuning the filtering
  // heuristics against a real document rather than guessing from the
  // audio alone. See PlaybackController's _buildDebugText.
  debugMode: false,
};

module.exports = { DEFAULT_CONFIG };
