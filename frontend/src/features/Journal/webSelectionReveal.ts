/**
 * Bring a place in a web selection field into view (#3660).
 *
 * The quote-selection field grows to its text and never scrolls inside, so a
 * passage chosen before the surface opened -- a Course quote's Open, landing
 * on a chapter screens long -- is selected but out of sight until the page
 * scrolls to it, and the browser will not do that for a selection it did not
 * make. A textarea cannot say where a character sits, so a hidden copy of the
 * field's text is laid over the field in its own type and width, with a marker
 * at the offset; the marker is scrolled to the middle of whatever scrolls the
 * field, and the copy is removed in the same task, before anything paints.
 *
 * Native needs none of this: there the surface's own field is the reader's
 * scroll, and nothing here runs off the web.
 */
import { Platform } from 'react-native';

/** The computed type and box a copy of the field must share to wrap where it wraps. */
const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textIndent',
  'textTransform',
  'wordSpacing',
  'tabSize',
  'direction',
] as const;

/** Unseen, out of the reader's way, and wrapping exactly as a textarea wraps. */
const MIRROR_STYLE: Readonly<Record<string, string>> = {
  position: 'absolute',
  visibility: 'hidden',
  pointerEvents: 'none',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  height: 'auto',
};

/** A zero-width character: something to measure that takes no room. */
const MARKER_TEXT = '​';

interface MirrorElement {
  style: Record<string, string>;
  textContent: string | null;
  appendChild: (_child: MirrorElement) => unknown;
  setAttribute: (_name: string, _value: string) => void;
  remove: () => void;
  scrollIntoView?: (_options: { block: 'center'; inline: 'nearest' }) => void;
}

/** The parts of a laid-out host textarea the copy is built from. */
interface RevealableField {
  value: string;
  offsetTop: number;
  offsetLeft: number;
  offsetParent: { appendChild: (_child: MirrorElement) => unknown };
  ownerDocument: {
    createElement: (_tag: string) => MirrorElement;
    defaultView: { getComputedStyle: (_node: unknown) => Record<string, string> } | null;
  };
}

/** True when ``node`` is a host textarea that is laid out in a document. */
function isRevealable(node: unknown): node is RevealableField {
  if (node == null || typeof node !== 'object') return false;
  const field = node as Partial<RevealableField>;
  return (
    typeof field.value === 'string' &&
    typeof field.offsetTop === 'number' &&
    typeof field.offsetLeft === 'number' &&
    field.offsetParent != null &&
    field.ownerDocument != null
  );
}

/** A span of the copy holding ``text``. */
function textRun(field: RevealableField, text: string): MirrorElement {
  const run = field.ownerDocument.createElement('span');
  run.textContent = text;
  return run;
}

/**
 * Scroll the web page so the character at UTF-16 ``offset`` of the field sits
 * mid-screen. Returns whether it could (false off the web, and for a node that
 * is not a laid-out textarea).
 */
export function revealWebOffset(node: unknown, offset: number): boolean {
  if (Platform.OS !== 'web' || !isRevealable(node)) return false;
  const view = node.ownerDocument.defaultView;
  if (view == null) return false;
  const computed = view.getComputedStyle(node);
  const mirror = node.ownerDocument.createElement('div');
  const marker = node.ownerDocument.createElement('span');
  for (const property of MIRRORED_PROPERTIES) {
    const value = computed[property];
    if (typeof value === 'string' && value !== '') mirror.style[property] = value;
  }
  Object.assign(mirror.style, MIRROR_STYLE, {
    top: `${String(node.offsetTop)}px`,
    left: `${String(node.offsetLeft)}px`,
  });
  mirror.setAttribute('aria-hidden', 'true');
  marker.textContent = MARKER_TEXT;
  // The text after the offset is laid out too: the word the offset sits in
  // wraps by its whole length, so a copy cut at the offset could wrap early.
  mirror.appendChild(textRun(node, node.value.slice(0, offset)));
  mirror.appendChild(marker);
  mirror.appendChild(textRun(node, node.value.slice(offset)));
  node.offsetParent.appendChild(mirror);
  marker.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  mirror.remove();
  return true;
}
