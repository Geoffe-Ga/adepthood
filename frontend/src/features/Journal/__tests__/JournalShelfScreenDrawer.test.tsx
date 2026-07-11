/* eslint-env jest */
// The Journal header drawer mounted from JournalShelfScreen: the toggle is
// installed via useScreenDrawer, entries fetch lazily on first open (the
// shelf's own initial journal.list call must not be mistaken for the
// drawer's), reopening is cached, and a row tap navigates (not pushes --
// unlike the entry-screen mount point) and closes the drawer.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useSyncExternalStore, type ReactElement } from 'react';

import type { JournalListResponse, JournalMessage, PromptDetail } from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    update: jest.fn(),
  },
  prompts: {
    current: (...a: unknown[]) =>
      (mockPromptCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

const headerLeftStore: {
  current: (() => ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});

jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
    useFocusEffect: (cb: () => undefined | (() => void)) => react.useEffect(cb, []),
  };
});

jest.mock('../SearchBar', () => {
  const { TextInput } = require('react-native');
  const Stub = ({ onSearch }: { onSearch: (_q: string) => void }) => (
    <TextInput testID="shelf-search" onChangeText={onSearch} />
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

const JournalShelfScreen = require('../JournalShelfScreen').default;

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

function ShelfScreenWithHeader(): ReactElement {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <JournalShelfScreen />
    </>
  );
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
    has_responded: true,
    response: null,
    timestamp: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
  mockList.mockResolvedValue(page([entry(1)]));
  mockPromptCurrent.mockResolvedValue(prompt());
});

describe('Journal header drawer from JournalShelfScreen', () => {
  it('installs a header-left drawer toggle and opens the drawer on press', async () => {
    const { getByTestId, getByLabelText } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());
    expect(mockSetOptions).toHaveBeenCalled();

    fireEvent.press(getByLabelText('Open Journal menu'));
    expect(getByTestId('screen-drawer')).toBeTruthy();
  });

  it('adds no drawer journal.list call on mount -- only the shelf load fires', async () => {
    const { getByTestId } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('fetches entries once when the drawer first opens', async () => {
    const { getByTestId, getByLabelText } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());

    expect(mockList).toHaveBeenCalledTimes(2); // 1 shelf load + 1 drawer open
  });

  it('does not refetch when the drawer is closed and reopened', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());
    const callsAfterFirstOpen = mockList.mock.calls.length;

    await act(async () => {
      fireEvent.press(getByTestId('screen-drawer-scrim'));
    });
    expect(queryByTestId('screen-drawer')).toBeNull();

    fireEvent.press(getByLabelText('Open Journal menu'));
    expect(getByTestId('journal-drawer-entry-1')).toBeTruthy();
    expect(mockList).toHaveBeenCalledTimes(callsAfterFirstOpen);
  });

  it('navigates (not pushes) to the tapped entry and closes the drawer', async () => {
    mockList.mockResolvedValue(page([entry(1), entry(2)]));
    const { getByTestId, getByLabelText, queryByTestId } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-2')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-entry-2'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 2 });
    expect(queryByTestId('screen-drawer')).toBeNull();
  });

  it('selects no row (the shelf has no current entry)', async () => {
    mockList.mockResolvedValue(page([entry(1)]));
    const { getByTestId, getByLabelText } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-1')).toBeTruthy());

    expect(getByTestId('journal-drawer-entry-1').props.accessibilityState.selected).toBe(false);
  });

  it('starts a blank entry and closes the drawer from New entry', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<ShelfScreenWithHeader />);
    await waitFor(() => expect(getByTestId('journal-shelf-card-1')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-new-entry')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-new-entry'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry');
    expect(queryByTestId('screen-drawer')).toBeNull();
  });
});
