/* eslint-env jest */
// The Journal header drawer mounted from JournalEntryScreen: the current entry
// is highlighted, and both a row tap and New entry push (not navigate) --
// JournalEntryScreen latches its entry id at mount, so navigating "in place"
// with the current route would not reload the new entry.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useSyncExternalStore, type ReactElement } from 'react';

import type { JournalListResponse, JournalMessage } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockResonanceList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: unknown[] }>
>;
const mockJournalList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
    list: (...a: unknown[]) => (mockJournalList as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockResonanceList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: jest.fn(),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
    list: jest.fn(() => Promise.resolve([])),
  },
}));

// useScreenDrawer installs the header-left toggle through useAppNavigation
// (a hook, unrelated to the navigation PROP JournalEntryScreen receives),
// so it needs its own stubbed setOptions the way CourseScreen's drawer tests
// stub it -- the relayed headerLeft renders the toggle in-tree.
const headerLeftStore: {
  current: (() => ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});
jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: mockSetOptions }),
}));
// The drawer nav section dispatches through the root stack via useNavigation;
// stub it so the entry screen renders outside a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'An existing page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function page(items: JournalMessage[], hasMore = false): JournalListResponse {
  return { items, total: items.length, has_more: hasMore };
}

interface EntryScreenWithHeaderProps {
  navigation: { navigate: jest.Mock; goBack: jest.Mock; push: jest.Mock };
  route: { key: string; name: 'JournalEntry'; params?: { entryId?: number } };
}

function EntryScreenWithHeader({ navigation, route }: EntryScreenWithHeaderProps): ReactElement {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <JournalEntryScreen navigation={navigation} route={route} />
    </>
  );
}

function renderScreen(entryId?: number) {
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const route = {
    key: 'k',
    name: 'JournalEntry' as const,
    params: entryId ? { entryId } : undefined,
  };
  const result = render(<EntryScreenWithHeader navigation={navigation} route={route} />);
  return { ...result, navigation };
}

beforeEach(() => {
  jest.clearAllMocks();
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
  mockGet.mockResolvedValue(entry());
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockResonanceList.mockResolvedValue({ items: [] });
  mockJournalList.mockResolvedValue(page([]));
});

describe('Journal header drawer from JournalEntryScreen', () => {
  it('installs a header-left drawer toggle and opens the drawer on press', async () => {
    const { getByTestId, getByLabelText } = renderScreen(7);
    await waitFor(() => expect(getByTestId('journal-title-input')).toBeTruthy());
    expect(mockSetOptions).toHaveBeenCalled();

    fireEvent.press(getByLabelText('Open Journal menu'));
    expect(getByTestId('screen-drawer')).toBeTruthy();
  });

  it('highlights the row for the current entry (from route.params.entryId)', async () => {
    mockJournalList.mockResolvedValue(page([entry({ id: 7 }), entry({ id: 8, title: 'Other' })]));
    const { getByTestId, getByLabelText } = renderScreen(7);
    await waitFor(() => expect(getByTestId('journal-title-input')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-7')).toBeTruthy());

    expect(getByTestId('journal-drawer-entry-7').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('journal-drawer-entry-8').props.accessibilityState.selected).toBe(false);
  });

  it('pushes (not navigates) to the tapped entry and closes the drawer', async () => {
    mockJournalList.mockResolvedValue(page([entry({ id: 7 }), entry({ id: 9, title: 'Other' })]));
    const { getByTestId, getByLabelText, navigation, queryByTestId } = renderScreen(7);
    await waitFor(() => expect(getByTestId('journal-title-input')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-entry-9')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-entry-9'));
    });

    expect(navigation.push).toHaveBeenCalledWith('JournalEntry', { entryId: 9 });
    expect(navigation.navigate).not.toHaveBeenCalledWith('JournalEntry', { entryId: 9 });
    expect(queryByTestId('screen-drawer')).toBeNull();
  });

  it('pushes a blank entry from New entry and closes the drawer', async () => {
    const { getByTestId, getByLabelText, navigation, queryByTestId } = renderScreen(7);
    await waitFor(() => expect(getByTestId('journal-title-input')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Journal menu'));
    await waitFor(() => expect(getByTestId('journal-drawer-new-entry')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('journal-drawer-new-entry'));
    });

    expect(navigation.push).toHaveBeenCalledWith('JournalEntry');
    expect(queryByTestId('screen-drawer')).toBeNull();
  });
});
