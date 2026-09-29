/**
 * The margin column's order and geometry, apart from the view tree.
 *
 * Pure, like ``computeMarginSlots`` beneath it: no React, no platform branch, no
 * measuring. It answers two questions for ``MarginStream``:
 *
 * 1. **Which order?** Notes whose highlight the body actually draws lead, in
 *    document order. Everything with no drawn passage to sit beside -- a stale
 *    note, one whose anchor another span already claimed, every completion
 *    suggestion -- trails in creation order, as a footnote (owner ruling on
 *    #2418). The tree order this produces is the screen-reader order AND the
 *    visual order, because the solver never re-sorts.
 * 2. **Where?** Given measured anchor tops and slot heights, every slot's top,
 *    or ``null`` while the measurements are incomplete -- the caller keeps the
 *    plain flow layout until then.
 */
import { computeMarginSlots } from './computeMarginSlots';

import type { CompletionSuggestion, Marginalia } from '@/api';

export { drawnNoteIds } from './renderedSpans';

/** One slot in the margin: a literary note or an actionable suggestion. */
export type MarginItem =
  | { key: string; anchored: boolean; note: Marginalia }
  | { key: string; anchored: false; suggestion: CompletionSuggestion };

/** A resolved aligned column: each slot's top, and how tall the stream must be. */
export interface MarginSlots {
  /** The items in placed (top-to-bottom) order: render them in this order. */
  items: MarginItem[];
  tops: number[];
  extent: number;
}

/**
 * The top of the note stream, in its own coordinates. Everything above it in
 * the column -- the no-notes notice, the resonance error -- is not the notes'
 * to cover, so a passage above this line places its note here instead.
 */
const STREAM_TOP = 0;

/** A row's rank among rows of other kinds with the same creation time. */
const NOTE_RANK = 0;
const SUGGESTION_RANK = 1;

/** A creation time as a sortable number; an unparseable one sorts last. */
function createdAt(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** Where a trailing item falls: creation time, then note-before-suggestion, then id. */
interface TailKey {
  time: number;
  rank: number;
  id: number;
}

function tailKey(item: MarginItem): TailKey {
  return 'note' in item
    ? { time: createdAt(item.note.created_at), rank: NOTE_RANK, id: item.note.id }
    : {
        time: createdAt(item.suggestion.created_at),
        rank: SUGGESTION_RANK,
        id: item.suggestion.id,
      };
}

/** Compare two trailing items by {@link tailKey}. */
function byCreation(first: MarginItem, second: MarginItem): number {
  const a = tailKey(first);
  const b = tailKey(second);
  // Two +Infinity times subtract to NaN; treat that as a tie, not an order.
  const byTime = a.time === b.time ? 0 : a.time - b.time;
  return byTime || a.rank - b.rank || a.id - b.id;
}

/**
 * The margin's items in their one order: drawn notes by ``anchor_start`` (then
 * id), then undrawn notes and live suggestions merged by ``created_at``. Ids
 * are never compared across the two tables except as a last tie-break.
 */
export function buildMarginItems(
  notes: Marginalia[],
  suggestions: CompletionSuggestion[],
  drawn: ReadonlySet<number>,
): MarginItem[] {
  const head = notes
    .filter((note) => drawn.has(note.id))
    .sort((a, b) => a.anchor_start - b.anchor_start || a.id - b.id)
    .map((note): MarginItem => ({ key: `note-${note.id}`, anchored: true, note }));
  const tail: MarginItem[] = [
    ...notes
      .filter((note) => !drawn.has(note.id))
      .map((note): MarginItem => ({ key: `note-${note.id}`, anchored: false, note })),
    ...suggestions
      .filter((s) => s.status !== 'dismissed')
      .map((suggestion): MarginItem => ({
        key: `suggestion-${suggestion.id}`,
        anchored: false,
        suggestion,
      })),
  ];
  return [...head, ...tail.sort(byCreation)];
}

/**
 * An item's usable anchor top, or ``null`` when it has none to sit beside. A
 * passage above the stream (a banner above the notes pushed the stream past
 * it) is held at the stream's top, so the note never covers the banner.
 */
function anchorTopOf(item: MarginItem, anchorTops: ReadonlyMap<number, number>): number | null {
  if (!item.anchored || !('note' in item)) return null;
  const top = anchorTops.get(item.note.id);
  return top !== undefined && Number.isFinite(top) ? Math.max(top, STREAM_TOP) : null;
}

/**
 * Resolve every slot's top beside its passage, or ``null`` to keep the flow.
 *
 * A drawn note whose passage went unmeasured (missing or non-finite top) has
 * nothing to sit beside, so it joins the tail -- merged by creation time -- in
 * the returned order as well as on screen. The caller renders ``items`` in the
 * order returned, so the tree (and a screen reader) always reads the column
 * top to bottom: tops are non-decreasing in that order.
 *
 * @param items - The margin's items, in {@link buildMarginItems} order.
 * @param anchorTops - Note id to its highlight's top, in the stream's own
 *   coordinates. The solver has no NaN guard, so no non-finite top reaches it.
 * @param heights - Item key to its slot's measured height.
 * @param gap - The clearance between slots; callers pass
 *   ``journalLayout.marginNoteGap``.
 * @returns ``null`` until every slot has a finite height and at least one
 *   note has a finite anchor top; otherwise the items in placed order, their
 *   tops, and the stream's extent (the lowest bottom edge).
 */
export function assignMarginSlots(
  items: readonly MarginItem[],
  anchorTops: ReadonlyMap<number, number>,
  heights: ReadonlyMap<string, number>,
  gap: number,
): MarginSlots | null {
  if (!items.every((item) => Number.isFinite(heights.get(item.key)))) return null;
  const placed = items.filter((item) => anchorTopOf(item, anchorTops) !== null);
  if (placed.length === 0) return null;
  const trailing = items.filter((item) => anchorTopOf(item, anchorTops) === null);
  const ordered = [...placed, ...trailing.sort(byCreation)];
  const sizes = ordered.map((item) => heights.get(item.key) ?? Number.NaN);
  const tops = computeMarginSlots(
    ordered.map((item) => anchorTopOf(item, anchorTops)),
    sizes,
    gap,
  );
  const extent = Math.max(...tops.map((top, index) => top + (sizes[index] ?? Number.NaN)));
  return { items: ordered, tops, extent };
}
