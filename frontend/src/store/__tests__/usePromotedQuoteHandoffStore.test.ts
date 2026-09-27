/**
 * The promoted-quote hand-off (#2885) carries a selection one hop, from the
 * Promoted quotes screen to the review that folds it in. Only an opaque token
 * rides in navigation params; the quotes themselves wait here, in memory, and
 * the logout reset wipes an undelivered selection.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import { resetAllStores } from '../registry';
import { usePromotedQuoteHandoffStore } from '../usePromotedQuoteHandoffStore';

const state = () => usePromotedQuoteHandoffStore.getState();
const QUOTES = [{ id: 7, anchorText: 'by the river', attribution: 'Walk' }];

function open(): string {
  let token = '';
  act(() => {
    token = state().open();
  });
  return token;
}

beforeEach(() => {
  act(() => state().clear());
});

describe('usePromotedQuoteHandoffStore', () => {
  it('starts with nothing pending', () => {
    expect(state().pending).toBeNull();
  });

  it('mints a distinct, opaque token for every hand-off', () => {
    const first = open();
    const second = open();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^quotes-\d+$/);
  });

  it('publishes a delivery under the token it was addressed to', () => {
    const token = open();
    act(() => state().deliver(token, QUOTES));
    expect(state().pending).toEqual({ token, candidates: QUOTES });
  });

  it('drops an uncollected delivery when a new hand-off opens', () => {
    const stale = open();
    act(() => state().deliver(stale, QUOTES));
    open();
    expect(state().pending).toBeNull();
  });

  it('retracts a delivery once collected', () => {
    const token = open();
    act(() => state().deliver(token, QUOTES));
    act(() => state().clear());
    expect(state().pending).toBeNull();
  });

  it('wipes an undelivered selection at logout', () => {
    const token = open();
    act(() => state().deliver(token, QUOTES));
    act(() => resetAllStores());
    expect(state().pending).toBeNull();
  });
});
