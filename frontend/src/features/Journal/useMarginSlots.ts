/**
 * Feed the margin solver its measurements: slot heights from each slot's
 * ``onLayout``, anchor tops from {@link measureAnchorTops}.
 *
 * Until both are in hand -- the first render, native, Jest's node env -- it
 * returns ``null`` slots and the margin keeps its plain document-order flow.
 * Nothing here scrolls or animates: a slot simply lands at its top, so reduced
 * motion has nothing to suppress.
 *
 * The loop is closed by construction: an aligned slot keeps its width, so its
 * height does not change, and the passages live in the other column, so moving
 * a slot cannot move an anchor. Every setter also keeps the previous map when
 * the new one is equal, so a re-measure that finds nothing new renders nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useWindowDimensions, type LayoutChangeEvent, type View } from 'react-native';

import { measureAnchorTops } from './marginAnchorMeasure';
import { assignMarginSlots, type MarginItem, type MarginSlots } from './marginLayout';

import { journalLayout } from '@/design/tokens';

interface MarginSlotsInput {
  items: readonly MarginItem[];
  /** False on a narrow (stacked) page or while editing: keep the flow layout. */
  align: boolean;
  /** Bumped when the page lays out again, so a reflowed body is re-measured. */
  layoutTick: number;
}

export interface MarginSlotsHost {
  streamRef: RefObject<View | null>;
  onStreamLayout: () => void;
  onSlotLayout: (_key: string, _event: LayoutChangeEvent) => void;
  /** Each slot's top and the stream's height, or ``null`` for the flow layout. */
  slots: MarginSlots | null;
}

function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!Object.is(b.get(key), value)) return false;
  }
  return true;
}

/** Measure, place, and re-measure the margin's slots. */
export function useMarginSlots({ items, align, layoutTick }: MarginSlotsInput): MarginSlotsHost {
  const streamRef = useRef<View | null>(null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [anchorTops, setAnchorTops] = useState<ReadonlyMap<number, number>>(() => new Map());
  const windowWidth = useWindowDimensions().width;

  const anchoredIds = useMemo(
    () => items.flatMap((item) => (item.anchored && 'note' in item ? [item.note.id] : [])),
    [items],
  );

  const remeasure = useCallback(() => {
    if (!align) return;
    const next = measureAnchorTops(streamRef.current, anchoredIds);
    setAnchorTops((prev) => (sameMap(prev, next) ? prev : next));
  }, [align, anchoredIds]);

  // A new item set, a new slot height, a page reflow or a resize can each move
  // a passage relative to the stream.
  useEffect(() => {
    remeasure();
  }, [remeasure, heights, layoutTick, windowWidth]);

  const onSlotLayout = useCallback((key: string, event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setHeights((prev) => (prev.get(key) === height ? prev : new Map(prev).set(key, height)));
  }, []);

  const slots = useMemo(
    () =>
      align ? assignMarginSlots(items, anchorTops, heights, journalLayout.marginNoteGap) : null,
    [align, items, anchorTops, heights],
  );

  return { streamRef, onStreamLayout: remeasure, onSlotLayout, slots };
}
