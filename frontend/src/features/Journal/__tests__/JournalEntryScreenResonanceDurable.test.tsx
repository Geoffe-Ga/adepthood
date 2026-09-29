import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { captureNetInfoListener, type NetInfoHandle } from './netInfoTestKit';

/**
 * A resonance pass reads the words the server holds, so it must never run
 * over a page whose latest write did not land (#2980).
 *
 * The plain autosave flush resolves to the entry id even when the PUT failed,
 * which let a pass charge for, and reflect on, the older stored copy. The seam
 * now asks a pass-shaped writer that answers "not saved" instead, and the margin
 * says so -- never "write a little first" to someone who has written.
 *
 * The load-bearing assertions are the negative ones: no ``resonance.generate``
 * (the only charging call) and no ``completionSuggestions.detect`` while the
 * page is unsaved.
 */
import type { JournalMessage, ResonanceResponse } from '@/api';
import { NetworkStatusProvider } from '@/context/NetworkStatusContext';
import { EMPTY_BODY_MESSAGE, UNSAVED_PAGE_MESSAGE } from '@/features/Journal/useResonance';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<
  (_e: unknown, _options?: unknown) => Promise<JournalMessage>
>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<
  (_id: number, _token?: string, _apiKey?: string | null) => Promise<ResonanceResponse>
>;
const mockDetect = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ checked: boolean; items: unknown[] }>
>;

// These specs are about what a press does to the save, not about the cost note
// in front of it: render as a reader who has already set that note aside.
jest.mock('@/storage/resonanceExplainerStorage', () => require('./resonanceExplainerTestKit'));

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

jest.mock('@/api', () => ({
  // NetworkStatusProvider registers the client's online getter on mount.
  setNetworkOnlineGetter: jest.fn(),
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    detect: (...a: unknown[]) => (mockDetect as unknown as (...x: unknown[]) => unknown)(...a),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const AUTOSAVE_MS = 100;
const ENTRY_ID = 42;
const SAVE_ERROR_HINT = "Couldn't save — keep writing, we'll retry";

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: ENTRY_ID,
    message: 'Saved words.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    classification: 'personal',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function resonancePayload(): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    care: null,
    contraction: null,
    related_praxis: [],
    related_eddies: [],
    no_notes_message: null,
  } as ResonanceResponse;
}

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    push: jest.fn(),
    dispatch: jest.fn(),
    addListener: jest.fn(() => () => undefined),
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(
    <NetworkStatusProvider>
      <Screen navigation={navigation} route={route} autosaveDelayMs={AUTOSAVE_MS} />
    </NetworkStatusProvider>,
  );
}

type Screen = ReturnType<typeof renderScreen>;

async function openLoaded(overrides: Partial<JournalMessage> = {}): Promise<Screen> {
  mockGet.mockResolvedValue(entry(overrides));
  const screen = renderScreen({ entryId: ENTRY_ID });
  await waitFor(() => {
    expect(screen.getByTestId('journal-body-input').props.value).toBeTruthy();
  });
  return screen;
}

/** Type, let the debounced save fire, then let the idle pause offer resonance. */
async function writeAndPause(screen: Screen, text: string) {
  fireEvent.changeText(screen.getByTestId('journal-body-input'), text);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
  });
}

async function pressResonance(screen: Screen) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('get-resonance-button'));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
  });
}

function marginError(screen: Screen): unknown {
  return screen.getByTestId('journal-resonance-error').props.children;
}

let net: NetInfoHandle;

beforeEach(() => {
  jest.useFakeTimers();
  net = captureNetInfoListener();
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockList.mockReset();
  mockGenerate.mockReset();
  mockDetect.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockGenerate.mockResolvedValue(resonancePayload());
  mockDetect.mockResolvedValue({ checked: true, items: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('JournalEntryScreen — no resonance pass over a page whose save failed (#2980)', () => {
  it('runs no resonance pass over a body whose latest save failed, and runs once after the save lands', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValue({ status: 500, detail: 'boom' });

    await writeAndPause(screen, 'Saved words. And new ones.');
    await pressResonance(screen);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(screen.queryByText(EMPTY_BODY_MESSAGE)).toBeNull();
    expect(marginError(screen)).toBe(UNSAVED_PAGE_MESSAGE);
    // The footer's body lane still owns the save failure and its Retry.
    expect(screen.getByTestId('journal-save-hint').props.children).toBe(SAVE_ERROR_HINT);
    expect(screen.getByTestId('journal-save-retry')).toBeTruthy();
    // Nothing charged, so no refill invitation either.
    expect(screen.queryByTestId('journal-resonance-refill')).toBeNull();

    mockUpdate.mockResolvedValue(entry({ message: 'Saved words. And new ones.' }));
    await pressResonance(screen);

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(mockGenerate.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(screen.queryByTestId('journal-resonance-error')).toBeNull();
  });

  it('tells a new page whose first save failed that it has not saved, not to write more', async () => {
    mockCreate.mockRejectedValue({ status: 500, detail: 'boom' });
    const screen = renderScreen();

    await writeAndPause(screen, 'A first page that never reached the server.');
    await pressResonance(screen);

    expect(mockCreate).toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(screen.queryByText(EMPTY_BODY_MESSAGE)).toBeNull();
    expect(marginError(screen)).toBe(UNSAVED_PAGE_MESSAGE);
  });

  it('read mode: a finished, already-durable page runs its pass with no extra write', async () => {
    mockGet.mockResolvedValue(entry({ status: 'finished' }));
    const screen = renderScreen({ entryId: ENTRY_ID });
    await waitFor(() => expect(screen.queryByTestId('journal-edit-button')).not.toBeNull());

    await pressResonance(screen);

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(mockGenerate.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('journal-resonance-error')).toBeNull();
  });
});

describe('JournalEntryScreen — no resonance pass while carried words are held (#2935)', () => {
  const SERVER_BODY = 'Saved words.';
  const TYPED = 'Words written while the page would not open.';
  const CARRIED_BODY = `${SERVER_BODY}\n\n${TYPED}`;
  const RETRY_NAME = 'Retry saving this entry';

  /** The rejection the API client raises for a GET short-circuited while offline. */
  function offlineError(): Error {
    return Object.assign(new Error('network_error'), { status: 0 });
  }

  it('runs no pass over the stored copy while offline-typed words are held, then one pass once they save', async () => {
    // Stored looser than the tier shown while typing, and the escalation fails:
    // the typed words are held off the page, so every flush reports not-durable.
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockRejectedValueOnce(new Error('network')).mockResolvedValue(entry());
    const screen = renderScreen({ entryId: ENTRY_ID });
    await screen.findByTestId('journal-load-error');
    fireEvent.changeText(screen.getByTestId('journal-body-input'), TYPED);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    });
    await net.emit(false);
    await net.emit(true);
    await screen.findByTestId('journal-carry-waiting');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
    });
    expect(screen.getByTestId('journal-body-input').props.value).toBe(SERVER_BODY);

    await pressResonance(screen);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(screen.queryByText(EMPTY_BODY_MESSAGE)).toBeNull();
    expect(marginError(screen)).toBe(UNSAVED_PAGE_MESSAGE);
    expect(screen.queryByTestId('journal-resonance-refill')).toBeNull();

    // The retry confirms the stricter tier, which puts the words back and saves them.
    fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
    await waitFor(() =>
      expect(screen.getByTestId('journal-body-input').props.value).toBe(CARRIED_BODY),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    });
    expect(screen.queryByTestId('journal-carry-waiting')).toBeNull();

    await pressResonance(screen);

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(mockGenerate.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(screen.queryByTestId('journal-resonance-error')).toBeNull();
  });
});
