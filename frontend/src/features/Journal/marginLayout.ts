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
import { buildAnchoredSegments } from './highlightSegments';

import type { CompletionSuggestion, Marginalia, PromotedQuote } from '@/api';

/** One slot in the margin: a literary note or an actionable suggestion. */
export type MarginItem =
  | { key: string; anchored: boolean; note: Marginalia }
  | { key: string; anchored: false; suggestion: CompletionSuggestion };

/** A resolved aligned column: each slot's top, and how tall the stream must be. */
export interface MarginSlots {
  tops: number[];
  extent: number;
}

/** A row's rank among rows of other kinds with the same creation time. */
const NOTE_RANK = 0;
const SUGGESTION_RANK = 1;

/**
 * The ids of the notes the read view draws a highlight for.
 *
 * Asks ``buildAnchoredSegments`` itself, with the arguments ``HighlightedBody``
 * gets, so "drawn" has one definition: a stale, out-of-range, or overlap-skipped
 * note is excluded by the very rule that keeps it out of the body.
 */
export function drawnNoteIds(
  body: string,
  notes: Marginalia[],
  quotes: PromotedQuote[],
): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const segment of buildAnchoredSegments(body, notes, quotes)) {
    if (segment.note) ids.add(segment.note.id);
  }
  return ids;
}

/** A creation time as a sortable number; an unparseable one sorts last. */
function createdAt(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

interface TailRow {
  item: MarginItem;
  time: number;
  rank: number;
  id: number;
}

/** Compare two trailing rows: creation time, then note-before-suggestion, then id. */
function byCreation(a: TailRow, b: TailRow): number {
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
  const tail: TailRow[] = [
    ...notes
      .filter((note) => !drawn.has(note.id))
      .map((note) => ({
        item: { key: `note-${note.id}`, anchored: false, note } as const,
        time: createdAt(note.created_at),
        rank: NOTE_RANK,
        id: note.id,
      })),
    ...suggestions
      .filter((s) => s.status !== 'dismissed')
      .map((suggestion) => ({
        item: { key: `suggestion-${suggestion.id}`, anchored: false, suggestion } as const,
        time: createdAt(suggestion.created_at),
        rank: SUGGESTION_RANK,
        id: suggestion.id,
      })),
  ];
  return [...head, ...tail.sort(byCreation).map((row) => row.item)];
}

/** An item's usable anchor top, or ``null`` when it has none to sit beside. */
function anchorTopOf(item: MarginItem, anchorTops: ReadonlyMap<number, number>): number | null {
  if (!item.anchored || !('note' in item)) return null;
  const top = anchorTops.get(item.note.id);
  return top !== undefined && Number.isFinite(top) ? top : null;
}

/**
 * Resolve every slot's top beside its passage, or ``null`` to keep the flow.
 *
 * @param items - The margin's items, in {@link buildMarginItems} order.
 * @param anchorTops - Note id to its highlight's top, in the stream's own
 *   coordinates. A missing or non-finite top makes that note trail -- the
 *   solver has no NaN guard, so none may reach it.
 * @param heights - Item key to its slot's measured height.
 * @param gap - The clearance between slots; callers pass
 *   ``journalLayout.marginNoteGap``.
 * @returns ``null`` until every slot has a finite height and at least one
 *   note has a finite anchor top; otherwise the tops and the stream's extent
 *   (the lowest bottom edge, which is not always the last item's).
 */
export function assignMarginSlots(
  items: readonly MarginItem[],
  anchorTops: ReadonlyMap<number, number>,
  heights: ReadonlyMap<string, number>,
  gap: number,
): MarginSlots | null {
  const sizes = items.map((item) => heights.get(item.key));
  const measured = sizes.filter((h): h is number => h !== undefined && Number.isFinite(h));
  if (measured.length !== items.length) return null;
  const anchors = items.map((item) => anchorTopOf(item, anchorTops));
  if (anchors.every((top) => top === null)) return null;
  const tops = computeMarginSlots(anchors, measured, gap);
  const extent = Math.max(...tops.map((top, index) => top + (measured[index] ?? Number.NaN)));
  return { tops, extent };
}
