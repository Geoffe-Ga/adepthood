/* eslint-env jest */
// The Journal header-drawer body: a New-entry row on top, then past entries
// grouped by recency (newest-first, empty sections dropped), a tappable
// "Load older entries" row, and loading/error+retry states. Entries are
// fetched lazily on first open via the co-located useJournalDrawerEntries
// hook, which lives above the ScreenDrawer panel so its cache survives
// close/reopen (mirrors useCourseDrawerContent in Course/CourseDrawer.tsx).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SquarePen } from 'lucide-react-native';
import React, { useState } from 'react';
import { TouchableOpacity, View } from 'react-native';

import type { JournalListResponse, JournalMessage } from '@/api';
import { ink } from '@/design/tokens';

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

// Mirrors JournalShelfScreen's formatDate exactly, so the assertions below pin
// the drawer's date text without hardcoding a locale-specific literal.
function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface DrawerHarness {
  items: JournalMessage[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  currentEntryId?: number | null;
  onRowPress?: (_id: number) => void;
  onNewEntry?: () => void;
  onPhotograph?: () => void;
}

function renderDrawer(props: Partial<DrawerHarness> = {}) {
  const onRowPress = props.onRowPress ?? jest.fn();
  const onNewEntry = props.onNewEntry ?? jest.fn();
  const onLoadMore = jest.fn();
  const onRetry = jest.fn();
  const onConfirmBodySearch = jest.fn();
  const result = render(
    <JournalDrawer
      items={props.items ?? []}
      now={Date.now()}
      loading={props.loading ?? false}
      error={props.error ?? false}
      hasMore={props.hasMore ?? false}
      currentEntryId={props.currentEntryId}
      onRowPress={onRowPress}
      onNewEntry={onNewEntry}
      onPhotograph={props.onPhotograph}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onConfirmBodySearch={onConfirmBodySearch}
    />,
  );
  return { ...result, onRowPress, onNewEntry, onLoadMore, onRetry, onConfirmBodySearch };
}

describe('JournalDrawer (presentational)', () => {
  it('groups entries under recency headings and drops empty sections', () => {
    const items = [
      entry(1, { timestamp: ago(1) }), // This week
      entry(2, { timestamp: ago(10) }), // This month
      entry(3, { timestamp: ago(60) }), // Earlier
    ];
    const { getByText } = renderDrawer({ items });
    expect(getByText('This week')).toBeTruthy();
    expect(getByText('This month')).toBeTruthy();
    expect(getByText('Earlier')).toBeTruthy();
  });

  it('drops a recency heading with no entries in it', () => {
    const items = [entry(1, { timestamp: ago(1) })];
    const { queryByText } = renderDrawer({ items });
    expect(queryByText('This month')).toBeNull();
    expect(queryByText('Earlier')).toBeNull();
  });

  it('renders entry rows in the order they are given (newest-first)', () => {
    const items = [entry(3), entry(2), entry(1)];
    const { getAllByTestId } = renderDrawer({ items });
    const ids = getAllByTestId(/^journal-drawer-entry-\d+$/).map((n) => n.props.testID as string);
    expect(ids).toEqual([
      'journal-drawer-entry-3',
      'journal-drawer-entry-2',
      'journal-drawer-entry-1',
    ]);
  });

  it('falls back to "Untitled" for a blank title', () => {
    const items = [entry(1, { title: null })];
    const { getByText } = renderDrawer({ items });
    expect(getByText('Untitled')).toBeTruthy();
  });

  it('gives an untitled row an accessibility label containing "Untitled" and its date', () => {
    const ts = ago(1);
    const items = [entry(1, { title: null, timestamp: ts })];
    const { getByTestId } = renderDrawer({ items });
    const label = String(getByTestId('journal-drawer-entry-1').props.accessibilityLabel ?? '');
    expect(label).toContain('Untitled');
    expect(label).toContain(formatDate(ts));
  });

  it('gives a titled row an accessibility label containing both the title and its date', () => {
    const ts = ago(1);
    const items = [entry(1, { title: 'Morning pages', timestamp: ts })];
    const { getByTestId } = renderDrawer({ items });
    const label = String(getByTestId('journal-drawer-entry-1').props.accessibilityLabel ?? '');
    expect(label).toContain('Morning pages');
    expect(label).toContain(formatDate(ts));
  });

  it('renders a New entry row above every section and entries', () => {
    const items = [entry(1, { timestamp: ago(1) })];
    const { getAllByTestId } = renderDrawer({ items });
    const testIDs = getAllByTestId(/^(journal-drawer-new-entry|journal-drawer-entry-\d+)$/).map(
      (n) => n.props.testID as string,
    );
    expect(testIDs[0]).toBe('journal-drawer-new-entry');
  });

  it('fires onNewEntry when the New entry row is pressed', () => {
    const { getByTestId, onNewEntry } = renderDrawer({ items: [] });
    fireEvent.press(getByTestId('journal-drawer-new-entry'));
    expect(onNewEntry).toHaveBeenCalledTimes(1);
  });

  it('renders a leading pencil icon in the muted ink color on the New entry row', () => {
    const { getByTestId } = renderDrawer({ items: [] });
    const icon = getByTestId('journal-drawer-new-entry').findByType(SquarePen);
    expect(icon).toBeTruthy();
    expect(icon.props.color).toBe(ink.muted);
  });

  it('fires onRowPress with the tapped entry id', () => {
    const items = [entry(5), entry(6)];
    const { getByTestId, onRowPress } = renderDrawer({ items });
    fireEvent.press(getByTestId('journal-drawer-entry-6'));
    expect(onRowPress).toHaveBeenCalledWith(6);
    expect(onRowPress).not.toHaveBeenCalledWith(5);
  });

  it('marks the current entry row selected and leaves the others unselected', () => {
    const items = [entry(1), entry(2)];
    const { getByTestId } = renderDrawer({ items, currentEntryId: 2 });
    expect(getByTestId('journal-drawer-entry-2').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('journal-drawer-entry-1').props.accessibilityState.selected).toBe(false);
  });

  it('selects nothing when no current entry id is given (the shelf mount)', () => {
    const items = [entry(1), entry(2)];
    const { getByTestId } = renderDrawer({ items, currentEntryId: null });
    expect(getByTestId('journal-drawer-entry-1').props.accessibilityState.selected).toBe(false);
    expect(getByTestId('journal-drawer-entry-2').props.accessibilityState.selected).toBe(false);
  });

  it('shows the "Load older entries" row only when hasMore is true', () => {
    const items = [entry(1)];
    const withMore = renderDrawer({ items, hasMore: true });
    expect(withMore.getByTestId('journal-drawer-load-more')).toBeTruthy();
    const withoutMore = renderDrawer({ items, hasMore: false });
    expect(withoutMore.queryByTestId('journal-drawer-load-more')).toBeNull();
  });

  it('fires onLoadMore when the load-more row is pressed', () => {
    const items = [entry(1)];
    const { getByTestId, onLoadMore } = renderDrawer({ items, hasMore: true });
    fireEvent.press(getByTestId('journal-drawer-load-more'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows a loading spinner and no entry rows while loading', () => {
    const { getByTestId, queryByTestId } = renderDrawer({ items: [], loading: true });
    expect(getByTestId('journal-drawer-loading')).toBeTruthy();
    expect(queryByTestId(/^journal-drawer-entry-\d+$/)).toBeNull();
  });

  it('still offers the New entry row while loading', () => {
    const { getByTestId } = renderDrawer({ items: [], loading: true });
    expect(getByTestId('journal-drawer-new-entry')).toBeTruthy();
  });

  it('shows an error state with a retry affordance when the fetch failed', () => {
    const { getByTestId } = renderDrawer({ items: [], error: true });
    expect(getByTestId('journal-drawer-error')).toBeTruthy();
    expect(getByTestId('journal-drawer-retry')).toBeTruthy();
  });

  it('fires onRetry when the retry row is pressed', () => {
    const { getByTestId, onRetry } = renderDrawer({ items: [], error: true });
    fireEvent.press(getByTestId('journal-drawer-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not render the Photograph row when onPhotograph is absent', () => {
    const { queryByTestId } = renderDrawer({ items: [] });
    expect(queryByTestId('journal-photograph-entry')).toBeNull();
  });

  it('renders a Photograph row beside New entry when onPhotograph is provided', () => {
    const onPhotograph = jest.fn();
    const { getByTestId } = renderDrawer({ items: [], onPhotograph });
    expect(getByTestId('journal-photograph-entry')).toBeTruthy();
  });

  it('fires onPhotograph when the Photograph row is pressed', () => {
    const onPhotograph = jest.fn();
    const { getByTestId } = renderDrawer({ items: [], onPhotograph });
    fireEvent.press(getByTestId('journal-photograph-entry'));
    expect(onPhotograph).toHaveBeenCalledTimes(1);
  });
});

// Wiring: the co-located useJournalDrawerEntries hook, mounted the same way
// the real screens will use it -- called unconditionally above the panel, with
// the panel itself only mounted while open (a ScreenDrawer Modal renders no
// children when closed, so this is the only way to prove the cache survives
// close/reopen without depending on ScreenDrawer or navigation at all).
function Harness(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const { items, loading, error, hasMore, loadMore, retry } = useJournalDrawerEntries(isOpen);
  return (
    <View>
      <TouchableOpacity testID="harness-open" onPress={() => setIsOpen(true)} />
      <TouchableOpacity testID="harness-close" onPress={() => setIsOpen(false)} />
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
          onConfirmBodySearch={() => undefined}
        />
      ) : null}
    </View>
  );
}

describe('useJournalDrawerEntries (wiring)', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('does not fetch until the drawer is opened for the first time', () => {
    mockList.mockResolvedValue(page([]));
    render(<Harness />);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('shows the loading state before the first fetch resolves', async () => {
    let resolveFetch: (_v: JournalListResponse) => void = () => undefined;
    mockList.mockReturnValue(
      new Promise<JournalListResponse>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { getByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() => expect(getByTestId('journal-drawer-loading')).toBeTruthy());
    await act(async () => {
      resolveFetch(page([entry(1)]));
    });
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());
  });

  it('fetches once on first open and caches across close/reopen', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { getByTestId, queryByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());
    expect(mockList).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(getByTestId('harness-close'));
    });
    expect(queryByTestId('journal-drawer-entry-1')).toBeNull();

    fireEvent.press(getByTestId('harness-open'));
    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('shows an error and retry when the fetch rejects, and retry refetches', async () => {
    mockList.mockRejectedValueOnce(new Error('network down'));
    const { getByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() => expect(getByTestId('journal-drawer-error')).toBeTruthy());

    mockList.mockResolvedValueOnce(page([entry(1)]));
    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-retry'));
    });
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());
  });

  it('fetches the first page at offset 0 when the drawer first opens', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { getByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 })),
    );
  });

  it('fetches the next offset and appends older entries when Load older is pressed', async () => {
    const firstPageItems = Array.from({ length: 20 }, (_, i) => entry(i + 1));
    mockList.mockResolvedValueOnce(page(firstPageItems, true));
    const { getByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() => expect(getByTestId('journal-drawer-load-more')).toBeTruthy());

    mockList.mockResolvedValueOnce(page([entry(21)], false));
    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-load-more'));
    });

    await waitFor(() => expect(getByTestId('journal-drawer-entry-21')).toBeTruthy());
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 }));
    // The first page's entries are still present -- Load older appends.
    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
  });

  it('hides Load older once the last page reports has_more: false', async () => {
    mockList.mockResolvedValue(page([entry(1)], false));
    const { getByTestId, queryByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('harness-open'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());
    expect(queryByTestId('journal-drawer-load-more')).toBeNull();
  });
});
