/**
 * ``chapterProjection`` -- where a Course chapter's rendered words come from in
 * its Markdown, so a passage highlighted on the rendered chapter can be
 * promoted (#3661). Pure: no React, no DOM.
 *
 * A chapter renders through ``react-native-markdown-display``, which keeps no
 * source offsets, so a selection over it cannot be mapped back the exact way a
 * journal page's can. Instead the shown Markdown is projected to what a reader
 * sees -- heading, quote and list prefixes dropped, a link reduced to its text,
 * an image to nothing -- every projected character remembering the source
 * range it came from, and the highlighted words are found in that projection.
 *
 * Both sides are compared in one folded alphabet, because the rendered text is
 * not the source verbatim: markdown-it's typographer curls quotes and turns
 * ``--``, ``---`` and ``...`` into dashes and an ellipsis, the list renderer
 * draws bullets of its own, and whitespace (soft breaks, the gap between
 * paragraphs) never lines up. So whitespace and markup punctuation are dropped,
 * quotes straightened and dashes and ellipses spelled out, on the page and in
 * the projection alike.
 *
 * A passage is exact when the page and the projection hold it the same number
 * of times: repeats are told apart by how many occurrences come before it on
 * the page. Anything else -- a selection across an ordered list's numbers, a
 * table, markup the projection does not follow -- is a best guess, which the
 * reader confirms in the selection field rather than having promoted blind.
 */
import type { AnchorSpan } from '../Journal/anchorSpan';
import type { RenderedSelection } from '../Journal/renderedSelection';

/**
 * One UTF-16 unit of the projection, and the source range (code points) of the
 * character it was drawn from. Units, not characters, so that an index into
 * ``ink`` -- a string, searched in UTF-16 -- is an index into ``chars``: an
 * astral character spends two entries, both naming the same source range.
 */
interface ProjectedChar {
  ch: string;
  start: number;
  end: number;
}

/** A chapter's Markdown as a reader sees it, in the folded alphabet. */
export interface ChapterProjection {
  /** The folded visible text: ``chars`` joined, one UTF-16 unit per entry. */
  ink: string;
  chars: ProjectedChar[];
}

/** A highlighted passage of a chapter: exact, or the nearest guess the field confirms. */
export interface ChapterPassage extends AnchorSpan {
  exact: boolean;
}

/** Characters dropped on both sides: whitespace, emphasis/code/strike markers, a table's pipes, drawn bullets. */
const DROPPED = /[\s*_`~|\\•·]/u;

/**
 * A hyphen. markdown-it's typographer turns two of them into an en dash and
 * three into an em dash, so that is how the folded alphabet spells each dash
 * (counts of this hyphen, not prose).
 */
const HYPHEN = '-';
const EN_DASH_HYPHENS = 2;
const EM_DASH_HYPHENS = 3;

/** Typography the renderer introduces, spelled the way the source types it. */
const SPELLED: Readonly<Record<string, string>> = Object.freeze({
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2013': HYPHEN.repeat(EN_DASH_HYPHENS),
  '\u2014': HYPHEN.repeat(EM_DASH_HYPHENS),
  '\u2026': '...',
});

/**
 * A line's leading block markup: any nesting of ``>`` quotes, then a heading's
 * ``#``s, or a bullet (with a task box) or an ordered item's number.
 */
const BLOCK_PREFIX = /^(?:\s*>\s?)*\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)?/u;

/** Lines that draw no text: a rule or setext underline, a code fence, a table's divider row. */
const SILENT_LINE = /^\s*(?:(?:[-*_=]\s*){3,}|```.*|~~~.*|\|?[\s:|-]*-[\s:|-]*)$/u;

/** A shortest guess worth offering: fewer folded characters than this, and nothing is pre-chosen. */
const MIN_GUESS = 6;

/** ``ch`` in the folded alphabet: nothing, itself, or its source spelling. */
function fold(ch: string): string {
  if (DROPPED.test(ch)) return '';
  return SPELLED[ch] ?? ch;
}

/** ``text`` folded. */
export function foldRendered(text: string): string {
  return Array.from(text).map(fold).join('');
}

/** Where the bracket at ``open`` closes on this line, nesting counted; -1 if it does not. */
function closing(chars: string[], open: number, end: number, pair: '[]' | '()'): number {
  let depth = 0;
  for (let i = open; i < end; i += 1) {
    if (chars[i] === pair[0]) depth += 1;
    else if (chars[i] === pair[1]) depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

/** A ``[text](target)`` at ``i``: the text's range and where the link ends; null if none. */
function linkAt(
  chars: string[],
  i: number,
  end: number,
): { text: [number, number]; to: number } | null {
  if (chars[i] !== '[') return null;
  const label = closing(chars, i, end, '[]');
  if (label < 0 || chars[label + 1] !== '(') return null;
  const target = closing(chars, label + 1, end, '()');
  return target < 0 ? null : { text: [i + 1, label], to: target + 1 };
}

/** Emit the character at ``i``, folded, one entry per UTF-16 unit. */
function emitChar(chars: string[], i: number, out: ProjectedChar[]): void {
  const folded = fold(chars[i] ?? '');
  for (let unit = 0; unit < folded.length; unit += 1) {
    out.push({ ch: folded.charAt(unit), start: i, end: i + 1 });
  }
}

/** Project what starts at ``i`` -- an image, a link, or one character -- and say where it ends. */
function projectNext(chars: string[], i: number, to: number, out: ProjectedChar[]): number {
  const image = chars[i] === '!' ? linkAt(chars, i + 1, to) : null;
  if (image !== null) return image.to;
  const link = linkAt(chars, i, to);
  if (link === null) {
    emitChar(chars, i, out);
    return i + 1;
  }
  projectInline(chars, link.text[0], link.text[1], out);
  return link.to;
}

/** Project ``chars[from, to)`` as inline text: links to their text, images to nothing. */
function projectInline(chars: string[], from: number, to: number, out: ProjectedChar[]): void {
  for (let i = from; i < to;) i = projectNext(chars, i, to, out);
}

/** Project one source line ``chars[start, end)``. */
function projectLine(chars: string[], start: number, end: number, out: ProjectedChar[]): void {
  const line = chars.slice(start, end).join('');
  if (SILENT_LINE.test(line)) return;
  const prefix = Array.from(BLOCK_PREFIX.exec(line)?.[0] ?? '').length;
  projectInline(chars, start + prefix, end, out);
}

/** What a reader sees of ``markdown``, each character tied to its source range (code points). */
export function projectChapter(markdown: string): ChapterProjection {
  const chars = Array.from(markdown);
  const out: ProjectedChar[] = [];
  let start = 0;
  while (start <= chars.length) {
    const feed = chars.indexOf('\n', start);
    const end = feed < 0 ? chars.length : feed;
    projectLine(chars, start, end, out);
    start = end + 1;
  }
  return { ink: out.map((c) => c.ch).join(''), chars: out };
}

/** Every index ``needle`` occurs at in ``haystack``, overlaps included. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/** The source span of projected characters ``[from, to)``. */
function spanOf(
  projection: ChapterProjection,
  from: number,
  to: number,
  exact: boolean,
): ChapterPassage {
  const first = projection.chars[from];
  const last = projection.chars[to - 1];
  if (first === undefined || last === undefined) return { start: 0, end: 0, exact: false };
  return { start: first.start, end: last.end, exact };
}

/** The longest leading part of ``ink`` (at least ``MIN_GUESS`` long) found at or after ``from``. */
function longestHead(
  haystack: string,
  ink: string,
  from: number,
): { at: number; length: number } | null {
  for (let length = ink.length; length >= MIN_GUESS; length -= 1) {
    const at = haystack.indexOf(ink.slice(0, length), from);
    if (at >= 0) return { at, length };
  }
  return null;
}

/** The longest trailing part of ``ink`` (at least ``MIN_GUESS`` long) found at or after ``from``. */
function longestTail(
  haystack: string,
  ink: string,
  from: number,
): { at: number; length: number } | null {
  for (let length = ink.length; length >= MIN_GUESS; length -= 1) {
    const at = haystack.indexOf(ink.slice(ink.length - length), from);
    if (at >= 0) return { at, length };
  }
  return null;
}

/**
 * The nearest the projection comes to a passage it cannot place exactly: the
 * ``nth`` occurrence when it occurs at all, else its longest head found and, if
 * one follows, its longest tail. Nothing chosen when not even that is found.
 */
function bestGuess(projection: ChapterProjection, ink: string, nth: number): ChapterPassage {
  const hits = occurrences(projection.ink, ink);
  const hit = hits[Math.min(nth, hits.length - 1)];
  if (hit !== undefined) return spanOf(projection, hit, hit + ink.length, false);
  const head = longestHead(projection.ink, ink, 0);
  if (head === null) return { start: 0, end: 0, exact: false };
  const tail = longestTail(projection.ink, ink, head.at + head.length);
  const to = tail === null ? head.at + head.length : tail.at + tail.length;
  return spanOf(projection, head.at, to, false);
}

/** The rendered text before, inside and after the selection. */
function splitRendered(selection: RenderedSelection): [string, string, string] {
  const flat = selection.pieces.map((piece) => piece.text);
  const offset = (piece: number, at: number): number => flat.slice(0, piece).join('').length + at;
  const all = flat.join('');
  const start = offset(selection.start.piece, selection.start.offset);
  const end = offset(selection.end.piece, selection.end.offset);
  return [all.slice(0, start), all.slice(start, end), all.slice(end)];
}

/**
 * The passage of the chapter a selection over its rendered text covers, in
 * code points into the shown Markdown: exact when the page and the projection
 * agree on where it is, else the nearest guess. Null for a selection with no
 * visible characters.
 */
export function chapterPassage(
  projection: ChapterProjection,
  selection: RenderedSelection,
): ChapterPassage | null {
  const [before, chosen, after] = splitRendered(selection);
  const ink = foldRendered(chosen);
  if (ink === '') return null;
  const lead = foldRendered(before);
  const page = occurrences(lead + ink + foldRendered(after), ink);
  const nth = page.filter((at) => at < lead.length).length;
  const hits = occurrences(projection.ink, ink);
  const hit = hits[nth];
  if (hits.length === page.length && hit !== undefined) {
    return spanOf(projection, hit, hit + ink.length, true);
  }
  return bestGuess(projection, ink, nth);
}
