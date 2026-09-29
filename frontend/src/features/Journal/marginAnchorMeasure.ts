/**
 * Where each drawn note's passage sits, in the margin stream's own coordinates.
 *
 * A highlight is a nested ``<Text>`` run inside one body ``Text``, so it has no
 * layout of its own and ``onLayout`` can never report it (see
 * ``focusSpanScroll.tsx``). On web the run is a real DOM ``<span>``: its
 * rectangle is read by exact ``data-testid`` -- the ``testID`` HighlightedBody
 * already writes -- from the margin's side, so the body needs no refs.
 *
 * Native has no DOM and no lane that verifies its geometry, so it measures
 * nothing and the margin keeps its flow layout there. Mapping ``onTextLayout``
 * lines back through ``buildAnchoredSegments`` offsets is the follow-up.
 */
import { Platform } from 'react-native';

/** The page both columns share: the highlights live under it, beside the margin. */
const PAGE_SELECTOR = '[data-testid="journal-page"]';

interface RectSource {
  getBoundingClientRect: () => { top: number };
}

interface PageNode {
  querySelector: (selector: string) => RectSource | null;
}

/** The slice of a DOM element the measurement reads -- nothing more. */
export interface AnchorMeasureRoot extends RectSource {
  closest: (selector: string) => PageNode | null;
}

/** A mounted view that is a DOM element (react-native-web), not a native host. */
function isMeasureRoot(node: unknown): node is AnchorMeasureRoot {
  return (
    typeof node === 'object' &&
    node !== null &&
    'closest' in node &&
    'getBoundingClientRect' in node
  );
}

/** The exact selector for a note's primary highlight run (never its continuation). */
function highlightSelector(noteId: number): string {
  return `[data-testid="highlight-${noteId}"]`;
}

/**
 * Measure each note's highlight top relative to the stream's top.
 *
 * @param stream - The margin stream's mounted view (a DOM element on web).
 * @param noteIds - The drawn notes to look up.
 * @returns Note id to its top; a note whose run is absent or whose top is not
 *   finite is left out, so the caller treats it as unanchored. Empty off web.
 */
export function measureAnchorTops(
  stream: unknown,
  noteIds: readonly number[],
): Map<number, number> {
  const tops = new Map<number, number>();
  if (Platform.OS !== 'web' || !isMeasureRoot(stream)) return tops;
  const page = stream.closest(PAGE_SELECTOR);
  if (page === null) return tops;
  const origin = stream.getBoundingClientRect().top;
  for (const id of noteIds) {
    const run = page.querySelector(highlightSelector(id));
    const top = run === null ? Number.NaN : run.getBoundingClientRect().top - origin;
    if (Number.isFinite(top)) tops.set(id, top);
  }
  return tops;
}
