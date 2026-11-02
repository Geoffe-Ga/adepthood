/**
 * Read a web field's content height straight off its host ``<textarea>``.
 *
 * react-native-web 0.21 measures a multiline TextInput only in its mount ref
 * callback and in its DOM ``input`` handler, so a value written from React
 * (a folded quote, a loaded entry, an appended transcript) is never measured
 * and the field keeps its old height (#3001). A growing field re-reads the
 * height here after such a write.
 *
 * Native needs none of this -- its ``onContentSizeChange`` follows every
 * value -- so off web nothing is read. A hidden or detached textarea reports
 * a ``scrollHeight`` of 0; that is no measurement, and must never collapse a
 * grown field.
 */
import { Platform } from 'react-native';

interface MeasurableHostNode {
  scrollHeight: number;
}

/** A ``scrollHeight`` that is a real, positive content height (NaN fails ``> 0``). */
function isMeasurableHeight(height: unknown): height is number {
  return typeof height === 'number' && height > 0 && height < Number.POSITIVE_INFINITY;
}

/** The web field's content height, or ``undefined`` off web or when it cannot be measured. */
export function readWebContentHeight(node: unknown): number | undefined {
  if (Platform.OS !== 'web' || node == null || typeof node !== 'object') return undefined;
  // Read once: the getter on a live textarea forces layout.
  const { scrollHeight } = node as Partial<MeasurableHostNode>;
  return isMeasurableHeight(scrollHeight) ? scrollHeight : undefined;
}

/** The parts of a host textarea a natural-height measurement reads. */
interface TwinnableHostNode extends MeasurableHostNode {
  value: string;
  ownerDocument: {
    body: { appendChild: (child: unknown) => unknown };
    defaultView: { getComputedStyle: (node: unknown) => { width: string } } | null;
  };
  cloneNode: (deep: boolean) => TwinNode;
}

/** The detached copy a natural height is read from. */
interface TwinNode extends MeasurableHostNode {
  value: string;
  style: Record<string, string>;
  removeAttribute: (name: string) => void;
  setAttribute: (name: string, value: string) => void;
  remove: () => void;
}

/** What makes a copy measure only its text: out of flow, unseen, no floor or ceiling. */
const TWIN_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  visibility: 'hidden',
  left: '0px',
  top: '0px',
  height: '0px',
  minHeight: '0px',
  maxHeight: 'none',
  overflow: 'hidden',
};

/** True when ``node`` has what ``readWebNaturalHeight`` needs from a textarea. */
function isTwinnable(node: object): node is TwinnableHostNode {
  const candidate = node as Partial<TwinnableHostNode>;
  return (
    typeof candidate.cloneNode === 'function' &&
    typeof candidate.value === 'string' &&
    candidate.ownerDocument != null
  );
}

/**
 * The web field's NATURAL content height at its current width, or ``undefined``
 * off web or when it cannot be measured.
 *
 * ``readWebContentHeight`` is grow-only: a textarea's ``scrollHeight`` under an
 * explicit height never reports less than that height. When the field's WIDTH
 * changes (a narrowed or widened window, a page that reflows) its lines rewrap,
 * and the height has to follow both ways (#3325). An unseen, out-of-flow copy
 * of the field at the same computed width and zero height reports exactly its
 * text's height, without collapsing the live field (which would clamp the
 * page's scroll position under the writer).
 */
export function readWebNaturalHeight(node: unknown): number | undefined {
  return readTwinHeight(node, (value) => value);
}

/**
 * The height an unseen copy of a rendered web field reports holding
 * ``textOf(field.value)`` at the field's own width, or ``undefined`` off web,
 * for an unrendered field, or when the copy cannot be measured.
 */
function readTwinHeight(node: unknown, textOf: (_value: string) => string): number | undefined {
  // Unrendered (hidden or detached) has no width to wrap at: no measurement.
  if (readWebContentHeight(node) === undefined || !isTwinnable(node as object)) return undefined;
  const field = node as TwinnableHostNode;
  const view = field.ownerDocument.defaultView;
  if (view == null) return undefined;
  const twin = field.cloneNode(false);
  twin.removeAttribute('id');
  twin.removeAttribute('data-testid');
  twin.setAttribute('aria-hidden', 'true');
  twin.setAttribute('tabindex', '-1');
  Object.assign(twin.style, TWIN_STYLE, { width: view.getComputedStyle(field).width });
  twin.value = textOf(field.value);
  field.ownerDocument.body.appendChild(twin);
  const { scrollHeight } = twin;
  twin.remove();
  return isMeasurableHeight(scrollHeight) ? scrollHeight : undefined;
}

/** The out-of-flow, unseen marker a caret reveal scrolls into view. */
interface MarkerNode {
  style: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  scrollIntoView: (options: { block: 'center' }) => void;
  remove: () => void;
}

/** The parts of a host textarea a caret reveal reads beyond a measurement's. */
interface RevealableHostNode extends TwinnableHostNode {
  offsetTop: number;
  offsetLeft: number;
  offsetParent: { appendChild: (child: MarkerNode) => unknown } | null;
  ownerDocument: TwinnableHostNode['ownerDocument'] & { createElement: (tag: 'div') => MarkerNode };
}

/** True when ``node`` is a field a marker can be placed beside. */
function isRevealable(node: unknown): node is RevealableHostNode {
  const candidate = node as Partial<RevealableHostNode> | null;
  return (
    typeof candidate?.offsetTop === 'number' &&
    candidate.offsetParent != null &&
    typeof candidate.ownerDocument?.createElement === 'function'
  );
}

/** A point-sized, unseen marker, positioned by the caller. */
const MARKER_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  visibility: 'hidden',
  pointerEvents: 'none',
};

/**
 * Bring the caret at UTF-16 ``at`` of a grown web field into the middle of the
 * view (#3659). Off web, for a caret at the top (where the field opens), or
 * for a field that cannot be measured, nothing scrolls.
 *
 * A grown field never scrolls inside, so a selection set from code -- a Course
 * quote's passage preselected screens down a chapter -- is drawn but out of
 * sight, and the browser does not bring it in. Its depth is read off an unseen
 * copy holding only the text before it; a marker at that depth, placed in the
 * field's own positioned ancestor (so inside whatever scroller holds the
 * field), is scrolled to the centre, and every scroller on the way follows.
 */
export function revealWebCaret(node: unknown, at: number): void {
  if (at <= 0 || !isRevealable(node)) return;
  const depth = readTwinHeight(node, (value) => value.slice(0, at));
  const host = node.offsetParent;
  if (depth === undefined || host == null) return;
  const marker = node.ownerDocument.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  Object.assign(marker.style, MARKER_STYLE, {
    top: `${String(node.offsetTop + depth)}px`,
    left: `${String(node.offsetLeft)}px`,
  });
  host.appendChild(marker);
  marker.scrollIntoView({ block: 'center' });
  marker.remove();
}

/** The page's font set, where the browser exposes one. */
interface FontFaceEvents {
  addEventListener: (type: 'loadingdone', listener: () => void) => void;
  removeEventListener: (type: 'loadingdone', listener: () => void) => void;
}

/**
 * Call ``onSettled`` whenever the web page finishes loading a font face, so a
 * field measured in a fallback face is re-measured in the face it is drawn in
 * (#3325). Returns the unsubscribe; off web it subscribes to nothing.
 */
export function onWebFontsSettled(onSettled: () => void): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => undefined;
  const fonts = (document as unknown as { fonts?: FontFaceEvents }).fonts;
  if (fonts == null) return () => undefined;
  fonts.addEventListener('loadingdone', onSettled);
  return () => fonts.removeEventListener('loadingdone', onSettled);
}
