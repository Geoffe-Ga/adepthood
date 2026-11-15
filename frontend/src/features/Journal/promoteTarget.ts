/**
 * Which source the review panel's floating "Promote a quote" acts on (#3718).
 *
 * The opener sits fixed at the foot of the Sources panel, so it has no row of
 * its own. It acts on the source the writer is reading: the expanded row that
 * covers the most of the scroll viewport. Before anything has been measured (the
 * first frame, or a test renderer that never lays out), the row expanded last
 * stands in for it.
 */

/** A row's vertical extent in the scroll content's coordinates, in dp. */
export interface RowExtent {
  top: number;
  height: number;
}

/** The scroll viewport: its offset into the content and its height, in dp. */
export interface ViewportExtent {
  top: number;
  height: number;
}

/** How much of ``row`` lies inside ``viewport``, in dp (never negative). */
function overlap(row: RowExtent, viewport: ViewportExtent): number {
  const start = Math.max(row.top, viewport.top);
  const end = Math.min(row.top + row.height, viewport.top + viewport.height);
  return Math.max(0, end - start);
}

/**
 * The key of the expanded row to promote from, or ``null`` when no expanded row
 * is in view.
 *
 * ``expanded`` is in the order the rows were expanded, oldest first. A tie goes
 * to the row expanded last, which is the one the writer most recently chose to
 * read.
 */
export function pickPromoteTarget(
  expanded: readonly string[],
  extents: ReadonlyMap<string, RowExtent>,
  viewport: ViewportExtent | null,
): string | null {
  if (expanded.length === 0) return null;
  const measured = expanded.filter((key) => extents.has(key));
  if (viewport == null || measured.length === 0) return expanded.at(-1) ?? null;
  let best: string | null = null;
  let bestOverlap = 0;
  for (const key of measured) {
    const extent = extents.get(key);
    const seen = extent == null ? 0 : overlap(extent, viewport);
    if (seen > 0 && seen >= bestOverlap) {
      best = key;
      bestOverlap = seen;
    }
  }
  return best;
}
