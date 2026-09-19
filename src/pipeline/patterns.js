'use strict';

// A single author-year citation piece, e.g. "Smith, 2020" or
// "Smith et al., 2020" or "Smith & Jones, 2019".
const CITE_AUTHOR = '[A-Z][\\w.\\-]+(?:\\s+(?:&|and)\\s+[A-Z][\\w.\\-]+)?(?:\\s+et al\\.?)?';
const CITE_ONE = `${CITE_AUTHOR},?\\s*\\d{4}[a-z]?`;

// Matches when the *entire* content of a bracket pair is citation-shaped —
// either one or more semicolon-separated author-year citations, or a
// comma/dash-separated numeric citation list like "12, 13, 14" or "12-15".
const CITATION_SHAPE_RE = new RegExp(
  `^\\s*(?:${CITE_ONE}(?:\\s*;\\s*${CITE_ONE})*|\\d+(?:\\s*[,;\\-\u2013]\\s*\\d+)*)\\s*$`
);

// Editable defaults for the boilerplate-removal rule — plain regex source
// strings, matched case-insensitively, so they're extendable from settings
// without inventing a settings-UI-specific mini-language.
const DEFAULT_BOILERPLATE_PATTERNS = [
  '^\\d{1,4}$',
  '^page\\s+\\d+\\s+of\\s+\\d+$',
  '^downloaded from .*',
  '^doi\\s*:?\\s*\\S*.*',
  '^https?:\\/\\/\\S+$',
  '^issn\\s*:?.*',
  '^isbn\\s*:?.*',
  '^\u00a9.*',
  '^copyright\\b.*',
  '^all rights reserved\\.?$',
  '^arxiv\\s*:\\s*\\S+',
  '^preprint\\b.*',
  '^this article is protected .*',
  '^licen[cs]ed under .*',
];

const REFERENCES_HEADING_RE = /^(references|bibliography|works cited|literature cited)\b/i;

module.exports = { CITATION_SHAPE_RE, DEFAULT_BOILERPLATE_PATTERNS, REFERENCES_HEADING_RE };
