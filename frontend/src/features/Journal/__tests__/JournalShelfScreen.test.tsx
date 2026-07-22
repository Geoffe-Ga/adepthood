/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { JournalListResponse, JournalMessage, PromptDetail } from '@/api';
import { accent, surface } from '@/design/tokens';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();
// Present so a display-only excerpt() regression that starts writing back to the
// server (instead of only truncating the rendered preview) has something to trip.
const mockUpdate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    current: (...a: unknown[]) =>
      (mockPromptCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
    // Run the focus callback on mount (and its cleanup on unmount) — enough to
    // exercise the prompt re-fetch in these render-once tests.
    useFocusEffect: (cb: () => undefined | (() => void)) => react.useEffect(cb, []),
  };
});

// Isolate the shelf's search wiring from SearchBar's own debounce/expand UI.
jest.mock('../SearchBar', () => {
  const { Text, TextInput, View } = require('react-native');
  const Stub = ({
    onSearch,
    resultCount,
  }: {
    onSearch: (_q: string) => void;
    resultCount?: number;
  }) => (
    <View>
      <TextInput testID="shelf-search" onChangeText={onSearch} />
      {resultCount == null ? null : <Text testID="shelf-result-count">{String(resultCount)}</Text>}
    </View>
  );
  return { __esModule: true, default: Stub };
});

// The stat-tile row owns its own stores, hooks, and dedicated suite; stub it so
// the shelf tests stay focused on list/prompt/search behavior.
jest.mock('../StatTileRow', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stat-tile-row-stub" />;
  return { __esModule: true, default: Stub };
});

// The Return and invitation surfaces render on the shelf; stub them so shelf
// tests stay focused on ordering, not on Return/invitation state.
jest.mock('@/features/Return/ReturnStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="return-stack-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('@/features/Invitations/InvitationStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="invitation-stack-stub" />;
  return { __esModule: true, default: Stub };
});

// The morning-pages tip owns its own AsyncStorage-backed dismissal state and a
// dedicated suite; stub it so its post-mount load never fires setState after
// these shelf tests resolve, keeping them focused on ordering and list wiring.
jest.mock('../MorningPagesTip', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="morning-pages-tip-stub" />;
  return { __esModule: true, default: Stub };
});

const JournalShelfScreen = require('../JournalShelfScreen').default;

type RenderedNode = {
  props: { testID?: unknown };
  children: (RenderedNode | string)[] | null;
};

// Depth-first list of testID markers (#id) and raw text nodes, in render order.
// Walks only children (never props) so React element props stay non-circular.
function flattenOrder(node: RenderedNode | RenderedNode[] | string | null): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((child) => flattenOrder(child));
  const out: string[] = [];
  const testID = node.props.testID;
  if (typeof testID === 'string') out.push(`#${testID}`);
  const children = node.children;
  if (children === null) return out;
  for (const child of children) out.push(...flattenOrder(child));
  return out;
}

function entry(id: number, overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id,
    message: `Body of entry ${id}.`,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: `Entry ${id}`,
    status: 'finished',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function page(items: JournalMessage[], hasMore = false): JournalListResponse {
  return { items, total: items.length, has_more: hasMore };
}

function prompt(overrides: Partial<PromptDetail> = {}): PromptDetail {
  return {
    week_number: 3,
    question: 'What did you notice this week?',
    has_responded: false,
    response: null,
    timestamp: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockNavigate.mockReset();
  mockPromptCurrent.mockReset();
  mockUpdate.mockReset();
  mockList.mockResolvedValue(page([]));
  // Default: the weekly prompt is already answered, so no card surfaces.
  mockPromptCurrent.mockResolvedValue(prompt({ has_responded: true }));
});

describe('JournalShelfScreen', () => {
  it('renders page cards in the newest-first order the API returns', async () => {
    mockList.mockResolvedValue(page([entry(3), entry(2), entry(1)]));
    const { findByTestId, getAllByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-3');
    // Assert the rendered *sequence*, not mere existence — a reordering
    // mutation must fail this test.
    const renderedIds = getAllByTestId(/^journal-shelf-card-\d+$/).map(
      (node) => node.props.testID as string,
    );
    expect(renderedIds).toEqual([
      'journal-shelf-card-3',
      'journal-shelf-card-2',
      'journal-shelf-card-1',
    ]);
  });

  it('floats each entry as a warm paper tile lifted off the canvas ground', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    const card = StyleSheet.flatten((await findByTestId('journal-shelf-card-1')).props.style);
    // Lifted warm paper tile (surface.desk) raised by the shared card shadow,
    // separated by gaps rather than the old hairline divider.
    expect(card.backgroundColor).toBe(surface.desk);
    expect(card.shadowRadius).toBeGreaterThan(0);
    expect(card.elevation).toBeGreaterThan(0);
    expect(card.borderBottomWidth).toBeUndefined();
    // The shelf now sits on the warm scaffold canvas.
    const root = StyleSheet.flatten(getByTestId('journal-shelf').props.style);
    expect(root.backgroundColor).toBe(surface.canvas);
  });

  it('floats the weekly-prompt band with matching depth while keeping its accent bar', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    mockPromptCurrent.mockResolvedValue(prompt({ week_number: 3, has_responded: false }));
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = StyleSheet.flatten((await findByTestId('journal-weekly-prompt')).props.style);
    // Lifted onto a raised sheet…
    expect(card.backgroundColor).toBe(surface.raised);
    expect(card.shadowRadius).toBeGreaterThan(0);
    expect(card.elevation).toBeGreaterThan(0);
    // …but keeps its accent-bar identity.
    expect(card.borderLeftColor).toBe(accent.primary);
  });

  it('shows the empty state when there are no entries', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf-empty')).toBeTruthy();
  });

  it('groups entries into recency sections (This week / This month / Earlier)', async () => {
    const DAY_MS = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    mockList.mockResolvedValue(
      page([
        entry(1, { timestamp: ago(1) }), // This week
        entry(2, { timestamp: ago(10) }), // This month
        entry(3, { timestamp: ago(60) }), // Earlier
      ]),
    );
    const { findByText, getByText, getByTestId } = render(<JournalShelfScreen />);
    expect(await findByText('This week')).toBeTruthy();
    expect(getByText('This month')).toBeTruthy();
    expect(getByText('Earlier')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-1')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-3')).toBeTruthy();
  });

  it('captions each page with a relative "saved ... ago" phrase by age', async () => {
    const DAY_MS = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    mockList.mockResolvedValue(
      page([
        entry(1, { timestamp: ago(0) }),
        entry(2, { timestamp: ago(1) }),
        entry(3, { timestamp: ago(5) }),
      ]),
    );
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    const card1 = await findByTestId('journal-shelf-card-1');
    const card2 = getByTestId('journal-shelf-card-2');
    const card3 = getByTestId('journal-shelf-card-3');
    expect(within(card1).getByText(/saved today/)).toBeTruthy();
    expect(within(card2).getByText(/saved 1 day ago/)).toBeTruthy();
    expect(within(card3).getByText(/saved 5 days ago/)).toBeTruthy();
  });

  it('falls back to the absolute saved date once an entry is a month or older', async () => {
    const DAY_MS = 86_400_000;
    const oldTimestamp = new Date(Date.now() - 45 * DAY_MS).toISOString();
    mockList.mockResolvedValue(page([entry(9, { timestamp: oldTimestamp })]));
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = await findByTestId('journal-shelf-card-9');
    // No relative "saved N days ago" phrasing once the entry ages out of that
    // window — the caption falls back to the absolute saved date instead.
    expect(within(card).queryByText(/saved \d+ days? ago/)).toBeNull();
    expect(within(card).queryByText(/saved today/)).toBeNull();
  });

  it('truncates a long entry body to an ellipsis excerpt, display-only (no journal.update)', async () => {
    const longBody = 'word '.repeat(60).trim();
    mockList.mockResolvedValue(page([entry(4, { message: longBody })]));
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = await findByTestId('journal-shelf-card-4');
    expect(within(card).getByText(new RegExp(`${String.fromCharCode(0x2026)}$`))).toBeTruthy();
    expect(within(card).queryByText(longBody)).toBeNull();
    // Rendering the excerpt must never write anything back to the server.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('starts a blank page from the empty-state call to action', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-empty-cta'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry');
  });

  it('shows a no-results line when a search returns nothing', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');

    mockList.mockResolvedValue(page([])); // the search comes back empty
    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), 'zzz');
    });
    expect(await findByTestId('journal-shelf-no-results')).toBeTruthy();
    // The inviting empty state is suppressed during an active search.
    expect(queryByTestId('journal-shelf-empty')).toBeNull();
  });

  it('opens a fresh entry from "New entry"', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-new-entry'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry');
  });

  it('opens the tapped entry by id', async () => {
    mockList.mockResolvedValue(page([entry(7)]));
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-shelf-card-7'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 7 });
  });

  it('searches only at >= 3 chars and clears back to the full shelf', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');
    mockList.mockClear();

    fireEvent.changeText(getByTestId('shelf-search'), 'wi'); // < 3 chars: no call
    expect(mockList).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), 'willow');
    });
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ search: 'willow', offset: 0 }));

    mockList.mockClear();
    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), '');
    });
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ search: undefined, offset: 0 }),
    );
  });

  it('does not search when the query exceeds the 64-char maximum', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');
    mockList.mockClear();

    fireEvent.changeText(getByTestId('shelf-search'), 'x'.repeat(65)); // > 64: no call
    expect(mockList).not.toHaveBeenCalled();
  });

  it('surfaces a load error instead of the empty state on a cold-start failure', async () => {
    mockList.mockRejectedValue(new Error('network down'));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf-error')).toBeTruthy();
    expect(queryByTestId('journal-shelf-empty')).toBeNull();
  });

  it('does not let a stale mount response overwrite a newer search result', async () => {
    let resolveMount: (_value: JournalListResponse) => void = () => undefined;
    const mountPromise = new Promise<JournalListResponse>((resolve) => {
      resolveMount = resolve;
    });
    mockList.mockImplementation((p) =>
      p?.search === 'willow' ? Promise.resolve(page([entry(2)])) : mountPromise,
    );
    const { getByTestId, queryByTestId } = render(<JournalShelfScreen />);

    fireEvent.changeText(getByTestId('shelf-search'), 'willow');
    await waitFor(() => expect(queryByTestId('journal-shelf-card-2')).toBeTruthy());
    expect(queryByTestId('journal-shelf-card-1')).toBeNull();

    resolveMount(page([entry(1), entry(2)]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-shelf-card-1')).toBeNull();
  });

  it('does not let a stale mount failure clobber a newer search-empty result', async () => {
    let rejectMount: (_reason: unknown) => void = () => undefined;
    const mountPromise = new Promise<JournalListResponse>((_resolve, reject) => {
      rejectMount = reject;
    });
    mockList.mockImplementation((p) =>
      p?.search === 'willow' ? Promise.resolve(page([])) : mountPromise,
    );
    const { getByTestId, findByTestId, queryByTestId } = render(<JournalShelfScreen />);

    fireEvent.changeText(getByTestId('shelf-search'), 'willow');
    await findByTestId('journal-shelf-no-results');

    rejectMount(new Error('network down'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-shelf-error')).toBeNull();
    expect(queryByTestId('journal-shelf-no-results')).toBeTruthy();
  });

  it('appends the next page when more are available', async () => {
    mockList.mockResolvedValueOnce(page([entry(1), entry(2)], true));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-2');

    mockList.mockResolvedValueOnce(page([entry(3)], false));
    await act(async () => {
      fireEvent(getByTestId('journal-shelf-list'), 'onEndReached');
    });
    await waitFor(() => expect(getByTestId('journal-shelf-card-3')).toBeTruthy());
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 2 }));
  });

  it('captions a multi-page search with the backend total, stable across paging', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');

    // A large match set: one page of 20 loaded, but 57 matches in total.
    const firstPage = Array.from({ length: 20 }, (_, i) => entry(i + 1));
    mockList.mockResolvedValueOnce({ items: firstPage, total: 57, has_more: true });
    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), 'river');
    });
    await waitFor(() => expect(getByTestId('shelf-result-count')).toHaveTextContent('57'));

    // Paging in the next 20 must not inflate the caption toward the loaded count.
    const secondPage = Array.from({ length: 20 }, (_, i) => entry(i + 21));
    mockList.mockResolvedValueOnce({ items: secondPage, total: 57, has_more: true });
    await act(async () => {
      fireEvent(getByTestId('journal-shelf-list'), 'onEndReached');
    });
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })),
    );
    expect(getByTestId('shelf-result-count')).toHaveTextContent('57');
  });

  it('surfaces an unanswered weekly prompt and opens it as a pre-titled page', async () => {
    mockPromptCurrent.mockResolvedValue(prompt({ week_number: 3, has_responded: false }));
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-weekly-prompt'));
    expect(mockNavigate).toHaveBeenCalledWith(
      'JournalEntry',
      expect.objectContaining({
        weekNumber: 3,
        promptQuestion: 'What did you notice this week?',
        prefillTitle: 'Beige week 3 Prompt #1',
      }),
    );
  });

  it('does not surface an already-answered weekly prompt', async () => {
    mockPromptCurrent.mockResolvedValue(prompt({ has_responded: true }));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-empty');
    expect(queryByTestId('journal-weekly-prompt')).toBeNull();
  });

  // Warm first-prompt affordance — true-empty branch only.

  it('renders the warm first-prompt affordance alongside the start-a-page CTA when the shelf is empty', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-empty');
    expect(getByTestId('journal-empty-first-prompt')).toBeTruthy();
    expect(getByTestId('journal-empty-cta')).toBeTruthy();
  });

  it('shows the prompt copy "What brought you here?" on the warm affordance', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-empty-first-prompt');
    // Exact copy asserted verbatim — the implementation must match.
    const affordance = getByTestId('journal-empty-first-prompt');
    expect(within(affordance).getByText('What brought you here?')).toBeTruthy();
  });

  it('exposes accessibilityRole="button" and a non-empty accessibilityLabel on the warm affordance', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-empty-first-prompt');
    const affordance = getByTestId('journal-empty-first-prompt');
    expect(affordance.props.accessibilityRole).toBe('button');
    const label: string = affordance.props.accessibilityLabel ?? '';
    expect(label.length).toBeGreaterThan(0);
  });

  it('navigates with the warm prompt question when the affordance is tapped', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-empty-first-prompt'));
    // Exact nav params — implementation must match verbatim.
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      promptQuestion: 'What brought you here?',
    });
  });

  it('hides the warm affordance when there is at least one journal entry', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');
    expect(queryByTestId('journal-empty-first-prompt')).toBeNull();
  });

  it('hides the warm affordance while the initial load is in flight', async () => {
    // Never resolve so the component stays in the loading state.
    mockList.mockReturnValue(new Promise<JournalListResponse>(() => undefined));
    const { queryByTestId } = render(<JournalShelfScreen />);
    expect(queryByTestId('journal-empty-first-prompt')).toBeNull();
  });

  it('hides the warm affordance when the initial load fails', async () => {
    mockList.mockRejectedValue(new Error('network down'));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-error');
    expect(queryByTestId('journal-empty-first-prompt')).toBeNull();
  });

  it('falls back to "Untitled" and a matching a11y label when the entry has no title', async () => {
    mockList.mockResolvedValue(page([entry(1, { title: null })]));
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = await findByTestId('journal-shelf-card-1');
    expect(within(card).getByText('Untitled')).toBeTruthy();
    expect(card.props.accessibilityLabel).toBe('Open untitled entry');
  });

  it('drops the "saved" phrase from the caption for an unparseable timestamp', async () => {
    mockList.mockResolvedValue(page([entry(1, { timestamp: 'not-a-real-date' })]));
    const { findByTestId } = render(<JournalShelfScreen />);
    const card = await findByTestId('journal-shelf-card-1');
    // The "saved ... ago" half of the caption drops entirely instead of showing a garbled date.
    expect(within(card).getByText('1 min read')).toBeTruthy();
    expect(within(card).queryByText(/saved/)).toBeNull();
  });

  it('hides the warm affordance when a search returns no results', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');

    mockList.mockResolvedValue(page([]));
    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), 'zzz');
    });
    await findByTestId('journal-shelf-no-results');
    expect(queryByTestId('journal-empty-first-prompt')).toBeNull();
  });

  it('renders the hero above the header in the top matter', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-hero')).toBeTruthy();
  });

  it('fades the bottom edge of the shelf into the canvas ground', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('bottom-fade')).toBeTruthy();
  });

  it('shows "Journal" as the header title and drops "Your shelf"', async () => {
    const { findByTestId, getByText, queryByText } = render(<JournalShelfScreen />);
    await findByTestId('journal-hero');
    expect(getByText('Journal')).toBeTruthy();
    expect(queryByText('Your shelf')).toBeNull();
  });

  it('renames the empty-state title to "Your journal is empty"', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByText } = render(<JournalShelfScreen />);
    expect(await findByText('Your journal is empty')).toBeTruthy();
  });

  it('navigates to the Map tab when the hero position line is pressed', async () => {
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-hero-position'));
    expect(mockNavigate).toHaveBeenCalledWith('Map');
  });

  it('stacks Return above invitations, after the stat tiles and before the header', async () => {
    const { findByTestId, toJSON } = render(<JournalShelfScreen />);
    await findByTestId('stat-tile-row-stub');
    const order = flattenOrder(toJSON());
    const statIndex = order.indexOf('#stat-tile-row-stub');
    const returnIndex = order.indexOf('#return-stack-stub');
    const invitationIndex = order.indexOf('#invitation-stack-stub');
    const headerIndex = order.indexOf('Journal');
    const tipIndex = order.indexOf('#morning-pages-tip-stub');
    expect(statIndex).toBeGreaterThan(-1);
    expect(returnIndex).toBeGreaterThan(statIndex);
    expect(invitationIndex).toBeGreaterThan(returnIndex);
    expect(headerIndex).toBeGreaterThan(invitationIndex);
    // The morning-pages tip sits in the shelf's top matter, below the header.
    expect(tipIndex).toBeGreaterThan(headerIndex);
  });
});
