/**
 * The journal's deliberately small Markdown dialect.
 *
 * Entries stay as the exact source the writer typed because marginalia and
 * promoted quotes address that source in Unicode code-point offsets. This
 * parser therefore describes presentation without rewriting the body: marker
 * characters are hidden at render time and every visible run retains its
 * original source range.
 *
 * ``chars`` is the ONLY stored representation of the body. Blocks, formats,
 * runs, spans and reveal ranges are all derived views, recomputed from it; the
 * model has no second copy of the text that could desync, and
 * {@link serializeJournalMarkdown} reads nothing else.
 *
 * This module is the facade. The line and block model lives in
 * ``journalMarkdownLines.ts``, inline emphasis in ``journalMarkdownInline.ts``,
 * and caret / reveal geometry in ``journalMarkdownCaret.ts``; everything this
 * file exported before is still exported from here.
 *
 * It deliberately imports nothing from React or React Native so both the
 * renderer and the editor can share it.
 *
 * Scope note: the byte-exact round trip below is a CLIENT-MODEL invariant.
 * ``POST``/``PUT /journal/`` run ``sanitize_user_text`` server-side, which NFC
 * normalises and strips zero-width characters, so a body containing combining
 * marks or a ZWJ emoji sequence comes back changed. That is deliberate security
 * policy, not a defect in this model.
 */
import { applyInlineFormatting } from './journalMarkdownInline';
import { bulletIndentWidths, buildBlocks, hideBlockPrefixes } from './journalMarkdownLines';
import type {
  CharacterFormat,
  JournalMarkdownDocument,
  JournalMarkdownRun,
} from './journalMarkdownTypes';

/**
 * The canonical source position of this dialect is the Unicode code-point
 * offset, and that is the very same number the anchor API uses. These two names
 * are re-exports, not wrappers: ``utf16ToSource`` IS ``utf16ToCodePoint`` by
 * reference, so a second conversion implementation cannot be introduced without
 * failing the identity test in ``__tests__/journalMarkdown.test.ts``. See
 * ``codePoints.ts`` for the right-inverse / snap-forward law relating them.
 */
export { codePointToUtf16 as sourceToUtf16, utf16ToCodePoint as utf16ToSource } from './codePoints';

export { BULLET_MARKERS, JOURNAL_TAB_COLUMNS, classifyLine } from './journalMarkdownLines';
export {
  revealedDelimiters,
  sourceToVisible,
  spanAt,
  visibleToSource,
} from './journalMarkdownCaret';

export type { JournalMarkdownSpan, SourceSelection } from './journalMarkdownCaret';
export type {
  CharacterFormat,
  JournalMarkdownBlock,
  JournalMarkdownDocument,
  JournalMarkdownLine,
  JournalMarkdownRun,
  LineKind,
  MarkerFollowedBy,
  SourceLine,
} from './journalMarkdownTypes';

/** Parse a journal body for read-mode presentation, retaining raw source offsets. */
export function parseJournalMarkdown(body: string): JournalMarkdownDocument {
  const chars = Array.from(body);
  const formats = chars.map(() => ({
    visible: true,
    bold: false,
    italic: false,
    underline: false,
  }));
  const blocks = buildBlocks(chars);
  hideBlockPrefixes(formats, blocks);
  applyInlineFormatting(chars, formats, blocks);
  return { chars, formats, blocks, indentWidths: bulletIndentWidths(blocks) };
}

/**
 * The exact body this document came from.
 *
 * Reads ONLY ``chars`` -- the single stored representation of the source. The
 * blocks and formats are derived views for presentation; re-emitting from them
 * would let a rendering decision rewrite a writer's text, and would silently
 * break the code-point anchors that address the stored body.
 */
export function serializeJournalMarkdown(document: JournalMarkdownDocument): string {
  return document.chars.join('');
}

function sameStyle(a: CharacterFormat, b: CharacterFormat): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;
}

/** Group one source interval into runs of equal presentation. */
function buildRuns(
  document: JournalMarkdownDocument,
  start: number,
  end: number,
  includeHidden: boolean,
): JournalMarkdownRun[] {
  const runs: JournalMarkdownRun[] = [];
  let index = start;
  while (index < end) {
    const format = document.formats[index];
    if (format == null || (!includeHidden && !format.visible)) {
      index += 1;
      continue;
    }
    const runStart = index;
    const text: string[] = [];
    while (index < end && continuesRun(document, index, format)) {
      text.push(document.chars[index]!);
      index += 1;
    }
    runs.push({
      start: runStart,
      end: index,
      text: text.join(''),
      visible: format.visible,
      bold: format.bold,
      italic: format.italic,
      underline: format.underline,
    });
  }
  return runs;
}

function continuesRun(
  document: JournalMarkdownDocument,
  index: number,
  format: CharacterFormat,
): boolean {
  const candidate = document.formats[index];
  return candidate != null && candidate.visible === format.visible && sameStyle(candidate, format);
}

/** Visible, equally styled runs inside one raw-source interval. */
export function markdownRuns(
  document: JournalMarkdownDocument,
  start: number,
  end: number,
): JournalMarkdownRun[] {
  return buildRuns(document, start, end, false);
}

/**
 * EVERY position in one raw-source interval, hidden characters included and
 * flagged ``visible: false``.
 *
 * A styled overlay drawn behind a real ``<textarea>`` has to lay out the same
 * characters the textarea does, delimiters and all, or its geometry drifts from
 * the caret. ``markdownRuns`` drops hidden characters because read mode has no
 * caret to keep in step; this keeps them, transparent but present.
 */
export function sourceRuns(
  document: JournalMarkdownDocument,
  start: number,
  end: number,
): JournalMarkdownRun[] {
  return buildRuns(document, start, end, true);
}
