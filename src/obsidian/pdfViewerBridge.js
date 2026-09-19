/*
  obsidian/pdfViewerBridge.js

  "Play from current page" and "play from cursor" both need to ask
  Obsidian's built-in PDF viewer two things it doesn't expose in the
  public Plugin API: which page is currently in view, and what text (if
  any) is selected right now. Obsidian's viewer is a real pdf.js under
  the hood, so this reaches into two different places depending on what's
  being asked:

    - current page: the PDFViewerChild's own pdf.js PDFViewer instance,
      via `leaf.view.viewer.child.pdfViewer.pdfViewer.currentPageNumber`.
      That chain is undocumented and has shifted before across Obsidian
      versions (community PDF plugins like PDF++ carry the same caveat
      for the equivalent lookup), so every hop below is guarded — a
      failure here just means "we don't know," not a thrown error.
    - selected text / its page: the standard DOM Selection API scoped to
      the viewer's own container element, plus pdf.js's convention of
      wrapping each rendered page in `div.page[data-page-number]`. This
      half doesn't touch any Obsidian internals, so it's the more
      durable of the two across Obsidian updates.

  Everything here returns null on failure rather than throwing, so
  callers (main.js's playFrom()) can fall back to the page spinner's
  typed-in value instead of the seek failing outright.
*/

'use strict';

/** @returns {import('obsidian').WorkspaceLeaf | null} the leaf currently
 *  showing `file` in Obsidian's built-in PDF view, if any. */
function findPdfLeaf(app, file) {
  if (!file) return null;
  try {
    const leaves = app.workspace.getLeavesOfType('pdf');
    return leaves.find(l => l.view && l.view.file && l.view.file.path === file.path) || null;
  } catch {
    return null;
  }
}

function getViewerChild(app, file) {
  try {
    const leaf = findPdfLeaf(app, file);
    return leaf && leaf.view && leaf.view.viewer ? leaf.view.viewer.child : null;
  } catch {
    return null;
  }
}

/** Best-effort "what page is the PDF viewer currently showing" for
 *  `file`, or null if it isn't open or the internal shape changed. */
function getCurrentPage(app, file) {
  const child = getViewerChild(app, file);
  if (!child) return null;
  try {
    const n = child.pdfViewer && child.pdfViewer.pdfViewer && child.pdfViewer.pdfViewer.currentPageNumber;
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* internals moved; try the next spot */ }
  try {
    // A couple of Obsidian releases have surfaced this directly on the
    // child instead of nested under pdf.js's own viewer object.
    const n = child.page;
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* fall through to null below */ }
  return null;
}

/** Walks up from a DOM node to pdf.js's own page wrapper and reads its
 *  1-based page number, per the `div.page[data-page-number]` convention
 *  pdf.js's text layer renders with. */
function pageNumberOfNode(node) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  while (el) {
    if (el.dataset && el.dataset.pageNumber) {
      const n = Number(el.dataset.pageNumber);
      if (Number.isInteger(n) && n > 0) return n;
    }
    el = el.parentElement;
  }
  return null;
}

/** Best-effort "what text is currently selected in `file`'s PDF viewer,
 *  and which page it's on" — or null if nothing's selected there (a
 *  selection elsewhere in the Obsidian window, e.g. in a markdown note,
 *  doesn't count and correctly returns null too). */
function getSelectionInfo(app, file) {
  const leaf = findPdfLeaf(app, file);
  if (!leaf || !leaf.view || !leaf.view.containerEl) return null;
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const anchorNode = sel.anchorNode;
    if (!anchorNode || !leaf.view.containerEl.contains(anchorNode)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const page = pageNumberOfNode(anchorNode) || getCurrentPage(app, file);
    return { text, page };
  } catch {
    return null;
  }
}

module.exports = { findPdfLeaf, getViewerChild, getCurrentPage, getSelectionInfo };
