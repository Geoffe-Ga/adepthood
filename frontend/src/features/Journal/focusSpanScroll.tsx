/**
 * ``focusSpanScroll`` — bring a quote the reader arrived to see into view.
 *
 * The Promoted quotes screen (#2865) opens an entry with a ``highlightSpan``.
 * The page that owns the scroller provides this context; the read-mode body
 * (``HighlightedBody``) resolves the span against the entry's own quotes and,
 * when it holds, wraps the markdown block containing it in a measurable anchor
 * that reports its layout here. The provider then measures that anchor against
 * the page and scrolls to it -- once per span, so the reader is never yanked
 * back after scrolling on their own.
 *
 * The block, not the quote, is measured: a quote is a nested ``<Text>`` run and
 * a nested text run has no layout of its own to measure. Without a provider, or
 * with a span that does not resolve, nothing scrolls and the page opens at the
 * top, as it always has.
 */
import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { LayoutChangeEvent, ScrollView, View } from 'react-native';

import type { FocusSpan } from './highlightSegments';

import { SPACING } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** Breathing room left above the quote's block once it is scrolled into view. */
export const FOCUS_SCROLL_MARGIN = SPACING.xl;

export interface FocusScrollValue {
  /** The span the reader arrived to see, if any. */
  span: FocusSpan | undefined;
  /** The anchor block has laid out: measure it and scroll to it (once per span). */
  onAnchorLayout: (_anchor: View) => void;
}

const FocusScrollContext = createContext<FocusScrollValue | null>(null);

/** The nearest page's focus scroller, or null outside one. */
export function useFocusScroll(): FocusScrollValue | null {
  return useContext(FocusScrollContext);
}

export interface FocusScrollHost {
  /** Attach to the page's ``ScrollView``. */
  scrollRef: React.RefObject<ScrollView | null>;
  /** Attach to the page view the anchor is measured against. */
  pageRef: React.RefObject<View | null>;
  /** The page view's own ``onLayout``: records where it starts in the scroller. */
  onPageLayout: (_event: LayoutChangeEvent) => void;
  value: FocusScrollValue;
}

/** Stable key for "this span on this page"; a new span scrolls afresh. */
function spanKey(span: FocusSpan | undefined): string | null {
  return span == null ? null : `${span.start}:${span.end}`;
}

/**
 * Own the refs and the once-per-span scroll for a page that hosts a focus span.
 *
 * The page view sits inside the scroller's padded content, so the anchor's
 * offset within the page is added to the page's own offset in the content.
 */
export function useFocusScrollHost(span: FocusSpan | undefined): FocusScrollHost {
  const scrollRef = useRef<ScrollView | null>(null);
  const pageRef = useRef<View | null>(null);
  const pageOffset = useRef(0);
  const scrolledFor = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const key = spanKey(span);

  const onPageLayout = useCallback((event: LayoutChangeEvent) => {
    pageOffset.current = event.nativeEvent.layout.y;
  }, []);

  const onAnchorLayout = useCallback(
    (anchor: View) => {
      const page = pageRef.current;
      if (key == null || scrolledFor.current === key || page == null) return;
      anchor.measureLayout(page, (_x, y) => {
        if (scrolledFor.current === key) return;
        scrolledFor.current = key;
        scrollRef.current?.scrollTo({
          y: Math.max(0, pageOffset.current + y - FOCUS_SCROLL_MARGIN),
          animated: !reducedMotion,
        });
      });
    },
    [key, reducedMotion],
  );

  const value = useMemo(() => ({ span, onAnchorLayout }), [span, onAnchorLayout]);
  return { scrollRef, pageRef, onPageLayout, value };
}

/** Provide a page's focus scroller to the read-mode body beneath it. */
export function FocusScrollProvider({
  value,
  children,
}: {
  value: FocusScrollValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <FocusScrollContext.Provider value={value}>{children}</FocusScrollContext.Provider>;
}
