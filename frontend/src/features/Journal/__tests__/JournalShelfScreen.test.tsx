/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalListResponse, JournalMessage } from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

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

beforeEach(() => {
  mockList.mockReset();
  mockNavigate.mockReset();
  mockList.mockResolvedValue(page([]));
});

describe('JournalShelfScreen', () => {
  it('renders page cards from the shelf (newest-first order as returned)', async () => {
    mockList.mockResolvedValue(page([entry(3), entry(2), entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    expect(await findByTestId('journal-shelf-card-3')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
    expect(getByTestId('journal-shelf-card-1')).toBeTruthy();
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
});
