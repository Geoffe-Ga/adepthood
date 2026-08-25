/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * When "Get Resonance" is reachable. The gate used to require ``isIdle``, which
 * only ever flipped after a keystroke, so an entry the writer had already
 * finished could never reach it: opening a saved page and simply reading it —
 * the ordinary case — showed no affordance at all, in read mode or edit mode.
 *
 * The rule these specs pin is "is this a good moment to offer a reading", not
 * "has the writer stopped typing": on writing that already exists that moment
 * is immediately, while on a blank page it is still after a pause.
 */
import type { JournalMessage } from '@/api';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
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

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

type EntryOverrides = Partial<JournalMessage> & {
  classification?: 'public' | 'personal' | 'intimate';
};

function entry(overrides: EntryOverrides = {}): JournalMessage {
  return {
    id: 7,
    message: 'A page written days ago about the river.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'finished',
    classification: 'personal',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} autosaveDelayMs={100} />);
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('JournalEntryScreen — resonance on an entry that already exists', () => {
  it('offers resonance on a saved entry without a single keystroke', async () => {
    mockGet.mockResolvedValue(entry());
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());

    // Reachable (not hidden from the accessibility tree) and pressable.
    expect(getByTestId('get-resonance-button').props.accessibilityState.disabled).toBe(false);
  });

  it('still offers it after the writer presses Edit', async () => {
    mockGet.mockResolvedValue(entry());
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());

    fireEvent.press(getByTestId('journal-edit-button'));
    fireEvent.press(getByTestId('edit-confirm-edit'));

    await waitFor(() => expect(queryByTestId('journal-body-input')).not.toBeNull());
    expect(getByTestId('get-resonance-button').props.accessibilityState.disabled).toBe(false);
  });

  it('withholds it while a saved entry is loading, before its text is known', () => {
    // A load that never resolves: the screen must not offer a reading of an
    // entry it has not read yet.
    mockGet.mockReturnValue(new Promise<JournalMessage>(() => {}));
    const { queryByTestId } = renderScreen({ entryId: 7 });

    expect(queryByTestId('get-resonance-button')).toBeNull();
  });

  it('withholds it on a saved entry that turns out to be empty', async () => {
    mockGet.mockResolvedValue(entry({ message: '', status: 'draft' }));
    const { queryByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(queryByTestId('get-resonance-button')).toBeNull();
  });

  it('shows the intimate entry its disabled affordance and reason, unchanged', async () => {
    mockGet.mockResolvedValue(entry({ classification: 'intimate' }));
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());

    expect(getByTestId('get-resonance-button').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('privacy-resonance-reason')).toBeTruthy();
  });
});

describe('JournalEntryScreen — resonance on a blank page is still earned', () => {
  it('stays tucked away while a new entry is being composed', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderScreen();

    expect(queryByTestId('get-resonance-button')).toBeNull();
    fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS - 1);
    });
    expect(queryByTestId('get-resonance-button')).toBeNull();
  });

  it('floats in once the writing settles', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
    });

    expect(queryByTestId('get-resonance-button')).not.toBeNull();
  });
});
