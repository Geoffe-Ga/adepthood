import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { Text as RNText, TouchableOpacity as RNTouchableOpacity } from 'react-native';

import PromotedQuotesScreen, {
  EMPTY_COPY,
  PROMOTED_QUOTES_PAGE_SIZE,
  reinsertByCreatedDesc,
} from '../PromotedQuotesScreen';

import type { PromotedQuoteListItem, PromotedQuoteListResponse } from '@/api';

/**
 * ``PromotedQuotesScreen`` (#2865) — every quote the writer has promoted, found
 * on any day rather than only inside the review composer.
 *
 * The screen reads each section on its own (pending, then included) so each
 * header's count is the server's total for that section, not the length of
 * whatever page happens to be loaded.
 */

const mockNavigate = jest.fn();
const mockListAll = jest.fn<(_p: unknown) => Promise<PromotedQuoteListResponse>>();
const mockRemove = jest.fn<(_id: number) => Promise<void>>();
let mockFocusListener: (() => void) | null = null;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    addListener: (_event: string, listener: () => void) => {
      mockFocusListener = listener;
      return () => {
        mockFocusListener = null;
      };
    },
  }),
}));

jest.mock('@/api', () => ({
  promotions: {
    listAll: (params: unknown) => mockListAll(params),
    remove: (id: number) => mockRemove(id),
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
        <MockTouchable
          testID="mock-review-scope"
          onPress={() => onChoose({ reflectionLevel: 'week', reflectionScopeKey: 'c1:w2' })}
        >
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

function page(items: PromotedQuoteListItem[], total = items.length, hasMore = false) {
  return { items, total, has_more: hasMore };
}

const WAITING = item({ id: 1 });
const USED = item({
  id: 2,
  anchor_text: 'the river kept its counsel',
  pending: false,
  source_title: null,
  included_in_entry_id: 30,
  included_in_title: 'The windy week',
});

/** Route each section's read to its own fixture, keyed by the status asked for. */
function serve(
  pending: PromotedQuoteListResponse | Error,
  included: PromotedQuoteListResponse | Error,
): void {
  mockListAll.mockImplementation((params) => {
    const answer = (params as { status: string }).status === 'pending' ? pending : included;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockListAll.mockReset();
  mockRemove.mockReset();
  mockFocusListener = null;
});

describe('PromotedQuotesScreen sections', () => {
  it('reads each section by status and heads it with the server total', async () => {
    serve(page([WAITING], 3, true), page([USED], 12));
    const { findByText, getByText, getAllByRole } = render(<PromotedQuotesScreen />);

    // Strictly true: a pending quote surfaces in a review covering the week it
    // was written (GET /reflections/sources), not in whichever review is next.
    expect(await findByText('Not yet in a review (3)')).toBeTruthy();
    expect(getByText('Used in a review (12)')).toBeTruthy();
    // The screen's own title is a header too; the two sections follow it, in order.
    const headers = getAllByRole('header').map((node) => node.props.children);
    expect(headers.slice(-2)).toEqual(['Not yet in a review (3)', 'Used in a review (12)']);
    expect(mockListAll).toHaveBeenCalledWith({
      status: 'pending',
      limit: PROMOTED_QUOTES_PAGE_SIZE,
      offset: 0,
    });
    expect(mockListAll).toHaveBeenCalledWith({
      status: 'included',
      limit: PROMOTED_QUOTES_PAGE_SIZE,
      offset: 0,
    });
  });

  it('shows each quote verbatim with its source, and a used quote with its review', async () => {
    serve(page([WAITING]), page([USED]));
    const { findByTestId, getByTestId, getByText } = render(<PromotedQuotesScreen />);

    const waiting = await findByTestId('promoted-quote-1');
    expect(getByText('the anger was grief')).toBeTruthy();
    expect(getByTestId('promoted-quote-1-caption').props.children).toBe('Rain');
    expect(waiting.props.accessibilityRole).toBe('button');
    expect(waiting.props.accessibilityLabel).toBe('“the anger was grief” from Rain');

    // An untitled source falls back to its date; a used quote names its review.
    const usedCaption = getByTestId('promoted-quote-2-caption').props.children as string;
    expect(usedCaption).toMatch(/^Mar 1, 2026 · In The windy week$/);
    expect(getByTestId('promoted-quote-2').props.accessibilityLabel).toMatch(
      /^“the river kept its counsel” from Mar 1, 2026, used in The windy week$/,
    );
  });

  it('says "Used in a review" when the review it went into was deleted', async () => {
    serve(page([]), page([item({ ...USED, included_in_title: null })]));
    const { findByTestId } = render(<PromotedQuotesScreen />);

    const caption = await findByTestId('promoted-quote-2-caption');
    expect(caption.props.children).toMatch(/ · Used in a review$/);
    expect(caption.props.children).not.toMatch(/null/);
  });

  it('notes a quote whose passage was since edited away', async () => {
    serve(page([item({ stale: true })]), page([]));
    const { findByTestId } = render(<PromotedQuotesScreen />);

    expect((await findByTestId('promoted-quote-1-caption')).props.children).toBe(
      'Rain · Passage since edited',
    );
    // Label-in-name: what the row visibly says is part of what it is called.
    expect((await findByTestId('promoted-quote-1')).props.accessibilityLabel).toBe(
      '“the anger was grief” from Rain. Passage since edited',
    );
  });

  it('opens the source entry at the quote', async () => {
    serve(page([WAITING]), page([]));
    const { findByTestId } = render(<PromotedQuotesScreen />);

    fireEvent.press(await findByTestId('promoted-quote-1'));

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      entryId: 7,
      highlightSpan: { start: 4, end: 21 },
    });
  });

  it('shows the exact empty copy once both sections settle empty', async () => {
    serve(page([]), page([]));
    const { findByText, queryByText } = render(<PromotedQuotesScreen />);

    expect(await findByText(EMPTY_COPY)).toBeTruthy();
    expect(EMPTY_COPY).toBe(
      'Nothing promoted yet. While reading an entry, tap Promote a quote to carry a passage forward.',
    );
    expect(queryByText(/^Not yet in a review/)).toBeNull();
    expect(queryByText(/^Used in a review/)).toBeNull();
  });

  it('pages a section on its own, appending older quotes under the same header', async () => {
    const older = item({ id: 5, anchor_text: 'older words', created_at: '2026-02-01T00:00:00Z' });
    mockListAll.mockImplementation((params) => {
      const { status, offset } = params as { status: string; offset: number };
      if (status === 'included') return Promise.resolve(page([]));
      return Promise.resolve(offset === 0 ? page([WAITING], 2, true) : page([older], 2, false));
    });
    const { findByTestId, getByTestId, queryByTestId } = render(<PromotedQuotesScreen />);

    fireEvent.press(await findByTestId('promoted-quotes-pending-load-more'));

    await waitFor(() => expect(getByTestId('promoted-quote-5')).toBeTruthy());
    expect(mockListAll).toHaveBeenCalledWith({
      status: 'pending',
      limit: PROMOTED_QUOTES_PAGE_SIZE,
      offset: 1,
    });
    expect(queryByTestId('promoted-quotes-pending-load-more')).toBeNull();
  });
});

describe('PromotedQuotesScreen failure', () => {
  it('says so honestly with a retry, never a blank screen', async () => {
    serve(new Error('offline'), new Error('offline'));
    const { findByTestId, findByText, getByText } = render(<PromotedQuotesScreen />);

    expect(await findByTestId('promoted-quotes-error')).toBeTruthy();
    expect(getByText('We could not reach your promoted quotes.')).toBeTruthy();

    serve(page([WAITING]), page([]));
    fireEvent.press(getByText('Try again'));

    expect(await findByText('Not yet in a review (1)')).toBeTruthy();
  });

  it('keeps a section that loaded when only the other failed', async () => {
    serve(page([WAITING]), new Error('offline'));
    const { findByText, getByTestId } = render(<PromotedQuotesScreen />);

    expect(await findByText('Not yet in a review (1)')).toBeTruthy();
    expect(getByTestId('promoted-quotes-included-error')).toBeTruthy();
  });
});

describe('PromotedQuotesScreen remove', () => {
  it('asks first, then removes the quote and lowers the count', async () => {
    mockRemove.mockResolvedValue(undefined);
    serve(page([WAITING, item({ id: 3, anchor_text: 'third' })]), page([]));
    const { findByTestId, getByTestId, queryByTestId, getByText } = render(
      <PromotedQuotesScreen />,
    );

    fireEvent.press(await findByTestId('promoted-quote-1-remove'));
    expect(mockRemove).not.toHaveBeenCalled();
    expect(getByTestId('promoted-quote-1-confirm')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('promoted-quote-1-confirm-remove'));
    });

    expect(mockRemove).toHaveBeenCalledWith(1);
    expect(queryByTestId('promoted-quote-1')).toBeNull();
    expect(getByText('Not yet in a review (1)')).toBeTruthy();
  });

  it('keeps the quote when the writer changes their mind', async () => {
    serve(page([WAITING]), page([]));
    const { findByTestId, getByTestId, queryByTestId } = render(<PromotedQuotesScreen />);

    fireEvent.press(await findByTestId('promoted-quote-1-remove'));
    fireEvent.press(getByTestId('promoted-quote-1-confirm-keep'));

    expect(queryByTestId('promoted-quote-1-confirm')).toBeNull();
    expect(getByTestId('promoted-quote-1')).toBeTruthy();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('puts a quote back in its place, with its count, when the remove fails', async () => {
    mockRemove.mockRejectedValue(new Error('offline'));
    const first = item({ id: 1, created_at: '2026-03-03T00:00:00Z' });
    const middle = item({ id: 2, anchor_text: 'middle', created_at: '2026-03-02T00:00:00Z' });
    const last = item({ id: 3, anchor_text: 'last', created_at: '2026-03-01T00:00:00Z' });
    serve(page([first, middle, last]), page([]));
    const { findByTestId, getByTestId, getByText, getAllByTestId } = render(
      <PromotedQuotesScreen />,
    );

    fireEvent.press(await findByTestId('promoted-quote-2-remove'));
    await act(async () => {
      fireEvent.press(getByTestId('promoted-quote-2-confirm-remove'));
    });

    const order = getAllByTestId(/^promoted-quote-\d+$/).map((node) => node.props.testID);
    expect(order).toEqual(['promoted-quote-1', 'promoted-quote-2', 'promoted-quote-3']);
    expect(getByText('Not yet in a review (3)')).toBeTruthy();
    expect(getByTestId('promoted-quotes-remove-error')).toBeTruthy();
  });
});

describe('PromotedQuotesScreen write a review', () => {
  it('opens the review picker and follows the chosen review', async () => {
    serve(page([WAITING]), page([]));
    const { findByTestId, getByTestId, queryByTestId } = render(<PromotedQuotesScreen />);
    await findByTestId('promoted-quote-1');

    expect(queryByTestId('mock-review-scope')).toBeNull();
    fireEvent.press(getByTestId('promoted-quotes-write-review'));
    fireEvent.press(getByTestId('mock-review-scope'));

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      reflectionLevel: 'week',
      reflectionScopeKey: 'c1:w2',
    });
  });
});

describe('PromotedQuotesScreen refocus', () => {
  it('re-reads both sections when the screen regains focus, not on the first focus', async () => {
    serve(page([WAITING]), page([]));
    const { findByTestId } = render(<PromotedQuotesScreen />);
    await findByTestId('promoted-quote-1');
    const initialReads = mockListAll.mock.calls.length;

    act(() => mockFocusListener?.());
    expect(mockListAll.mock.calls.length).toBe(initialReads);

    serve(page([WAITING, item({ id: 9, anchor_text: 'new' })]), page([]));
    await act(async () => mockFocusListener?.());

    await waitFor(() => expect(mockListAll.mock.calls.length).toBe(initialReads + 2));
    expect(await findByTestId('promoted-quote-9')).toBeTruthy();
  });
});

describe('reinsertByCreatedDesc', () => {
  const a = item({ id: 1, created_at: '2026-03-03T00:00:00Z' });
  const b = item({ id: 2, created_at: '2026-03-02T00:00:00Z' });
  const c = item({ id: 3, created_at: '2026-03-01T00:00:00Z' });

  it('restores a row to its created_at-desc place', () => {
    expect(reinsertByCreatedDesc([a, c], b).map((q) => q.id)).toEqual([1, 2, 3]);
    expect(reinsertByCreatedDesc([b, c], a).map((q) => q.id)).toEqual([1, 2, 3]);
    expect(reinsertByCreatedDesc([a, b], c).map((q) => q.id)).toEqual([1, 2, 3]);
  });

  it('breaks a created_at tie by id, newest id first, as the server does', () => {
    const twin = item({ id: 4, created_at: b.created_at });
    expect(reinsertByCreatedDesc([a, b, c], twin).map((q) => q.id)).toEqual([1, 4, 2, 3]);
  });

  it('never duplicates a row that is already present', () => {
    expect(reinsertByCreatedDesc([a, b], b).map((q) => q.id)).toEqual([1, 2]);
  });
});
