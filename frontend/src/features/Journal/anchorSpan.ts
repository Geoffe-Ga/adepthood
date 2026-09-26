/**
 * The one boundary where a reader's selection becomes the anchor span a promote
 * posts: native UTF-16 selection in, Unicode code-point offsets out, with the
 * span's edge whitespace trimmed away.
 *
 * Why trim here: the server stores the posted offsets verbatim but snapshots
 * ``anchor_text = sanitize_user_text(body[start:end])``, and sanitize strips the
 * snapshot's leading and trailing whitespace. A web double-click that selects
 * "word " would therefore store a 5-code-point span whose text is "word", and
 * " word" one whose start is a space. The re-anchor rule (``reanchor_one``)
 * follows an edit only while ``body[start:start + len(text)]`` spells the text;
 * when it does not and the passage repeats, it cannot prove which copy was
 * meant, so the first edit marks the quote stale (#2945). Trimming on the
 * client keeps ``anchor_end - anchor_start == len(anchor_text)``.
 *
 * The trim set mirrors Python's ``str.isspace`` exactly, not JavaScript's
 * ``\s``: the two disagree on U+0085, U+001C-U+001F (Python only) and U+FEFF
 * (JavaScript only), and any disagreement reintroduces the mismatch.
 */
import { utf16ToSource } from './journalMarkdown';

/** A selection in UTF-16 code units, as a ``TextInput`` reports it. */
export interface Utf16Selection {
  start: number;
  end: number;
}

/** An end-exclusive anchor span in Unicode code points (the anchor API's unit). */
export interface AnchorSpan {
  start: number;
  end: number;
}

/** Every code point Python's ``str.isspace`` accepts (CPython, Unicode 15). */
export const ANCHOR_EDGE_WHITESPACE: ReadonlySet<string> = new Set([
  '\t',
  '\n',
  '\u000B',
  '\u000C',
  '\r',
  '\u001C',
  '\u001D',
  '\u001E',
  '\u001F',
  ' ',
  '\u0085',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  '　',
]);

function isEdgeWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && ANCHOR_EDGE_WHITESPACE.has(ch);
}

/**
 * ``text`` with its edge whitespace removed, by exactly the rule the server
 * applies to an ``anchor_text`` snapshot.
 */
export function trimAnchorEdges(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && isEdgeWhitespace(chars[start])) start += 1;
  while (end > start && isEdgeWhitespace(chars[end - 1])) end -= 1;
  return chars.slice(start, end).join('');
}

/**
 * Convert a UTF-16 selection over ``body`` into the code-point span to post,
 * with edge whitespace trimmed. A whitespace-only selection collapses to an
 * empty span at its trimmed start, which the surface treats as "nothing chosen".
 */
export function selectionToAnchorSpan(body: string, selection: Utf16Selection): AnchorSpan {
  const chars = Array.from(body);
  let start = utf16ToSource(body, Math.min(selection.start, selection.end));
  let end = utf16ToSource(body, Math.max(selection.start, selection.end));
  while (start < end && isEdgeWhitespace(chars[start])) start += 1;
  while (end > start && isEdgeWhitespace(chars[end - 1])) end -= 1;
  return { start, end };
}
