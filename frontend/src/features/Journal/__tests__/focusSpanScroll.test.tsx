import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, renderHook } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, type ScrollView, type View } from 'react-native';

import {
  FOCUS_SCROLL_MARGIN,
  FocusScrollProvider,
  useFocusScrollHost,
  type FocusScrollValue,
} from '../focusSpanScroll';
import HighlightedBody from '../HighlightedBody';

import type { PromotedQuote } from '@/api';
import { accent } from '@/design/tokens';

let mockReducedMotion = false;
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockReducedMotion,
}));

const FIRST = 'A morning of rain.';
const SECOND = 'The river kept its own counsel.';
const BODY = `${FIRST}\n\n${SECOND}`;
const RIVER_START = BODY.indexOf('river');
const RIVER_END = RIVER_START + 'river'.length;

function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 9,
    source_entry_id: 1,
    anchor_start: RIVER_START,
    anchor_end: RIVER_END,
    anchor_text: 'river',
    pending: true,
    stale: false,
    ...overrides,
  };
}

type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

function renderedText(node: RenderedNode): string {
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

function renderBody(
  value: FocusScrollValue | null,
  quotes: PromotedQuote[] = [quote()],
): ReturnType<typeof render> {
  const body = <HighlightedBody body={BODY} notes={[]} onOpen={jest.fn()} quotes={quotes} />;
  return render(
    value == null ? body : <FocusScrollProvider value={value}>{body}</FocusScrollProvider>,
  );
}

describe('HighlightedBody focus anchor', () => {
  it('wraps only the block holding the focused quote and marks the quote itself', () => {
    const onAnchorLayout = jest.fn();
    const { getByTestId, queryByTestId } = renderBody({
      span: { start: RIVER_START, end: RIVER_END },
      onAnchorLayout,
    });

    // The prose block splits at the quote's line; the blank line before it
    // leads the measured half, so the page still reads exactly as written.
    const anchor = getByTestId('journal-focus-anchor');
    expect(renderedText(anchor)).toBe(`\n${SECOND}`);
    // The one feed dropped is the join between the halves, which is now the
    // break between two stacked text blocks: first line, blank line, quote line.
    expect(renderedText(getByTestId('journal-body-read'))).toBe(`${FIRST}\n${SECOND}`);
    const focused = getByTestId('quote-highlight-9-focused');
    expect(StyleSheet.flatten(focused.props.style).textDecorationColor).toBe(accent.primary);
    expect(queryByTestId('quote-highlight-9')).toBeNull();

    fireEvent(anchor, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 1, height: 1 } } });
    expect(onAnchorLayout).toHaveBeenCalledTimes(1);
  });

  it('wraps a quoted block whole, since its container carries the styling', () => {
    const body = `${FIRST}\n> ${SECOND}`;
    const start = body.indexOf('river');
    const { getByTestId } = render(
      <FocusScrollProvider value={{ span: { start, end: start + 5 }, onAnchorLayout: jest.fn() }}>
        <HighlightedBody
          body={body}
          notes={[]}
          onOpen={jest.fn()}
          quotes={[quote({ anchor_start: start, anchor_end: start + 5 })]}
        />
      </FocusScrollProvider>,
    );

    const anchor = getByTestId('journal-focus-anchor');
    expect(renderedText(anchor)).toBe(SECOND);
    expect(anchor.findAllByProps({ accessibilityLabel: 'Quote block' }).length).toBeGreaterThan(0);
  });

  it.each([
    ['there is no page scroller', null],
    ['the span has no matching quote', { start: RIVER_START, end: RIVER_END - 1 }],
    ['the span is past the body', { start: RIVER_START, end: BODY.length + 1 }],
  ])('renders no anchor when %s', (_why, span) => {
    const value = span == null ? null : { span, onAnchorLayout: jest.fn() };
    const { queryByTestId, getByTestId } = renderBody(value);

    expect(queryByTestId('journal-focus-anchor')).toBeNull();
    expect(getByTestId('quote-highlight-9')).toBeTruthy();
  });

  it('renders no anchor for a stale quote, so the page opens at the top', () => {
    const { queryByTestId } = renderBody(
      { span: { start: RIVER_START, end: RIVER_END }, onAnchorLayout: jest.fn() },
      [quote({ stale: true })],
    );
    expect(queryByTestId('journal-focus-anchor')).toBeNull();
  });
});

describe('useFocusScrollHost', () => {
  const PAGE_OFFSET = 40;
  const ANCHOR_Y = 300;

  beforeEach(() => {
    mockReducedMotion = false;
  });

  function mount(span: { start: number; end: number } | undefined) {
    const scrollTo = jest.fn();
    const hook = renderHook(() => useFocusScrollHost(span));
    hook.result.current.scrollRef.current = { scrollTo } as unknown as ScrollView;
    hook.result.current.pageRef.current = {} as View;
    hook.result.current.onPageLayout({
      nativeEvent: { layout: { x: 0, y: PAGE_OFFSET, width: 1, height: 1 } },
    } as Parameters<typeof hook.result.current.onPageLayout>[0]);
    const anchor = (y: number) =>
      ({
        measureLayout: (_page: unknown, onSuccess: (_x: number, _y: number) => void) =>
          onSuccess(0, y),
      }) as unknown as View;
    return { hook, scrollTo, anchor };
  }

  it('scrolls the anchor into view below a margin, once per span', () => {
    const { hook, scrollTo, anchor } = mount({ start: 1, end: 4 });

    hook.result.current.value.onAnchorLayout(anchor(ANCHOR_Y));
    hook.result.current.value.onAnchorLayout(anchor(ANCHOR_Y));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({
      y: PAGE_OFFSET + ANCHOR_Y - FOCUS_SCROLL_MARGIN,
      animated: true,
    });
  });

  it('never scrolls above the top of the page', () => {
    const { hook, scrollTo, anchor } = mount({ start: 1, end: 4 });
    hook.result.current.value.onAnchorLayout(anchor(-PAGE_OFFSET));
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });

  it('jumps without animating when the reader asked for reduced motion', () => {
    mockReducedMotion = true;
    const { hook, scrollTo, anchor } = mount({ start: 1, end: 4 });
    hook.result.current.value.onAnchorLayout(anchor(ANCHOR_Y));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
  });

  it('does nothing without a span', () => {
    const { hook, scrollTo, anchor } = mount(undefined);
    hook.result.current.value.onAnchorLayout(anchor(ANCHOR_Y));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
