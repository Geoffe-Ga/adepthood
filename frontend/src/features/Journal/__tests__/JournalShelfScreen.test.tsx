/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { JournalListResponse, JournalMessage, PromptDetail } from '@/api';
import { colors } from '@/design/tokens';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
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
    useNavigation: () => ({ navigate: mockNavigate }),
    // Run the focus callback on mount (and its cleanup on unmount) — enough to
    // exercise the prompt re-fetch in these render-once tests.
    useFocusEffect: (cb: () => undefined | (() => void)) => react.useEffect(cb, []),
  };
});

// Isolate the shelf's search wiring from SearchBar's own debounce/expand UI.
jest.mock('../SearchBar', () => {
  const { TextInput } = require('react-native');
  const Stub = ({ onSearch }: { onSearch: (_q: string) => void }) => (
    <TextInput testID="shelf-search" onChangeText={onSearch} />
  );
  return { __esModule: true, default: Stub };
});

const JournalShelfScreen = require('../JournalShelfScreen').default;

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
  mockList.mockResolvedValue(page([]));
  // Default: the weekly prompt is already answered, so no card surfaces.
  mockPromptCurrent.mockResolvedValue(prompt({ has_responded: true }));
});

describe('JournalShelfScreen', () => {
  it('renders page cards from the shelf (newest-first order as returned)', async () => {
    mockList.mockResolvedValue(page([entry(3), entry(2), entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf-card-3')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-1')).toBeTruthy();
  });

  it('floats each entry as a lifted paper card on the deeper desk ground', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    const card = StyleSheet.flatten((await findByTestId('journal-shelf-card-1')).props.style);
    // Lifted paper card: matches the page ground, lifted by the warm card shadow,
    // separated by gaps rather than the old hairline divider.
    expect(card.backgroundColor).toBe(colors.paper.background);
    expect(card.shadowRadius).toBeGreaterThan(0);
    expect(card.elevation).toBeGreaterThan(0);
    expect(card.borderBottomWidth).toBeUndefined();
    // The shelf sits on the deeper desk ground the cards float above.
    const root = StyleSheet.flatten(getByTestId('journal-shelf').props.style);
    expect(root.backgroundColor).toBe(colors.paper.desk);
  });

  it('shows the empty state when there are no entries', async () => {
    mockList.mockResolvedValue(page([]));
    const { findByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf-empty')).toBeTruthy();
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

  it('surfaces an unanswered weekly prompt and opens it as a pre-titled page', async () => {
    mockPromptCurrent.mockResolvedValue(prompt({ week_number: 3, has_responded: false }));
    const { findByTestId } = render(<JournalShelfScreen />);
    fireEvent.press(await findByTestId('journal-weekly-prompt'));
    expect(mockNavigate).toHaveBeenCalledWith(
      'JournalEntry',
      expect.objectContaining({
        weekNumber: 3,
        promptQuestion: 'What did you notice this week?',
        prefillTitle: 'Week 3 Reflection',
      }),
    );
  });

  it('does not surface an already-answered weekly prompt', async () => {
    mockPromptCurrent.mockResolvedValue(prompt({ has_responded: true }));
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-empty');
    expect(queryByTestId('journal-weekly-prompt')).toBeNull();
  });
});
