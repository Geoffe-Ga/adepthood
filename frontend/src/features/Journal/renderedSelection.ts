/**
 * ``renderedSelection`` -- a reader's selection over RENDERED text, mapped back
 * to the source it was drawn from (#3661).
 *
 * On the web a reader can drag across a journal page in read mode or a
 * Resonance Letter as they read it, with no selection field in between. The
 * browser reports that selection as two DOM boundaries. This module flattens
 * the container's text into ordered pieces -- each tagged with the source
 * position its run was drawn from, where the renderer recorded one -- locates
 * both boundaries among them, and maps them back to the code-point span a
 * promote posts, edges trimmed as the server trims its snapshot.
 *
 * Two renderers, two exact mappers:
 *
 * - Journal read mode (``HighlightedBody``) hides Markdown markers and draws
 *   decoration that is not in the source (a bullet glyph, a task box, the line
 *   feed between lines). Every visible run is wrapped in a host carrying
 *   ``data-src-start`` (react-native-web's spelling of ``dataSet={{ srcStart }}``),
 *   so a boundary inside a run is exact, and one on decoration snaps to the
 *   nearest run in the direction the selection extends.
 * - A letter is one plain ``<Text>``: the rendered string IS the essay, so a
 *   boundary's UTF-16 offset into it converts with ``selectionToAnchorSpan``.
 *
 * Pure: it reads only the few node members below, so it is tested without a
 * DOM. ``useRenderedSelection`` hands it the live document's nodes.
 */
import { selectionToAnchorSpan, trimSpanEdges, type AnchorSpan } from './anchorSpan';
import { utf16ToCodePoint } from './codePoints';

/** The attribute a run's ``dataSet={{ srcStart }}`` becomes under react-native-web. */
export const SOURCE_START_ATTRIBUTE = 'data-src-start';

/** ``Node.TEXT_NODE``, spelled out so this module needs no DOM global. */
const TEXT_NODE = 3;

/** The members of a DOM node the flattening reads. A live ``Node`` satisfies it. */
export interface DomNodeLike {
  nodeType: number;
  /** A text node's characters; null on an element. */
  nodeValue: string | null;
  childNodes: ArrayLike<DomNodeLike>;
  /** Present on an element. */
  getAttribute?: (_name: string) => string | null;
}

/** The two boundaries of a selection, as a DOM ``Range`` reports them. */
export interface DomRangeLike {
  startContainer: DomNodeLike;
  startOffset: number;
  endContainer: DomNodeLike;
  endOffset: number;
}

/** One rendered text node, and the source position of its first character when one is known. */
export interface RenderedText {
  text: string;
  srcStart: number | null;
}

/** A place in the rendered text: a piece, and a UTF-16 offset into it. */
export interface RenderedPoint {
  piece: number;
  offset: number;
}

/** A selection over a container's rendered text, flattened. */
export interface RenderedSelection {
  pieces: RenderedText[];
  start: RenderedPoint;
  end: RenderedPoint;
}

/** A run's host: its source start, and how many code points earlier text nodes in it drew. */
interface SourceHost {
  start: number;
  drawn: number;
}

/** The flattening in progress: the pieces so far and either boundary once it is met. */
interface Walk {
  range: DomRangeLike;
  pieces: RenderedText[];
  start: RenderedPoint | null;
  end: RenderedPoint | null;
}

/** The host ``node`` opens, or the one it sits inside. */
function hostOf(node: DomNodeLike, inherited: SourceHost | null): SourceHost | null {
  const raw = node.getAttribute?.(SOURCE_START_ATTRIBUTE);
  if (raw == null) return inherited;
  const start = Number(raw);
  return Number.isInteger(start) ? { start, drawn: 0 } : inherited;
}

function visitText(node: DomNodeLike, host: SourceHost | null, walk: Walk): void {
  const text = node.nodeValue ?? '';
  const piece = walk.pieces.length;
  if (walk.range.startContainer === node) walk.start = { piece, offset: walk.range.startOffset };
  if (walk.range.endContainer === node) walk.end = { piece, offset: walk.range.endOffset };
  walk.pieces.push({ text, srcStart: host === null ? null : host.start + host.drawn });
  if (host !== null) host.drawn += Array.from(text).length;
}

/** A boundary between an element's children sits just before the text that follows it. */
function markChildBoundary(node: DomNodeLike, index: number, walk: Walk): void {
  const point = { piece: walk.pieces.length, offset: 0 };
  const { range } = walk;
  if (range.startContainer === node && range.startOffset === index) walk.start = point;
  if (range.endContainer === node && range.endOffset === index) walk.end = point;
}

function visit(node: DomNodeLike, inherited: SourceHost | null, walk: Walk): void {
  if (node.nodeType === TEXT_NODE) {
    visitText(node, inherited, walk);
    return;
  }
  const host = hostOf(node, inherited);
  const { childNodes } = node;
  for (let index = 0; index <= childNodes.length; index += 1) {
    markChildBoundary(node, index, walk);
    const child = childNodes[index];
    if (child !== undefined) visit(child, host, walk);
  }
}

/** A point past the last piece (a boundary after all the text) is the end of the last piece. */
function clampPoint(point: RenderedPoint, pieces: RenderedText[]): RenderedPoint | null {
  if (point.piece < pieces.length) return point;
  const last = pieces.at(-1);
  return last === undefined ? null : { piece: pieces.length - 1, offset: last.text.length };
}

/**
 * Flatten ``container``'s text and locate ``range`` in it, or null when either
 * end of the range lies outside the container (or there is no text at all).
 */
export function readRenderedSelection(
  container: DomNodeLike,
  range: DomRangeLike,
): RenderedSelection | null {
  const walk: Walk = { range, pieces: [], start: null, end: null };
  visit(container, null, walk);
  if (walk.start === null || walk.end === null) return null;
  const start = clampPoint(walk.start, walk.pieces);
  const end = clampPoint(walk.end, walk.pieces);
  if (start === null || end === null) return null;
  return { pieces: walk.pieces, start, end };
}

/** The span, or null when it holds no characters. */
function nonEmpty(span: AnchorSpan): AnchorSpan | null {
  return span.end > span.start ? span : null;
}

/** Where a selection starting at ``point`` begins in the source: the next drawn source character. */
function sourceFrom(pieces: RenderedText[], point: RenderedPoint): number | null {
  for (let index = point.piece; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const offset = index === point.piece ? point.offset : 0;
    if (piece?.srcStart != null && offset < piece.text.length) {
      return piece.srcStart + utf16ToCodePoint(piece.text, offset);
    }
  }
  return null;
}

/** Where a selection ending at ``point`` ends in the source: just past the last drawn source character. */
function sourceTo(pieces: RenderedText[], point: RenderedPoint): number | null {
  for (let index = point.piece; index >= 0; index -= 1) {
    const piece = pieces[index];
    const offset = index === point.piece ? point.offset : (piece?.text.length ?? 0);
    if (piece?.srcStart != null && offset > 0) {
      return piece.srcStart + utf16ToCodePoint(piece.text, offset);
    }
  }
  return null;
}

/**
 * The code-point span of journal ``body`` a read-mode selection covers, edges
 * trimmed; null when it covers no source character.
 */
export function journalSourceSpan(body: string, selection: RenderedSelection): AnchorSpan | null {
  const start = sourceFrom(selection.pieces, selection.start);
  const end = sourceTo(selection.pieces, selection.end);
  if (start === null || end === null) return null;
  return nonEmpty(trimSpanEdges(body, { start, end }));
}

/** ``point`` as a UTF-16 offset into all the pieces joined. */
function flatOffset(pieces: RenderedText[], point: RenderedPoint): number {
  return (
    pieces.slice(0, point.piece).reduce((sum, piece) => sum + piece.text.length, 0) + point.offset
  );
}

/**
 * The code-point span of a letter's ``essay`` a selection covers, edges
 * trimmed; null when it is empty, or when what is rendered is not the letter.
 */
export function letterSourceSpan(essay: string, selection: RenderedSelection): AnchorSpan | null {
  const { pieces } = selection;
  if (pieces.map((piece) => piece.text).join('') !== essay) return null;
  return nonEmpty(
    selectionToAnchorSpan(essay, {
      start: flatOffset(pieces, selection.start),
      end: flatOffset(pieces, selection.end),
    }),
  );
}
