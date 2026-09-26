import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import PromotedQuotesScreen, { PROMOTED_QUOTES_PAGE_SIZE } from '../PromotedQuotesScreen';

import type { PromotedQuoteListItem, PromotedQuoteListResponse } from '@/api';

/**
 * ``PromotedQuotesScreen`` (#2865) against a fake server that honours
 * ``offset`` / ``limit`` and deletes a row only when its DELETE resolves.
 *
 * These pin what the optimistic remove must not break while its request is
 * still in flight: the optimistic window itself, paging past it, a reload that
 * lands inside it, and a retry of a page that failed.
 */

interface ListParams {
  status: 'pending' | 'included';
  limit: number;
  offset: number;
}

const mockNavigate = jest.fn();
const mockListAll = jest.fn<(_p: ListParams) => Promise<PromotedQuoteListResponse>>();
const mockRemove = jest.fn<(_id: number) => Promise<void>>();
const mockPickerKeys: Array<number | undefined> = [];
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
    listAll: (params: ListParams) => mockListAll(params),
    remove: (id: number) => mockRemove(id),
  },
}));

jest.mock('../ReviewScopePicker', () => ({
  __esModule: true,
  default: ({ refreshKey }: { refreshKey?: number }) => {
    mockPickerKeys.push(refreshKey);
    return null;
  },
}));

const MINUTE_MS = 60_000;
const EPOCH = Date.UTC(2026, 0, 1);

/** Quote ``n``: a lower id is newer, so the server's order is simply by id. */
function row(n: number): PromotedQuoteListItem {
  return {
    id: n,
    source_entry_id: 7,
    anchor_start: 0,
    anchor_end: 5,
    anchor_text: `quote ${n}`,
    pending: true,
    stale: false,
    source_title: 'Rain',
    source_timestamp: '2026-01-01T00:00:00Z',
    included_in_entry_id: null,
    included_in_title: null,
    created_at: new Date(EPOCH - n * MINUTE_MS).toISOString(),
  };
}

let server: { pending: PromotedQuoteListItem[]; included: PromotedQuoteListItem[] };
let failPages: Set<number>;

function serveFromServer(): void {
  mockListAll.mockImplementation(({ status, limit, offset }) => {
    if (failPages.has(offset)) return Promise.reject(new Error('offline'));
    const rows = server[status];
    return Promise.resolve({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      has_more: offset + limit < rows.length,
    });
  });
}

/** A DELETE that settles only when the test says so; resolving it deletes the row. */
function deferRemove(): { succeed: () => Promise<void>; fail: () => Promise<void> } {
  let settle: (ok: boolean) => void = () => {};
  mockRemove.mockImplementation(
    (id) =>
      new Promise<void>((resolve, reject) => {
        settle = (ok) => {
          if (!ok) {
            reject(new Error('offline'));
            return;
          }
          server.pending = server.pending.filter((q) => q.id !== id);
          resolve();
        };
      }),
  );
  return {
    succeed: async () => act(async () => settle(true)),
    fail: async () => act(async () => settle(false)),
  };
}

function renderedIds(getAllByTestId: (_m: RegExp) => Array<{ props: { testID: string } }>) {
  return getAllByTestId(/^promoted-quote-\d+$/).map((node) =>
    Number(node.props.testID.replace('promoted-quote-', '')),
  );
}

async function confirmRemove(screen: ReturnType<typeof render>, id: number): Promise<void> {
  fireEvent.press(await screen.findByTestId(`promoted-quote-${id}-remove`));
  await act(async () => {
    fireEvent.press(screen.getByTestId(`promoted-quote-${id}-confirm-remove`));
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockListAll.mockReset();
  mockRemove.mockReset();
  mockPickerKeys.length = 0;
  mockFocusListener = null;
  failPages = new Set();
  server = { pending: [], included: [] };
  serveFromServer();
});

describe('the optimistic window', () => {
  it('drops the row and lowers the count while the DELETE is still pending', async () => {
    server.pending = [row(1), row(2), row(3)];
    const deferred = deferRemove();
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText('Waiting for your next review (3)');

    await confirmRemove(screen, 2);

    expect(mockRemove).toHaveBeenCalledWith(2);
    expect(screen.queryByTestId('promoted-quote-2')).toBeNull();
    expect(screen.getByText('Waiting for your next review (2)')).toBeTruthy();

    await deferred.succeed();
    expect(screen.queryByTestId('promoted-quote-2')).toBeNull();
    expect(screen.getByText('Waiting for your next review (2)')).toBeTruthy();
  });

  it('shows the row leave, then return to its place, when the DELETE is refused', async () => {
    server.pending = [row(1), row(2), row(3)];
    const deferred = deferRemove();
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText('Waiting for your next review (3)');

    await confirmRemove(screen, 2);
    expect(renderedIds(screen.getAllByTestId)).toEqual([1, 3]);

    await deferred.fail();
    expect(renderedIds(screen.getAllByTestId)).toEqual([1, 2, 3]);
    expect(screen.getByText('Waiting for your next review (3)')).toBeTruthy();
    expect(screen.getByTestId('promoted-quotes-remove-error')).toBeTruthy();
  });
});

describe('paging past a remove', () => {
  const ROWS = PROMOTED_QUOTES_PAGE_SIZE + 2;

  it('never pages from an offset the pending remove has shifted', async () => {
    server.pending = Array.from({ length: ROWS }, (_, i) => row(i + 1));
    const deferred = deferRemove();
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText(`Waiting for your next review (${ROWS})`);

    await confirmRemove(screen, 1);
    const pendingLoadMore = screen.getByTestId('promoted-quotes-pending-load-more');
    expect(pendingLoadMore.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    fireEvent.press(pendingLoadMore);
    await deferred.succeed();
    const loadMore = screen.queryByTestId('promoted-quotes-pending-load-more');
    if (loadMore !== null) {
      await act(async () => {
        fireEvent.press(loadMore);
      });
    }

    const offsets = mockListAll.mock.calls
      .map(([params]) => params)
      .filter((params) => params.status === 'pending' && params.offset > 0)
      .map((params) => params.offset);
    expect(offsets).toEqual([PROMOTED_QUOTES_PAGE_SIZE - 1]);
    await waitFor(() => expect(screen.queryByTestId(`promoted-quote-${ROWS}`)).toBeTruthy());
    const ids = renderedIds(screen.getAllByTestId);
    expect(ids).toEqual(Array.from({ length: ROWS - 1 }, (_, i) => i + 2));
  });

  it('shows a row the server repeats across pages only once', async () => {
    server.pending = Array.from({ length: ROWS }, (_, i) => row(i + 1));
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText(`Waiting for your next review (${ROWS})`);
    // Another device promoted a quote meanwhile: every row shifts down by one.
    server.pending = [row(0), ...server.pending];

    await act(async () => {
      fireEvent.press(screen.getByTestId('promoted-quotes-pending-load-more'));
    });

    await waitFor(() => expect(screen.queryByTestId(`promoted-quote-${ROWS}`)).toBeTruthy());
    const ids = renderedIds(screen.getAllByTestId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a reload landing inside a remove', () => {
  it('ends on the server truth when the DELETE then succeeds', async () => {
    server.pending = [row(1), row(2)];
    const deferred = deferRemove();
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText('Waiting for your next review (2)');
    act(() => mockFocusListener?.()); // the screen's first focus: no reload

    await confirmRemove(screen, 1);
    await act(async () => mockFocusListener?.()); // refocus while the DELETE is pending
    await deferred.succeed();

    await waitFor(() => expect(screen.queryByTestId('promoted-quote-1')).toBeNull());
    expect(renderedIds(screen.getAllByTestId)).toEqual([2]);
    expect(screen.getByText('Waiting for your next review (1)')).toBeTruthy();
  });

  it('ends on the server truth when the DELETE then fails', async () => {
    server.pending = [row(1), row(2)];
    const deferred = deferRemove();
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText('Waiting for your next review (2)');
    act(() => mockFocusListener?.());

    await confirmRemove(screen, 1);
    await act(async () => mockFocusListener?.());
    await deferred.fail();

    await waitFor(() => expect(renderedIds(screen.getAllByTestId)).toEqual([1, 2]));
    expect(screen.getByText('Waiting for your next review (2)')).toBeTruthy();
  });
});

describe('retrying an older page', () => {
  it('retries the page that failed and keeps the pages already read', async () => {
    const ROWS = PROMOTED_QUOTES_PAGE_SIZE + 2;
    server.pending = Array.from({ length: ROWS }, (_, i) => row(i + 1));
    failPages.add(PROMOTED_QUOTES_PAGE_SIZE);
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByText(`Waiting for your next review (${ROWS})`);

    await act(async () => {
      fireEvent.press(screen.getByTestId('promoted-quotes-pending-load-more'));
    });
    expect(await screen.findByTestId('promoted-quotes-pending-error')).toBeTruthy();

    failPages.clear();
    mockListAll.mockClear();
    await act(async () => {
      fireEvent.press(
        within(screen.getByTestId('promoted-quotes-pending-error')).getByText('Try again'),
      );
    });

    await waitFor(() => expect(screen.queryByTestId(`promoted-quote-${ROWS}`)).toBeTruthy());
    expect(mockListAll.mock.calls.map(([params]) => params.offset)).toEqual([
      PROMOTED_QUOTES_PAGE_SIZE,
    ]);
    expect(renderedIds(screen.getAllByTestId)).toHaveLength(ROWS);
  });
});

describe('the review picker', () => {
  it('re-reads the open review scopes each time the screen regains focus', async () => {
    server.pending = [row(1)];
    const screen = render(<PromotedQuotesScreen />);
    await screen.findByTestId('promoted-quote-1');
    const before = mockPickerKeys[mockPickerKeys.length - 1];

    act(() => mockFocusListener?.());
    await act(async () => mockFocusListener?.());

    const after = mockPickerKeys[mockPickerKeys.length - 1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});
