import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type {
  JournalListResponse,
  JournalMessage,
  PromptDetail,
  ReflectionCurrentScope,
  ReflectionDue,
} from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockDelete = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();
const mockDue = jest.fn() as jest.MockedFunction<() => Promise<{ due: ReflectionDue | null }>>;
const mockCurrent = jest.fn() as jest.MockedFunction<
  () => Promise<{ scopes: ReflectionCurrentScope[] }>
>;

// Every mounted focus effect, as a "run its cleanup then run it again" thunk.
// Firing these is this suite's stand-in for leaving the shelf and coming back.
const mockFocusReruns = new Set<() => void>();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    delete: (...a: unknown[]) => (mockDelete as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    current: (...a: unknown[]) =>
      (mockPromptCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
  reflections: {
    due: (...a: unknown[]) => (mockDue as unknown as (...x: unknown[]) => unknown)(...a),
    current: (...a: unknown[]) => (mockCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/storage/reflectionDismissalStorage', () => ({
  loadReflectionDismissed: jest.fn(() => Promise.resolve(false)),
  saveReflectionDismissed: jest.fn(() => Promise.resolve()),
}));

// A focus effect that can be re-fired, unlike the mount-only stand-in the other
// shelf suites use: blur runs the cleanup, focus runs the callback again.
jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => () => void, _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
    useFocusEffect: (cb: () => undefined | (() => void)) => {
      react.useEffect(() => {
        let cleanup = cb();
        const rerun = (): void => {
          cleanup?.();
          cleanup = cb();
        };
        mockFocusReruns.add(rerun);
        return () => {
          mockFocusReruns.delete(rerun);
          cleanup?.();
        };
      }, [cb]);
    },
  };
});

jest.mock('../SearchBar', () => {
  const { TextInput, View } = require('react-native');
  const Stub = ({ onSearch }: { onSearch: (_q: string) => void }) => (
    <View>
      <TextInput testID="shelf-search" onChangeText={onSearch} />
    </View>
  );
  return { __esModule: true, default: Stub };
});

jest.mock('../StatTileRow', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stat-tile-row-stub" />;
  return { __esModule: true, default: Stub };
});
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
jest.mock('../MorningPagesTip', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="morning-pages-tip-stub" />;
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

function page(items: JournalMessage[]): JournalListResponse {
  return { items, total: items.length, has_more: false };
}

/** Leave the shelf and come back: every mounted focus effect re-runs. */
async function returnToTheShelf(): Promise<void> {
  await act(async () => {
    for (const rerun of [...mockFocusReruns]) rerun();
  });
}

beforeEach(() => {
  mockFocusReruns.clear();
  mockList.mockReset();
  mockDelete.mockReset();
  mockNavigate.mockReset();
  mockPromptCurrent.mockReset();
  mockDue.mockReset();
  mockDue.mockResolvedValue({ due: null });
  mockCurrent.mockReset();
  mockCurrent.mockResolvedValue({ scopes: [] });
  mockList.mockResolvedValue(page([]));
  mockDelete.mockResolvedValue(undefined);
  mockPromptCurrent.mockResolvedValue({
    week_number: 3,
    question: 'What did you notice this week?',
    has_responded: true,
    response: null,
    timestamp: null,
  });
});

describe('the shelf when the writer comes back to it', () => {
  it('lists a page written since it was last looked at', async () => {
    mockList.mockResolvedValueOnce(page([]));
    const { findByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-empty');

    mockList.mockResolvedValue(page([entry(7, { title: 'The morning it broke open' })]));
    await returnToTheShelf();

    expect(await findByTestId('journal-shelf-card-7')).toBeTruthy();
  });

  it('starts from a brand-new account, where the first page is the only page', async () => {
    const { findByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-empty');
    // A legitimately empty journal must not keep re-firing the load that found it.
    expect(mockList).toHaveBeenCalledTimes(1);

    mockList.mockResolvedValue(page([entry(1)]));
    await returnToTheShelf();

    expect(await findByTestId('journal-shelf-card-1')).toBeTruthy();
    expect(queryByTestId('journal-shelf-empty')).toBeNull();
  });

  it('re-reads under the search the writer left in place, not the whole shelf', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { findByTestId, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-1');

    await act(async () => {
      fireEvent.changeText(getByTestId('shelf-search'), 'gratitude');
    });
    const callsBefore = mockList.mock.calls.length;
    await returnToTheShelf();

    expect(mockList.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(mockList).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'gratitude', offset: 0 }),
    );
  });

  it('leaves a delete that has not answered yet alone, rather than putting the row back', async () => {
    mockList.mockResolvedValue(page([entry(2), entry(1)]));
    mockDelete.mockReturnValue(new Promise<void>(() => undefined));
    const { findByTestId, getByTestId, queryByTestId } = render(<JournalShelfScreen />);
    await findByTestId('journal-shelf-card-2');

    await act(async () => {
      fireEvent.press(getByTestId('journal-shelf-delete-2'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });
    expect(queryByTestId('journal-shelf-card-2')).toBeNull();

    const callsBefore = mockList.mock.calls.length;
    await returnToTheShelf();

    expect(queryByTestId('journal-shelf-card-2')).toBeNull();
    expect(mockList).toHaveBeenCalledTimes(callsBefore);
  });

  it('re-reads which review is due, so a shelf left open overnight offers today’s', async () => {
    const { findByTestId, findByText, queryByTestId } = render(<JournalShelfScreen />);
    // Yesterday: nothing due, so the daily page holds the primary slot.
    await findByTestId('morning-pages-tip-stub');
    expect(queryByTestId('journal-reflection-band')).toBeNull();

    mockDue.mockResolvedValue({
      due: {
        level: 'week',
        scope_key: 'c1:w1',
        window_start: '2026-07-01T00:00:00Z',
        window_end: '2026-07-08T00:00:00Z',
        existing_entry_id: null,
      },
    });
    await returnToTheShelf();

    expect(await findByText('Write your Weekly Review')).toBeTruthy();
    expect(queryByTestId('morning-pages-tip-stub')).toBeNull();

    // And the day after, when it has closed, the review goes away again.
    mockDue.mockResolvedValue({ due: null });
    await returnToTheShelf();

    expect(await findByTestId('morning-pages-tip-stub')).toBeTruthy();
    expect(queryByTestId('journal-reflection-band')).toBeNull();
  });

  it('re-reads the open early-review picker, so a review begun elsewhere is offered to continue', async () => {
    const weekTwo: ReflectionCurrentScope = {
      level: 'week',
      scope_key: 'c1:w2',
      window_start: '2026-07-08T00:00:00Z',
      window_end: '2026-07-15T00:00:00Z',
      existing_entry_id: null,
    };
    mockCurrent.mockResolvedValue({ scopes: [weekTwo] });
    const { findByTestId, findByText, getByTestId } = render(<JournalShelfScreen />);
    await findByTestId('morning-pages-tip-stub');
    fireEvent.press(getByTestId('journal-review-early'));
    expect(await findByText('Weekly Review — Week 2')).toBeTruthy();

    // The writer leaves with the picker still open and claims week 2 elsewhere
    // (the due card, another tab). Coming back must not offer a second page.
    mockCurrent.mockResolvedValue({ scopes: [{ ...weekTwo, existing_entry_id: 77 }] });
    await returnToTheShelf();

    expect(await findByText('Continue — Weekly Review — Week 2')).toBeTruthy();
    fireEvent.press(getByTestId('journal-review-scope-week'));
    expect(mockNavigate).toHaveBeenLastCalledWith('JournalEntry', { entryId: 77 });
  });
});
