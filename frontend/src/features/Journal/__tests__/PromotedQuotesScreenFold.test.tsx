// The Promoted quotes screen's multi-select (#2885). Opened from a review being
// written, it hands the checked quotes back to THAT review; opened anywhere
// else, it can only carry them into a review the writer picks.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import type { Text as RNText, TouchableOpacity as RNTouchableOpacity } from 'react-native';

import PromotedQuotesScreen from '../PromotedQuotesScreen';
import { sourceAttribution } from '../reflectionCopy';

import type { PromotedQuoteListItem, PromotedQuoteListResponse } from '@/api';
import { usePromotedQuoteHandoffStore } from '@/store/usePromotedQuoteHandoffStore';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockListAll = jest.fn<(_p: unknown) => Promise<PromotedQuoteListResponse>>();
let mockChosen: Record<string, unknown> = {};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
    addListener: () => () => {},
  }),
}));

jest.mock('@/api', () => ({
  promotions: {
    listAll: (params: unknown) => mockListAll(params),
    remove: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../ReviewScopePicker', () => {
  const { Text: MockText, TouchableOpacity: MockTouchable } = jest.requireActual<{
    Text: typeof RNText;
    TouchableOpacity: typeof RNTouchableOpacity;
  }>('react-native');
  return {
    __esModule: true,
    default: ({
      enabled,
      onChoose,
    }: {
      enabled: boolean;
      onChoose: (_p: Record<string, unknown>) => void;
    }) =>
      enabled ? (
        <MockTouchable testID="mock-review-scope" onPress={() => onChoose(mockChosen)}>
          <MockText>week</MockText>
        </MockTouchable>
      ) : null,
  };
});

function item(overrides: Partial<PromotedQuoteListItem> = {}): PromotedQuoteListItem {
  return {
    id: 1,
    source_entry_id: 7,
    anchor_start: 4,
    anchor_end: 21,
    anchor_text: 'the anger was grief',
    pending: true,
    stale: false,
    source_title: 'Rain',
    source_timestamp: '2026-03-01T12:00:00Z',
    included_in_entry_id: null,
    included_in_title: null,
    created_at: '2026-03-02T09:00:00Z',
    ...overrides,
  };
}

// Displayed newest-promoted first, as the server orders them. Folded in the
// order the passages sit: the older source first, then by place in the source.
const LATE_IN_OLD = item({
  id: 11,
  anchor_start: 40,
  anchor_text: 'late',
  created_at: '2026-03-09T00:00:00Z',
});
const EARLY_IN_OLD = item({
  id: 12,
  anchor_start: 2,
  anchor_text: 'early',
  created_at: '2026-03-05T00:00:00Z',
});
const NEWER_SOURCE = item({
  id: 13,
  anchor_start: 0,
  anchor_text: 'newer',
  source_title: '  ',
  source_timestamp: '2026-03-04T12:00:00Z',
  created_at: '2026-03-03T00:00:00Z',
});
const USED = item({ id: 2, pending: false, included_in_entry_id: 30, included_in_title: 'Week 2' });

function serve(pending: PromotedQuoteListItem[], total = pending.length, hasMore = false): void {
  mockListAll.mockImplementation((params) =>
    Promise.resolve(
      (params as { status: string }).status === 'pending'
        ? { items: pending, total, has_more: hasMore }
        : { items: [USED], total: 1, has_more: false },
    ),
  );
}

async function renderScreen(injectInto?: string) {
  const route = {
    key: 'pq',
    name: 'PromotedQuotes' as const,
    params: injectInto == null ? undefined : { injectInto },
  };
  const screen = render(<PromotedQuotesScreen route={route} />);
  await act(async () => {
    await Promise.resolve();
  });
  return screen;
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockGoBack.mockReset();
  mockListAll.mockReset();
  mockChosen = {
    reflectionLevel: 'week',
    reflectionScopeKey: 'c1:w2',
    prefillTitle: 'Weekly Review — Week 2',
  };
  act(() => usePromotedQuoteHandoffStore.getState().clear());
});

describe('PromotedQuotesScreen -- selecting quotes (#2885)', () => {
  it('turns the pending rows into checkboxes, and a press checks one instead of opening it', async () => {
    serve([LATE_IN_OLD, EARLY_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    const row = getByTestId('promoted-quote-11');
    expect(row.props.accessibilityRole).toBe('checkbox');
    fireEvent.press(row);
    expect(getByTestId('promoted-quote-11').props.accessibilityState.checked).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
    // A used quote is not selectable.
    expect(getByTestId('promoted-quote-2').props.accessibilityRole).toBe('button');
  });

  it('still opens the passage on a row press outside selection mode', async () => {
    serve([LATE_IN_OLD]);
    const { getByTestId } = await renderScreen('quotes-1');
    fireEvent.press(getByTestId('promoted-quote-11'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      entryId: 7,
      highlightSpan: { start: 40, end: 21 },
    });
  });

  it('selects only the loaded rows, and says so in visible text while older quotes remain', async () => {
    serve([LATE_IN_OLD, EARLY_IN_OLD], 9, true);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    expect(getByTestId('promoted-quotes-pending-select-all-note').props.children).toBe(
      'Select all checks the quotes shown here. Older quotes join in once you load them.',
    );
    fireEvent.press(getByLabelText('Select all'));
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Write a review with 2 quotes',
    );
    fireEvent.press(getByLabelText('Clear all'));
    expect(getByTestId('quote-fold-action').props.accessibilityState.disabled).toBe(true);
  });

  it('says nothing about loaded rows when every pending quote is already loaded', async () => {
    serve([LATE_IN_OLD]);
    const { getByLabelText, queryByTestId } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    expect(queryByTestId('promoted-quotes-pending-select-all-note')).toBeNull();
  });

  it('keeps the action in the footer, outside the scroll', async () => {
    serve([LATE_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    expect(
      within(getByTestId('screen-scaffold-footer')).getByTestId('quote-fold-action'),
    ).toBeTruthy();
    expect(
      within(getByTestId('promoted-quotes-screen')).queryByTestId('quote-fold-action'),
    ).toBeNull();
  });
});

describe('PromotedQuotesScreen -- a removed quote leaves the selection (#2885)', () => {
  it('unchecks a quote the writer removes, so it can never be folded from a stale box', async () => {
    serve([LATE_IN_OLD, EARLY_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen('quotes-2');
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('promoted-quote-11'));
    fireEvent.press(getByTestId('promoted-quote-12'));
    fireEvent.press(getByTestId('promoted-quote-11-remove'));
    await act(async () => {
      fireEvent.press(getByTestId('promoted-quote-11-confirm-remove'));
    });
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 1 quote into this review',
    );
    fireEvent.press(getByTestId('quote-fold-action'));
    expect(usePromotedQuoteHandoffStore.getState().pending?.candidates.map((c) => c.id)).toEqual([
      12,
    ]);
  });
});

describe('PromotedQuotesScreen -- folding into the review it was opened from (#2885)', () => {
  it('offers no fold-in without a hand-off token', async () => {
    serve([LATE_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('promoted-quote-11'));
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Write a review with 1 quote',
    );
  });

  it('hands the checked quotes back under the token, in passage order, and goes back', async () => {
    serve([LATE_IN_OLD, EARLY_IN_OLD, NEWER_SOURCE]);
    const { getByTestId, getByLabelText } = await renderScreen('quotes-4');
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByLabelText('Select all'));
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 3 quotes into this review',
    );
    fireEvent.press(getByTestId('quote-fold-action'));
    const pending = usePromotedQuoteHandoffStore.getState().pending;
    expect(pending?.token).toBe('quotes-4');
    expect(pending?.candidates).toEqual([
      { id: 12, anchorText: 'early', attribution: 'Rain' },
      { id: 11, anchorText: 'late', attribution: 'Rain' },
      {
        id: 13,
        anchorText: 'newer',
        // Byte-identical to what the sources panel would write for this source.
        attribution: sourceAttribution({
          kind: 'entry',
          id: 7,
          title: '  ',
          timestamp: '2026-03-04T12:00:00Z',
          body: '',
          reflection_level: null,
          promoted_quotes: [],
        }),
      },
    ]);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('PromotedQuotesScreen -- carrying quotes into a new review (#2885)', () => {
  it('opens the picker from the action and opens the chosen review carrying only a token', async () => {
    serve([LATE_IN_OLD, EARLY_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('promoted-quote-11'));
    fireEvent.press(getByTestId('quote-fold-action'));
    fireEvent.press(within(getByTestId('screen-scaffold-footer')).getByTestId('mock-review-scope'));
    const pending = usePromotedQuoteHandoffStore.getState().pending;
    expect(pending?.candidates.map((c) => c.id)).toEqual([11]);
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      reflectionLevel: 'week',
      reflectionScopeKey: 'c1:w2',
      prefillTitle: 'Weekly Review — Week 2',
      injectQuotes: pending?.token,
    });
    expect(JSON.stringify(mockNavigate.mock.calls)).not.toContain('late');
  });

  it('carries the token into a review being continued, too', async () => {
    mockChosen = { entryId: 55 };
    serve([LATE_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('promoted-quote-11'));
    fireEvent.press(getByTestId('quote-fold-action'));
    fireEvent.press(getByTestId('mock-review-scope'));
    const token = usePromotedQuoteHandoffStore.getState().pending?.token;
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 55, injectQuotes: token });
  });

  it('opens a review without quotes from the plain Write a review button', async () => {
    serve([LATE_IN_OLD]);
    const { getByTestId, getByLabelText } = await renderScreen();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('promoted-quote-11'));
    fireEvent.press(getByTestId('promoted-quotes-write-review'));
    fireEvent.press(getByTestId('mock-review-scope'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', mockChosen);
    expect(usePromotedQuoteHandoffStore.getState().pending).toBeNull();
  });
});
