/**
 * Growth for the journal's multiline fields: a field reports its content size
 * and takes that height, so it is part of the page flow instead of an inner
 * scroll pane.
 *
 * On web a field may also be ``tracked``: whenever its value changes, its host
 * textarea is re-measured after the write, because react-native-web reports a
 * content size only for typed input, never for a value set from React (#3001).
 * That read is grow-only -- a textarea's ``scrollHeight`` under an explicit
 * height is never less than that height -- just as typed growth is on web.
 *
 * A tracked web field is also re-measured, both ways, whenever its WIDTH
 * changes or a font face finishes loading: the same text rewraps onto more or
 * fewer lines, and react-native-web reports no content size for either, so a
 * title typed on a wide page and read on a phone kept its one-line height and
 * hid its second line (#3325). Native's ``onContentSizeChange`` already
 * follows both.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { onWebFontsSettled, readWebContentHeight, readWebNaturalHeight } from './webFieldMeasure';

interface ContentSizeEvent {
  nativeEvent: { contentSize: { height: number } };
}

interface LayoutEvent {
  nativeEvent: { layout: { width: number } };
}

/** The value a field shows and the ref to its host, to re-measure it when the value changes. */
export interface GrowingFieldTracking {
  value: string;
  inputRef: RefObject<unknown>;
}

/** Make a multiline field part of the page flow instead of an inner scroll pane. */
export function useGrowingFieldHeight(minHeight = 0, tracked?: GrowingFieldTracking) {
  const [contentHeight, setContentHeight] = useState(0);
  // A repeated height is the same number, so React's Object.is bailout commits nothing.
  const applyMeasuredHeight = useCallback(
    (measured: number) => setContentHeight(Math.ceil(measured)),
    [],
  );
  const onContentSizeChange = useCallback(
    (event: ContentSizeEvent) => applyMeasuredHeight(event.nativeEvent.contentSize.height),
    [applyMeasuredHeight],
  );
  const trackedValue = tracked?.value;
  const trackedRef = tracked?.inputRef;
  useLayoutEffect(() => {
    if (trackedRef == null) return;
    const measured = readWebContentHeight(trackedRef.current);
    if (measured !== undefined) applyMeasuredHeight(measured);
  }, [trackedValue, trackedRef, applyMeasuredHeight]);
  const remeasureNatural = useCallback(() => {
    if (trackedRef == null) return;
    const measured = readWebNaturalHeight(trackedRef.current);
    if (measured !== undefined) applyMeasuredHeight(measured);
  }, [trackedRef, applyMeasuredHeight]);
  // Only a new width rewraps the text; the height this hook sets lays out too.
  const laidOutWidth = useRef<number | undefined>(undefined);
  const onLayout = useCallback(
    (event: LayoutEvent) => {
      const { width } = event.nativeEvent.layout;
      if (width === laidOutWidth.current) return;
      laidOutWidth.current = width;
      remeasureNatural();
    },
    [remeasureNatural],
  );
  useEffect(
    () => (trackedRef == null ? undefined : onWebFontsSettled(remeasureNatural)),
    [trackedRef, remeasureNatural],
  );
  const height = contentHeight > 0 ? Math.max(minHeight, contentHeight) : minHeight || undefined;
  return { style: { minHeight: minHeight || undefined, height }, onContentSizeChange, onLayout };
}
