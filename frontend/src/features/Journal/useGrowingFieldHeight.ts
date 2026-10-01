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
 */
import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

import { readWebContentHeight } from './webFieldMeasure';

interface ContentSizeEvent {
  nativeEvent: { contentSize: { height: number } };
}

/** The value a field shows and the ref to its host, to re-measure it when the value changes. */
export interface GrowingFieldTracking {
  value: string;
  inputRef: RefObject<unknown>;
}

/** Make a multiline field part of the page flow instead of an inner scroll pane. */
export function useGrowingFieldHeight(minHeight = 0, tracked?: GrowingFieldTracking) {
  const [contentHeight, setContentHeight] = useState(0);
  const applyMeasuredHeight = useCallback((measured: number) => {
    const nextHeight = Math.ceil(measured);
    setContentHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
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
  const height = contentHeight > 0 ? Math.max(minHeight, contentHeight) : minHeight || undefined;
  return { style: { minHeight: minHeight || undefined, height }, onContentSizeChange };
}
