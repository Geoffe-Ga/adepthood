// The review's half of the Promoted quotes hand-off (#2885): collect only the
// delivery addressed to this page, only once it can fold, and exactly once.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { FoldCandidate } from '../quoteBatch';
import { usePromotedQuoteHandoff } from '../usePromotedQuoteHandoff';

import { usePromotedQuoteHandoffStore } from '@/store/usePromotedQuoteHandoffStore';

const QUOTES: FoldCandidate[] = [
  { id: 1, anchorText: 'one', attribution: 'Mon' },
  { id: 2, anchorText: 'two', attribution: 'Mon' },
];

const store = () => usePromotedQuoteHandoffStore.getState();

type Props = { ready: boolean; routeToken?: string };

function setup(initial: Props) {
  const onInsertQuotes = jest.fn((_c: readonly FoldCandidate[]) =>
    Promise.resolve({ included: [], failed: [], skipped: [] }),
  );
  const hook = renderHook((props: Props) => usePromotedQuoteHandoff({ ...props, onInsertQuotes }), {
    initialProps: initial,
  });
  return { ...hook, onInsertQuotes };
}

beforeEach(() => {
  act(() => store().clear());
});

describe('usePromotedQuoteHandoff', () => {
  it('collects a delivery under the token it minted, once, and retracts it', () => {
    const { result, rerender, onInsertQuotes } = setup({ ready: true });
    let token = '';
    act(() => {
      token = result.current.mint();
    });
    act(() => store().deliver(token, QUOTES));
    expect(onInsertQuotes).toHaveBeenCalledTimes(1);
    expect(onInsertQuotes).toHaveBeenCalledWith(QUOTES);
    expect(store().pending).toBeNull();
    rerender({ ready: true });
    expect(onInsertQuotes).toHaveBeenCalledTimes(1);
  });

  it('collects the delivery named by its route token', () => {
    act(() => store().deliver('quotes-9', QUOTES));
    const { onInsertQuotes } = setup({ ready: true, routeToken: 'quotes-9' });
    expect(onInsertQuotes).toHaveBeenCalledWith(QUOTES);
  });

  it('leaves a delivery addressed to another page alone', () => {
    const { result, onInsertQuotes } = setup({ ready: true, routeToken: 'quotes-3' });
    act(() => {
      result.current.mint();
    });
    act(() => store().deliver('quotes-elsewhere', QUOTES));
    expect(onInsertQuotes).not.toHaveBeenCalled();
    expect(store().pending?.token).toBe('quotes-elsewhere');
  });

  it('waits until the page can fold, then collects exactly once', () => {
    act(() => store().deliver('quotes-5', QUOTES));
    const { rerender, onInsertQuotes } = setup({ ready: false, routeToken: 'quotes-5' });
    expect(onInsertQuotes).not.toHaveBeenCalled();
    expect(store().pending?.token).toBe('quotes-5');
    rerender({ ready: true, routeToken: 'quotes-5' });
    rerender({ ready: true, routeToken: 'quotes-5' });
    expect(onInsertQuotes).toHaveBeenCalledTimes(1);
  });
});
