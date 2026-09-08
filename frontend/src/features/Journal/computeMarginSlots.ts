/**
 * Place margin notes beside the passages they annotate, without letting two of
 * them occupy the same vertical band.
 *
 * Pure offset math — no React, no layout events, no platform branch — so the
 * column's geometry is unit-testable apart from the view tree that will consume
 * it. Callers supply already-measured numbers; this module never measures.
 *
 * Two invariants define it:
 *
 * 1. **Push-down by exactly ``gap``.** An item wants to sit at its anchor. If
 *    that would overlap the item placed before it, it drops to the first
 *    position that clears that item by ``gap`` — never further, never less.
 *    One ordered pass resolves the whole column, including cascades.
 * 2. **Input order is document order.** ``tops[i]`` is item ``i``'s top; the
 *    solver never re-sorts. Sequencing is the caller's job and is already
 *    solved — ``buildMarginItems`` sorts by ``anchor_start`` in
 *    ``JournalEntryScreen.tsx`` — so passing anchors out of document order
 *    still yields a valid non-overlapping column, just in the order given.
 *
 * An item whose ``anchorTop`` is ``null`` or ``undefined`` is *unanchored*:
 * ``CompletionSuggestion`` rows do carry ``anchor_start``/``anchor_end``
 * (``frontend/src/api/schemas.ts``), but ``HighlightedBody`` draws highlights
 * only for notes and quotes, so a suggestion has no visible passage to sit
 * beside; callers pass its anchor as ``null`` and it trails the anchored items
 * in creation order, reading as a footnote (owner ruling on #2418).
 *
 * There is no clamping. The first anchored item lands on its anchor even when
 * that anchor is negative, and a note taller than the column pushes everything
 * after it deterministically rather than being folded back — the column (a
 * scroll surface under #2418) is what grows. A future measurement bug therefore
 * shows up as a wrong offset instead of being silently rewritten to zero.
 */

/**
 * Where the unanchored tail starts when no anchored item precedes it — the top
 * of the margin column. It is *only* that origin, never a floor on anchored
 * placement.
 */
export const COLUMN_TOP = 0;

/** An item's measured anchor top, or ``null``/``undefined`` when unanchored. */
export type MarginAnchorTop = number | null | undefined;

/**
 * The two input arrays disagreed on how many items there are, so no index
 * alignment is possible and every top would be a guess. A programmer error at
 * the call site, raised rather than papered over with a default height.
 */
export class MarginSlotInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarginSlotInputError';
  }
}

/** One item, with ``undefined`` already normalised to the ``null`` "unanchored". */
interface SlotInput {
  anchorTop: number | null;
  height: number;
}

/**
 * Lay out the anchored items in input order, writing their tops into ``tops``.
 *
 * @returns The bottom edge (plus ``gap``) of the last anchored item, or ``null``
 *   when none was anchored — the distinction that keeps the first anchored item
 *   free to sit above zero.
 */
function placeAnchored(items: readonly SlotInput[], gap: number, tops: number[]): number | null {
  let flowBottom: number | null = null;
  for (const [index, { anchorTop, height }] of items.entries()) {
    if (anchorTop === null) continue;
    // Annotated because `flowBottom` is assigned from `top` below: without it
    // TypeScript reports TS7022 on the circular inference.
    const top: number = flowBottom === null ? anchorTop : Math.max(anchorTop, flowBottom);
    tops[index] = top;
    flowBottom = top + height + gap;
  }
  return flowBottom;
}

/** Stack the unanchored items after ``start``, in input (creation) order. */
function placeUnanchored(
  items: readonly SlotInput[],
  gap: number,
  tops: number[],
  start: number,
): void {
  let next = start;
  for (const [index, { anchorTop, height }] of items.entries()) {
    if (anchorTop !== null) continue;
    tops[index] = next;
    next += height + gap;
  }
}

/**
 * Resolve the margin column: every item's top, in the order it was given.
 *
 * @param anchorTops - Each item's desired top, or ``null``/``undefined`` when it
 *   has no drawn passage to sit beside. Assumed to be in document order.
 * @param noteHeights - Each item's measured height, index-aligned with
 *   ``anchorTops``.
 * @param gap - The minimum vertical clearance between two items. Callers pass
 *   ``journalLayout.marginNoteGap``; it is a parameter, not an import, so this
 *   module stays free of the design system.
 * @returns Tops index-aligned with the inputs, non-overlapping, in input order.
 * @throws MarginSlotInputError When the two arrays differ in length.
 */
export function computeMarginSlots(
  anchorTops: readonly MarginAnchorTop[],
  noteHeights: readonly number[],
  gap: number,
): number[] {
  if (anchorTops.length !== noteHeights.length) {
    throw new MarginSlotInputError(
      `computeMarginSlots: ${anchorTops.length} anchor tops but ${noteHeights.length} note heights`,
    );
  }
  const items: SlotInput[] = noteHeights.map((height, index) => ({
    height,
    anchorTop: anchorTops[index] ?? null,
  }));
  const tops = items.map(() => COLUMN_TOP);
  const flowBottom = placeAnchored(items, gap, tops);
  placeUnanchored(items, gap, tops, flowBottom ?? COLUMN_TOP);
  return tops;
}
