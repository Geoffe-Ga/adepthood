/**
 * ``useRenderedSelection`` -- the reader's selection over a container's
 * rendered text, as a source span (#3661). Web only.
 *
 * A reader at a laptop drags across a sentence of a journal page in read mode
 * or of a letter, and the floating Promote pill should come to it without a
 * selection field in between. React Native exposes no selection range on a
 * ``<Text>`` (so native keeps the tap-to-select surface), but on the web the
 * document has one: this hook follows it, after ``webSelectionListener``'s
 * subscribe-and-clean-up pattern.
 *
 * It reads ``getSelection()`` on every document ``selectionchange`` and, since
 * the pill should leave with a passage the reader scrolls away from, on every
 * scroll anywhere (a capturing listener: scroll does not bubble). It emits the
 * span ``toSourceSpan`` maps the selection to only while both of the range's
 * ends lie inside the container and some of it is on screen; otherwise null.
 * A no-op off the web and wherever there is no DOM.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { Platform } from 'react-native';

import type { AnchorSpan } from './anchorSpan';
import { readRenderedSelection, type RenderedSelection } from './renderedSelection';

/** ``Node.ELEMENT_NODE``, spelled out so nothing here needs a DOM global at load. */
const ELEMENT_NODE = 1;

/** Scroll does not bubble: listen in the capture phase to hear every scroller's. */
const SCROLL_LISTENER: AddEventListenerOptions = { capture: true, passive: true };

/** True when ``value`` is a laid-out DOM element (a react-native-web host node). */
function isElement(value: unknown): value is Element {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<Element>;
  return (
    candidate.nodeType === ELEMENT_NODE && typeof candidate.getBoundingClientRect === 'function'
  );
}

/**
 * The vertical band of the window the container is drawn in: the window,
 * clipped by every ancestor that does not let its content overflow.
 */
function visibleBand(container: Element, view: Window): { top: number; bottom: number } {
  let top = 0;
  let bottom = view.innerHeight;
  for (let node = container.parentElement; node !== null; node = node.parentElement) {
    if (view.getComputedStyle(node).overflowY !== 'visible') {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return { top, bottom };
}

/** Whether any of ``range`` is on screen; with no window to measure against, it is. */
function inView(range: Range, container: Element, view: Window | null): boolean {
  if (view === null) return true;
  const rect = range.getBoundingClientRect();
  const band = visibleBand(container, view);
  return rect.bottom > band.top && rect.top < band.bottom;
}

/** The document's live range, when there is a non-empty one. */
function currentRange(doc: Document): Range | null {
  const selection = doc.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  return selection.getRangeAt(0);
}

/** The span the selection maps to now, or null when it is not a visible selection inside ``container``. */
function readSpan<T extends AnchorSpan>(
  doc: Document,
  container: unknown,
  toSourceSpan: (_selection: RenderedSelection) => T | null,
): T | null {
  const range = currentRange(doc);
  if (range === null || !isElement(container)) return null;
  const rendered = readRenderedSelection(container, range);
  if (rendered === null || !inView(range, container, doc.defaultView)) return null;
  return toSourceSpan(rendered);
}

/** Two spans the same in every field: the hook keeps the one it has rather than re-render. */
function sameSpan(a: AnchorSpan | null, b: AnchorSpan | null): boolean {
  if (a === null || b === null) return a === b;
  const fields = Object.entries(a);
  const other = b as unknown as Record<string, unknown>;
  return (
    fields.length === Object.keys(b).length && fields.every(([key, value]) => other[key] === value)
  );
}

/**
 * The span of the source the reader has selected in ``containerRef``'s
 * rendered text, or null. ``toSourceSpan`` maps the flattened selection back to
 * the source (``journalSourceSpan``, ``letterSourceSpan``); hand it a stable
 * function, since a new one re-subscribes.
 */
export function useRenderedSelection<T extends AnchorSpan>(
  containerRef: RefObject<unknown>,
  toSourceSpan: (_selection: RenderedSelection) => T | null,
): T | null {
  const [span, setSpan] = useState<T | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (Platform.OS !== 'web') return undefined;
    // Captured, as in ``webSelectionListener``: a cleanup that reached for the
    // global at teardown could find the DOM gone.
    const doc = document;
    const read = (): void => {
      const next = readSpan(doc, containerRef.current, toSourceSpan);
      setSpan((previous) => (sameSpan(previous, next) ? previous : next));
    };
    read();
    doc.addEventListener('selectionchange', read);
    doc.addEventListener('scroll', read, SCROLL_LISTENER);
    return () => {
      doc.removeEventListener('selectionchange', read);
      doc.removeEventListener('scroll', read, SCROLL_LISTENER);
    };
  }, [containerRef, toSourceSpan]);

  return span;
}

/**
 * The passage of ``source`` the reader has highlighted in ``containerRef``'s
 * rendered text, or null: ``useRenderedSelection`` with the renderer's own
 * mapper (``journalSourceSpan``, ``letterSourceSpan``), which must be a
 * module-level function so the subscription is not renewed every render.
 */
export function useHighlightedPassage(
  containerRef: RefObject<unknown>,
  source: string,
  toSourceSpan: (_source: string, _selection: RenderedSelection) => AnchorSpan | null,
): AnchorSpan | null {
  const mapSelection = useCallback(
    (selection: RenderedSelection) => toSourceSpan(source, selection),
    [toSourceSpan, source],
  );
  return useRenderedSelection(containerRef, mapSelection);
}

/** Let go of the reader's selection on the web: the pill's X, or a passage just promoted. */
export function clearRenderedSelection(): void {
  if (typeof document === 'undefined' || Platform.OS !== 'web') return;
  document.getSelection()?.removeAllRanges();
}
