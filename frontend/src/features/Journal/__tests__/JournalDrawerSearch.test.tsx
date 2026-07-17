/* eslint-env jest */
// Fuzzy title search inside the Journal drawer, plus its confirm-gated body
// (message) search: a debounced DrawerSearch field renders a flat, ranked
// list of matches while a query is active, offers a deep-search confirm row
// whenever a query is active, and pressing that row pulls in every remaining
// older page before re-matching against each entry's message too.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';
import { TouchableOpacity, View } from 'react-native';

import type { JournalListResponse, JournalMessage } from '@/api';

const DEEP_SEARCH_LABEL = 'Search inside entries? This loads your older entries.';
const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

const { default: JournalDrawer, useJournalDrawerEntries } = require('../JournalDrawer');

const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

function entry(id: number, overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id,
    message: `Body of entry ${id}.`,
    sender: 'user',
    timestamp: ago(1),
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: `Entry ${id}`,
    status: 'finished',
    updated_at: ago(1),
    ...overrides,
  };
}

function page(items: JournalMessage[], hasMore = false): JournalListResponse {
  return { items, total: items.length, has_more: hasMore };
}

type GetByTestId = ReturnType<typeof render>['getByTestId'];

/** Type a query into the drawer search field and flush its 300ms debounce. */
async function typeQuery(getByTestId: GetByTestId, query: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(getByTestId('drawer-search-input'), query);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

interface DrawerHarnessProps {
  items: JournalMessage[];
  hasMore: boolean;
  onConfirmBodySearch?: () => void;
}

function renderDrawer(props: Partial<DrawerHarnessProps> = {}) {
  const onConfirmBodySearch = props.onConfirmBodySearch ?? jest.fn();
  const result = render(
    <JournalDrawer
      items={props.items ?? []}
      now={Date.now()}
      loading={false}
      error={false}
      hasMore={props.hasMore ?? false}
      onRowPress={jest.fn()}
      onNewEntry={jest.fn()}
      onLoadMore={jest.fn()}
      onRetry={jest.fn()}
      onConfirmBodySearch={onConfirmBodySearch}
    />,
  );
  return { ...result, onConfirmBodySearch };
}

describe('JournalDrawer search field placement and identity', () => {
  it('renders the search field below New entry and above the entry rows', () => {
    const items = [entry(1)];
    const { getAllByTestId } = renderDrawer({ items });
    const ids = getAllByTestId(
      /^(journal-drawer-new-entry|journal-drawer-search|journal-drawer-entry-\d+)$/,
    ).map((n) => n.props.testID as string);
    expect(ids[0]).toBe('journal-drawer-new-entry');
    expect(ids[1]).toBe('journal-drawer-search');
  });

  it('uses the journal-specific placeholder and accessibility label', () => {
    const { getByTestId } = renderDrawer({ items: [] });
    const input = getByTestId('drawer-search-input');
    expect(input.props.placeholder).toBe('Search entries...');
    expect(input.props.accessibilityLabel).toBe('Search entries');
  });
});

describe('JournalDrawer fuzzy title search', () => {
  it('matches a title with a typo and hides the recency headings while the query is active', async () => {
    const items = [entry(1, { title: 'Gratitude' }), entry(2, { title: 'Morning pages' })];
    const { getByTestId, queryByTestId, queryByText } = renderDrawer({ items });

    await typeQuery(getByTestId, 'gratitde');

    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
    expect(queryByTestId('journal-drawer-entry-2')).toBeNull();
    expect(queryByText('This week')).toBeNull();
  });

  it('shows the singular result caption for exactly one title match', async () => {
    const items = [entry(1, { title: 'Gratitude' }), entry(2, { title: 'Morning pages' })];
    const { getByTestId } = renderDrawer({ items });

    await typeQuery(getByTestId, 'gratitde');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('1 result');
  });

  it('shows the plural result caption for multiple title matches', async () => {
    const items = [entry(1, { title: 'Morning ritual' }), entry(2, { title: 'Morning pages' })];
    const { getByTestId } = renderDrawer({ items });

    await typeQuery(getByTestId, 'morning');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('2 results');
  });

  it('shows "No results" when nothing matches by title or body', async () => {
    const items = [entry(1, { title: 'Gratitude', message: 'A quiet morning.' })];
    const { getByTestId } = renderDrawer({ items });

    await typeQuery(getByTestId, 'xylophone');

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('No results');
  });

  it('matches a null-titled entry by the word "untitled"', async () => {
    const items = [entry(1, { title: null })];
    const { getByTestId } = renderDrawer({ items });

    await typeQuery(getByTestId, 'untitled');

    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
  });

  it('hides the load-more row while a query is active even when hasMore is true', async () => {
    const items = [entry(1, { title: 'Gratitude' })];
    const { getByTestId, queryByTestId } = renderDrawer({ items, hasMore: true });
    expect(getByTestId('journal-drawer-load-more')).toBeTruthy();

    await typeQuery(getByTestId, 'gratitude');

    expect(queryByTestId('journal-drawer-load-more')).toBeNull();
  });

  it('restores grouped recency sections, the load-more row, and hides the caption once the query is cleared', async () => {
    const items = [entry(1, { title: 'Gratitude', timestamp: ago(1) })];
    const { getByTestId, queryByTestId, getByText } = renderDrawer({ items, hasMore: true });

    await typeQuery(getByTestId, 'gratitude');
    expect(queryByTestId('journal-drawer-load-more')).toBeNull();

    await typeQuery(getByTestId, '');

    expect(getByText('This week')).toBeTruthy();
    expect(getByTestId('journal-drawer-load-more')).toBeTruthy();
    expect(queryByTestId('drawer-search-result-count')).toBeNull();
  });
});

describe('JournalDrawer confirm-gated body search', () => {
  function bodyOnlyItems(): JournalMessage[] {
    return [
      entry(1, { title: 'Gratitude', message: 'Nothing about the secret word here.' }),
      entry(2, { title: 'Morning pages', message: 'The lighthouse kept the ships safe.' }),
    ];
  }

  it('leaves a body-only match absent from title-only results', async () => {
    const { getByTestId, queryByTestId } = renderDrawer({ items: bodyOnlyItems() });

    await typeQuery(getByTestId, 'lighthouse');

    expect(queryByTestId('journal-drawer-entry-2')).toBeNull();
  });

  it('offers the deep-search confirm row with the exact copy once a query is active', async () => {
    const { getByTestId, getByText } = renderDrawer({ items: bodyOnlyItems() });

    await typeQuery(getByTestId, 'lighthouse');

    expect(getByTestId('drawer-search-deep-search')).toBeTruthy();
    expect(getByText(DEEP_SEARCH_LABEL)).toBeTruthy();
  });

  it('fires onConfirmBodySearch exactly once, reveals the body match, and removes the confirm row', async () => {
    const { getByTestId, queryByTestId, onConfirmBodySearch } = renderDrawer({
      items: bodyOnlyItems(),
    });

    await typeQuery(getByTestId, 'lighthouse');
    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(onConfirmBodySearch).toHaveBeenCalledTimes(1);
    expect(getByTestId('journal-drawer-entry-2')).toBeTruthy();
    expect(queryByTestId('drawer-search-deep-search')).toBeNull();
  });

  it('resets body search on a cleared query, so a new query is title-only until re-confirmed', async () => {
    const { getByTestId, queryByTestId } = renderDrawer({ items: bodyOnlyItems() });

    await typeQuery(getByTestId, 'lighthouse');
    fireEvent.press(getByTestId('drawer-search-deep-search'));
    expect(getByTestId('journal-drawer-entry-2')).toBeTruthy();

    await typeQuery(getByTestId, '');
    await typeQuery(getByTestId, 'lighthouse');

    expect(queryByTestId('journal-drawer-entry-2')).toBeNull();
    expect(getByTestId('drawer-search-deep-search')).toBeTruthy();
  });
});

// Wiring: the hook drives the confirm-gated fetch of every remaining older
// page, mounted the same way the presentational-harness tests above mount it
// (isOpen gates the panel), so the cache/offset semantics are exercised
// end-to-end without navigation.
function Harness(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const { items, loading, error, hasMore, loadMore, retry, confirmBodySearch } =
    useJournalDrawerEntries(isOpen);
  return (
    <View>
      <TouchableOpacity testID="harness-open" onPress={() => setIsOpen(true)} />
      {isOpen ? (
        <JournalDrawer
          items={items}
          now={Date.now()}
          loading={loading}
          error={error}
          hasMore={hasMore}
          onRowPress={() => undefined}
          onNewEntry={() => undefined}
          onLoadMore={loadMore}
          onRetry={retry}
          onConfirmBodySearch={confirmBodySearch}
        />
      ) : null}
    </View>
  );
}

async function openHarness(getByTestId: GetByTestId): Promise<void> {
  await act(async () => {
    fireEvent.press(getByTestId('harness-open'));
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('useJournalDrawerEntries confirm-gated body search (wiring)', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('fetches no page while the user is only typing a title query', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => entry(i + 1));
    mockList.mockResolvedValue(page(firstPage, true));
    const { getByTestId } = render(<Harness />);

    await openHarness(getByTestId);
    expect(mockList).toHaveBeenCalledTimes(1);

    await typeQuery(getByTestId, 'entry');

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('fetches every remaining page from offset 20 onward when confirmed, then reveals the body match', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => entry(i + 1));
    const secondPage = [entry(21, { title: 'Second page' })];
    const thirdPage = [
      entry(22, { title: 'Third page', message: 'A hidden lighthouse keeps watch.' }),
    ];
    mockList.mockResolvedValueOnce(page(firstPage, true));
    mockList.mockResolvedValueOnce(page(secondPage, true));
    mockList.mockResolvedValueOnce(page(thirdPage, false));

    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    const offsets = mockList.mock.calls.map((call) => (call[0] as { offset: number }).offset);
    expect(offsets).toEqual([0, PAGE_SIZE, PAGE_SIZE + 1]);
    expect(getByTestId('journal-drawer-entry-22')).toBeTruthy();
  });

  it('makes no further network call when confirmed with no remaining pages, but still enables body matching', async () => {
    const items = [entry(1, { title: 'Gratitude', message: 'A hidden lighthouse keeps watch.' })];
    mockList.mockResolvedValueOnce(page(items, false));

    const { getByTestId, queryByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    expect(mockList).toHaveBeenCalledTimes(1);

    await typeQuery(getByTestId, 'lighthouse');
    expect(queryByTestId('journal-drawer-entry-1')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
  });

  it('surfaces the error state when a confirmed page sweep fails mid-way', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => entry(i + 1));
    mockList.mockResolvedValueOnce(page(firstPage, true));
    mockList.mockRejectedValueOnce(new Error('network down'));

    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    await typeQuery(getByTestId, '');
    expect(getByTestId('journal-drawer-error')).toBeTruthy();
  });

  it('stops the sweep when a page comes back empty despite reporting more', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => entry(i + 1));
    mockList.mockResolvedValueOnce(page(firstPage, true));
    mockList.mockResolvedValueOnce(page([], true));

    const { getByTestId } = render(<Harness />);
    await openHarness(getByTestId);
    await typeQuery(getByTestId, 'lighthouse');

    await act(async () => {
      fireEvent.press(getByTestId('drawer-search-deep-search'));
      await jest.advanceTimersByTimeAsync(0);
    });

    // The empty page halts the loop rather than looping forever on has_more.
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});
