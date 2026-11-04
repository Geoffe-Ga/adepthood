/**
 * Keep a passage highlighted on the rendered page clear of the floating pill,
 * on the web (#3661).
 *
 * The pill floats where #3134 puts it -- its lift above the foot of the scroll
 * viewport -- so a reader who highlights a line near the bottom of the screen
 * would find the pill over the very words they chose. Once they let go (or a
 * passage is chosen with no pointer at all: the keyboard, a script), the
 * nearest scroller rises just far enough for the passage to sit a breath above
 * the pill, smoothly unless the reader asked for reduced motion. Never further
 * than keeps the passage's own top in view; never while a drag is still under
 * way, so the page is not moved under the reader's hand.
 *
 * Every surface keeps a band the height of the pill's lift under its last row
 * of controls (``RenderedSelectionPill``), so even a text's last line has room
 * to rise.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';

import type { AnchorSpan } from './anchorSpan';
import { RESONANCE_BUTTON_CLEARANCE } from './JournalEntry.styles';
import { currentRange, isElement } from './useRenderedSelection';

import { SPACING, touchTarget } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** The breath left between a lifted passage and the top of the pill. */
const LIFT_BREATH = SPACING.sm;

/** The vertical extent of a box on screen. */
interface Band {
  top: number;
  bottom: number;
}

/**
 * How far to scroll so a ``passage`` the pill covers clears it: the pill rides
 * its lift above ``dock`` (the zero-height strip it is positioned from). Zero
 * when the pill covers none of it, and never so far that the passage's top
 * leaves ``viewport``.
 */
export function liftNeeded(passage: Band, dock: Band, viewport: Band): number {
  const pillBottom = dock.top - RESONANCE_BUTTON_CLEARANCE;
  const pillTop = pillBottom - touchTarget.minimum;
  if (passage.top >= pillBottom) return 0;
  const overlap = passage.bottom + LIFT_BREATH - pillTop;
  const room = passage.top - viewport.top;
  return Math.max(0, Math.min(overlap, room));
}

/** The nearest ancestor of ``node`` that scrolls vertically, or null. */
function scrollerOf(node: Element, view: Window): Element | null {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = view.getComputedStyle(parent);
    const scrolls = overflowY === 'auto' || overflowY === 'scroll';
    if (scrolls && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** Scroll the document's selection clear of the pill riding ``dock``, if it covers it. */
function liftSelectionClear(doc: Document, dock: unknown, reducedMotion: boolean): void {
  const range = currentRange(doc);
  const view = doc.defaultView;
  if (range === null || view === null || !isElement(dock)) return;
  const scroller = scrollerOf(dock, view);
  if (scroller === null) return;
  const by = liftNeeded(
    range.getBoundingClientRect(),
    dock.getBoundingClientRect(),
    scroller.getBoundingClientRect(),
  );
  if (by > 0) scroller.scrollBy({ top: by, behavior: reducedMotion ? 'auto' : 'smooth' });
}

/**
 * While a ``passage`` is chosen, lift it clear of the pill riding ``dockRef``
 * each time the selection settles: when the pointer is let go, a key is
 * released, or a new passage arrives with no pointer down. No-op off the web.
 */
export function useLiftClearOfPill(dockRef: RefObject<unknown>, passage: AnchorSpan | null): void {
  const reducedMotion = useReducedMotion();
  const pointerDown = useRef(false);
  const chosenRef = useRef(passage !== null);
  chosenRef.current = passage !== null;
  const start = passage?.start ?? null;
  const end = passage?.end ?? null;

  useEffect(() => {
    if (typeof document === 'undefined' || Platform.OS !== 'web') return undefined;
    const doc = document;
    const lift = (): void => {
      if (chosenRef.current) liftSelectionClear(doc, dockRef.current, reducedMotion);
    };
    const press = (): void => {
      pointerDown.current = true;
    };
    const release = (): void => {
      pointerDown.current = false;
      lift();
    };
    doc.addEventListener('pointerdown', press, true);
    doc.addEventListener('pointerup', release, true);
    doc.addEventListener('keyup', lift, true);
    return () => {
      doc.removeEventListener('pointerdown', press, true);
      doc.removeEventListener('pointerup', release, true);
      doc.removeEventListener('keyup', lift, true);
    };
  }, [dockRef, reducedMotion]);

  // Keyed on the passage, not on whether there is one: a second passage chosen
  // while the pill is already up is lifted too.
  useEffect(() => {
    if (start === null || end === null || pointerDown.current) return;
    if (typeof document === 'undefined' || Platform.OS !== 'web') return;
    liftSelectionClear(document, dockRef.current, reducedMotion);
  }, [start, end, dockRef, reducedMotion]);
}
