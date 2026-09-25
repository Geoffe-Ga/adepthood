/**
 * Growth for the journal's multiline fields: a field reports its content size
 * and takes that height, so it is part of the page flow instead of an inner
 * scroll pane.
 */
import { useCallback, useState } from 'react';

interface ContentSizeEvent {
  nativeEvent: { contentSize: { height: number } };
}

/** Make a multiline field part of the page flow instead of an inner scroll pane. */
export function useGrowingFieldHeight(minHeight = 0) {
  const [contentHeight, setContentHeight] = useState(0);
  const onContentSizeChange = useCallback((event: ContentSizeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.contentSize.height);
    setContentHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
  const height = contentHeight > 0 ? Math.max(minHeight, contentHeight) : minHeight || undefined;
  return { style: { minHeight: minHeight || undefined, height }, onContentSizeChange };
}
