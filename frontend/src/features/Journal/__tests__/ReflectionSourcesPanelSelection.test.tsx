// The sources panel's multi-select fold-in (#2885). In selection mode a row is
// a checkbox: a press checks it and folds NOTHING in. The fixed action beneath
// the scroll folds every checked quote as one batch, in the panel's own order.
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { Platform, TouchableOpacity } from 'react-native';

import type { FoldCandidate } from '../quoteBatch';
import type { BatchFoldResult } from '../useReflectionMode';

import type { PromotedQuoteSummary, ReflectionSourceItem } from '@/api';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;
const { SIDE_PANE_BREAKPOINT } = require('../ReflectionSourcesPanel') as {
  SIDE_PANE_BREAKPOINT: number;
};

function quote(id: number, text: string): PromotedQuoteSummary {
  return { id, anchor_start: 0, anchor_end: 4, anchor_text: text, pending: true };
}

// Two sources, oldest first in the feed, deliberately handed over newest first:
// the panel's order is collectPending's -- the order the items arrive in.
const S1: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Monday',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'first body',
  reflection_level: null,
  promoted_quotes: [quote(11, 'one'), quote(12, 'two')],
};
const S2: ReflectionSourceItem = {
  ...S1,
  id: 2,
  title: 'Tuesday',
  timestamp: '2026-06-02T00:00:00Z',
  promoted_quotes: [quote(21, 'three')],
};

type InsertMany = (_c: readonly FoldCandidate[]) => Promise<BatchFoldResult>;

function allIncluded(): jest.Mock<InsertMany> {
  return jest.fn<InsertMany>((candidates) =>
    Promise.resolve({ included: candidates.map((c) => c.id), failed: [], skipped: [] }),
  );
}

function mockWidth(width: number) {
  const rn = require('react-native');
  jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
}

function renderPanel(
  props: Record<string, unknown> = {},
  width = SIDE_PANE_BREAKPOINT,
): ReturnType<typeof render> {
  mockWidth(width);
  return render(
    <ReflectionSourcesPanel
      items={[S1, S2]}
      onInsertQuote={jest.fn()}
      onInsertQuotes={allIncluded()}
      onClose={jest.fn()}
      {...props}
    />,
  );
}

/** The web cases use the sheet: the wide pane listens on ``document``, absent here. */
const SHEET_WIDTH = 375;

const originalOS = Platform.OS;
function asPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => {
  jest.restoreAllMocks();
  asPlatform(originalOS);
});

describe('ReflectionSourcesPanel -- selection mode (#2885)', () => {
  it('offers no selection mode when the composer cannot fold a batch', () => {
    const { queryByTestId } = renderPanel({ onInsertQuotes: undefined });
    expect(queryByTestId('pending-quotes-select-toggle')).toBeNull();
  });

  it('is entered by a labelled control, and a row press then checks the quote without folding it', () => {
    const onInsertQuote = jest.fn();
    const onInsertQuotes = allIncluded();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuote, onInsertQuotes });
    expect(getByTestId('pending-quote-11').props.accessibilityRole).toBe('button');
    fireEvent.press(getByLabelText('Select quotes'));
    const row = getByTestId('pending-quote-11');
    expect(row.props.accessibilityRole).toBe('checkbox');
    expect(row.props.accessibilityState).toEqual(expect.objectContaining({ checked: false }));
    fireEvent.press(row);
    expect(getByTestId('pending-quote-11').props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(onInsertQuote).not.toHaveBeenCalled();
    expect(onInsertQuotes).not.toHaveBeenCalled();
  });

  it('writes aria-checked on each row on the web', () => {
    asPlatform('web');
    const { getByTestId, getByLabelText, UNSAFE_getAllByType } = renderPanel({}, SHEET_WIDTH);
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-12'));
    const rows = UNSAFE_getAllByType(TouchableOpacity).filter((node) =>
      String(node.props.testID).startsWith('pending-quote-'),
    );
    expect(rows.map((node) => [node.props.testID, node.props['aria-checked']])).toEqual([
      ['pending-quote-11', false],
      ['pending-quote-12', true],
      ['pending-quote-21', false],
    ]);
  });

  it('selects every unfolded pending quote, and clears them all', () => {
    const { getByTestId, getByLabelText } = renderPanel({ foldedIds: new Set([12]) });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByLabelText('Select all'));
    expect(getByTestId('pending-quote-11').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('pending-quote-21').props.accessibilityState.checked).toBe(true);
    // Already folded: not a checkbox, and not taken by Select all.
    expect(getByTestId('pending-quote-12').props.accessibilityRole).toBe('button');
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 2 quotes into this review',
    );
    fireEvent.press(getByLabelText('Clear all'));
    expect(getByTestId('pending-quote-11').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('quote-fold-action').props.accessibilityState.disabled).toBe(true);
  });

  it('names the action exactly for one quote, and disables it (aria-disabled on the web) at zero', () => {
    asPlatform('web');
    const { getByTestId, getByLabelText, UNSAFE_getAllByType } = renderPanel({}, SHEET_WIDTH);
    fireEvent.press(getByLabelText('Select quotes'));
    const bar = () =>
      UNSAFE_getAllByType(TouchableOpacity).find((n) => n.props.testID === 'quote-fold-action');
    expect(bar()?.props.disabled).toBe(true);
    expect(bar()?.props['aria-disabled']).toBe(true);
    fireEvent.press(getByTestId('pending-quote-21'));
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
    expect(bar()?.props.disabled).toBe(false);
    expect(bar()?.props['aria-disabled']).toBe(false);
  });

  it.each([375, SIDE_PANE_BREAKPOINT])(
    'keeps the action outside the scroll at %ipx, so it never scrolls away',
    (width) => {
      const { getByTestId, getByLabelText } = renderPanel({}, width);
      fireEvent.press(getByLabelText('Select quotes'));
      expect(getByTestId('quote-fold-action')).toBeTruthy();
      expect(
        within(getByTestId('reflection-sources-scroll')).queryByTestId('quote-fold-action'),
      ).toBeNull();
    },
  );

  it('shows no action outside selection mode, and leaving the mode drops the selection', () => {
    const { getByTestId, getByLabelText, queryByTestId } = renderPanel();
    expect(queryByTestId('quote-fold-action')).toBeNull();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    fireEvent.press(getByLabelText('Cancel selection'));
    expect(queryByTestId('quote-fold-action')).toBeNull();
    fireEvent.press(getByLabelText('Select quotes'));
    expect(getByTestId('pending-quote-11').props.accessibilityState.checked).toBe(false);
  });

  it('folds the checked quotes as one batch, in the panel order, attributed as the panel does', async () => {
    const onInsertQuotes = allIncluded();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-21'));
    fireEvent.press(getByTestId('pending-quote-11'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    expect(onInsertQuotes).toHaveBeenCalledTimes(1);
    expect(onInsertQuotes).toHaveBeenCalledWith([
      { id: 11, anchorText: 'one', attribution: 'Monday' },
      { id: 21, anchorText: 'three', attribution: 'Tuesday' },
    ]);
    expect(getByTestId('pending-quote-11').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('pending-quote-21').props.accessibilityState.disabled).toBe(true);
  });

  it('leaves a failed quote checked and undimmed, and dims the rest', async () => {
    const onInsertQuotes = jest.fn<InsertMany>(() =>
      Promise.resolve({ included: [11], failed: [21], skipped: [] }),
    );
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    fireEvent.press(getByTestId('pending-quote-21'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    expect(getByTestId('pending-quote-11').props.accessibilityState.disabled).toBe(true);
    const failed = getByTestId('pending-quote-21');
    expect(failed.props.accessibilityState.disabled).toBeFalsy();
    expect(failed.props.accessibilityState.checked).toBe(true);
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
  });

  it('reverts every dim when the batch itself rejects, and keeps the selection', async () => {
    const onInsertQuotes = jest.fn<InsertMany>(() => Promise.reject(new Error('boom')));
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    expect(getByTestId('pending-quote-11').props.accessibilityState.disabled).toBeFalsy();
    expect(getByTestId('pending-quote-11').props.accessibilityState.checked).toBe(true);
  });

  it('keeps the selection when the window crosses the side-pane breakpoint', () => {
    const element = () => (
      <ReflectionSourcesPanel
        items={[S1, S2]}
        onInsertQuote={jest.fn()}
        onInsertQuotes={allIncluded()}
        onClose={jest.fn()}
      />
    );
    mockWidth(SIDE_PANE_BREAKPOINT + 40);
    const screen = render(element());
    fireEvent.press(screen.getByLabelText('Select quotes'));
    fireEvent.press(screen.getByTestId('pending-quote-12'));
    mockWidth(390);
    screen.rerender(element());
    expect(screen.getByTestId('reflection-sources-sheet')).toBeTruthy();
    expect(screen.getByTestId('pending-quote-12').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
  });
});

describe('ReflectionSourcesPanel -- the folded trace (#2885)', () => {
  it('shows a quote folded elsewhere as folded, distinct from checked, and says so in its name', () => {
    const { getByTestId } = renderPanel({ foldedIds: new Set([21]) });
    const folded = getByTestId('pending-quote-21');
    expect(folded.props.accessibilityState).toEqual({ disabled: true });
    expect(folded.props.accessibilityLabel).toBe(
      'Fold the quote "three" into your reflection — already in your review',
    );
    expect(getByTestId('pending-quote-21-check', { includeHiddenElements: true })).toBeTruthy();
  });
});

// Phase C review of #2885: a batch reconciles only its OWN quotes, and the bar
// cannot start a second batch while one is on the wire.
describe('ReflectionSourcesPanel -- a batch in flight (#2885)', () => {
  function deferredBatch() {
    let settle: (_r: BatchFoldResult) => void = () => {};
    const onInsertQuotes = jest.fn<InsertMany>(
      () =>
        new Promise<BatchFoldResult>((resolve) => {
          settle = resolve;
        }),
    );
    return { onInsertQuotes, settle: (r: BatchFoldResult) => settle(r) };
  }

  it('disables the bar while a batch is in flight, so a second press cannot wipe the retry', async () => {
    const batch = deferredBatch();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes: batch.onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    fireEvent.press(getByTestId('pending-quote-12'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    expect(getByTestId('quote-fold-action').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    expect(batch.onInsertQuotes).toHaveBeenCalledTimes(1);
    await act(async () => {
      batch.settle({ included: [11], failed: [12], skipped: [] });
    });
    expect(getByTestId('pending-quote-12').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
    expect(getByTestId('quote-fold-action').props.accessibilityState.disabled).toBe(false);
  });

  it('keeps a quote the writer checks while a batch is in flight', async () => {
    const batch = deferredBatch();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes: batch.onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    fireEvent.press(getByTestId('pending-quote-21'));
    await act(async () => {
      batch.settle({ included: [11], failed: [], skipped: [] });
    });
    expect(getByTestId('pending-quote-21').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
  });

  it('leaves the selection alone when a batch admitted nothing', async () => {
    const onInsertQuotes = jest.fn<InsertMany>(() =>
      Promise.resolve({ included: [], failed: [], skipped: [11, 12] }),
    );
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('pending-quote-11'));
    fireEvent.press(getByTestId('pending-quote-12'));
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });
    // Another act owns those quotes (and their dims); this batch took none, so
    // the writer's selection is exactly as they left it.
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 2 quotes into this review',
    );
  });
});
