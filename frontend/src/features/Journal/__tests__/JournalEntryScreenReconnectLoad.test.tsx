// #2935: an existing entry whose load was short-circuited offline (or failed on
// a dead connection) re-runs that load on the device's next offline -> online
// edge, lifts the entry-not-loaded gate, and never loses a word the writer typed
// into the page while it was unloaded.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { captureNetInfoListener, type NetInfoHandle } from './netInfoTestKit';

import type { JournalMessage } from '@/api';
import { NetworkStatusProvider } from '@/context/NetworkStatusContext';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<
  (_e: unknown, _options?: unknown) => Promise<JournalMessage>
>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockRespond = jest.fn() as jest.MockedFunction<
  (_week: number, _body: string, _options: unknown) => Promise<unknown>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  // NetworkStatusProvider registers the client's online getter on mount.
  setNetworkOnlineGetter: jest.fn(),
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    respond: (...a: unknown[]) => (mockRespond as unknown as (...x: unknown[]) => unknown)(...a),
  },
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

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const AUTOSAVE_MS = 100;
const SERVER_BODY = 'A page about rivers.';
const REVISED_BODY = 'A page about rivers, revisited.';
const TYPED = 'Words written while the page would not open.';
const CARRIED_BODY = `${SERVER_BODY}\n\n${TYPED}`;
const EIGHT_BODY = 'A page about mountains.';
const SAVED_HINT = 'Saved';
/** Autosave windows to wait while online, proving nothing retries without an edge. */
const QUIET_WINDOWS = 10;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: SERVER_BODY,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

/** The rejection the API client raises for a GET short-circuited while offline. */
function offlineError(): Error {
  return Object.assign(new Error('network_error'), { status: 0 });
}

let net: NetInfoHandle;

function screenElement(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return (
    <NetworkStatusProvider>
      <Screen navigation={navigation} route={route} autosaveDelayMs={AUTOSAVE_MS} />
    </NetworkStatusProvider>
  );
}

function renderScreen(params?: { entryId?: number }) {
  return render(screenElement(params));
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function deferred<T>() {
  let resolve: (_value: T) => void = () => undefined;
  let reject: (_error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Screen = ReturnType<typeof renderScreen>;

function bodyValue(screen: Screen): unknown {
  return screen.getByTestId('journal-body-input').props.value;
}

function tierSelected(screen: Screen, tier: string): boolean {
  const page = within(screen.getByTestId('journal-page'));
  return page.getByTestId(`privacy-tier-${tier}`).props.accessibilityState.selected;
}

function updatesCarrying(text: string): unknown[][] {
  return mockUpdate.mock.calls.filter(([, payload]) =>
    JSON.stringify(payload).includes(JSON.stringify(text).slice(1, -1)),
  );
}

/** Open entry 7 with its first load failing, and wait for the banner. */
async function openFailed(): Promise<Screen> {
  const screen = renderScreen({ entryId: 7 });
  await screen.findByTestId('journal-load-error');
  return screen;
}

async function typeBody(screen: Screen, text: string) {
  fireEvent.changeText(screen.getByTestId('journal-body-input'), text);
  await advance(AUTOSAVE_MS);
}

/** Flip the device offline then back online: one reconnect edge. */
async function reconnect() {
  await net.emit(false);
  await net.emit(true);
}

beforeEach(() => {
  jest.useFakeTimers();
  net = captureNetInfoListener();
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockRespond.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry());
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('reconnect reload of an unloaded entry (#2935)', () => {
  it('re-runs a short-circuited entry load once on reconnect and lifts the load gate', async () => {
    mockGet.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(entry());
    const { findByTestId, getByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    await findByTestId('journal-load-error');
    expect(mockGet).toHaveBeenCalledTimes(1);

    await reconnect();

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet).toHaveBeenLastCalledWith(7);
    await waitFor(() => expect(queryByTestId('journal-load-error')).toBeNull());
    expect(getByTestId('journal-body-input').props.value).toBe(SERVER_BODY);
    expect(getByTestId('privacy-tier-personal').props.accessibilityState.disabled).toBeFalsy();
    expect(getByTestId('aspect-chord-trigger').props.accessibilityState.disabled).toBeFalsy();
    expect(mockUpdate).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId('journal-body-input'), REVISED_BODY);
    await advance(AUTOSAVE_MS);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ message: REVISED_BODY }));
  });

  it('does not reload an entry that already loaded on an online edge', async () => {
    mockGet.mockResolvedValue(entry());
    const screen = renderScreen({ entryId: 7 });
    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));

    await reconnect();
    await reconnect();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('keeps one reload in flight across repeated edges and re-renders', async () => {
    const reload = deferred<JournalMessage>();
    mockGet.mockRejectedValueOnce(offlineError()).mockReturnValueOnce(reload.promise);
    const screen = await openFailed();

    await reconnect();
    await reconnect();
    screen.rerender(screenElement({ entryId: 7 }));
    expect(mockGet).toHaveBeenCalledTimes(2);

    await act(async () => {
      reload.resolve(entry());
    });
    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('journal-load-error')).toBeNull();
  });

  it('ignores a late reload response after unmount', async () => {
    const reload = deferred<JournalMessage>();
    mockGet.mockRejectedValueOnce(offlineError()).mockReturnValueOnce(reload.promise);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const screen = await openFailed();
      fireEvent.changeText(screen.getByTestId('journal-body-input'), TYPED);
      await reconnect();
      screen.unmount();

      await act(async () => {
        reload.resolve(entry());
      });
      await advance(AUTOSAVE_MS);

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a reload that fails again keeps the gate and retries only on the next edge', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry());
    const screen = await openFailed();

    await reconnect();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('journal-load-error')).toBeTruthy();
    const tier = screen.getByTestId('privacy-tier-personal');
    expect(tier.props.accessibilityState.disabled).toBe(true);
    await typeBody(screen, TYPED);
    expect(mockUpdate).not.toHaveBeenCalled();

    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(mockGet).toHaveBeenCalledTimes(2);

    await reconnect();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByTestId('journal-load-error')).toBeNull());
    expect(screen.getByTestId('privacy-tier-personal').props.accessibilityState.disabled).toBe(
      false,
    );
    expect(bodyValue(screen)).toBe(CARRIED_BODY);
  });

  it('applies the server copy exactly on an untouched page', async () => {
    mockGet.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(
      entry({
        title: 'Rivers',
        classification: 'intimate',
        primary_aspect: 3,
        secondary_aspect: null,
      }),
    );
    const screen = await openFailed();

    await reconnect();

    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));
    expect(screen.getByTestId('journal-title-input').props.value).toBe('Rivers');
    expect(tierSelected(screen, 'intimate')).toBe(true);
    const page = within(screen.getByTestId('journal-page'));
    expect(page.getByTestId('aspect-primary-3')).toBeTruthy();
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps and saves text typed while the entry was unloaded', async () => {
    mockGet.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(entry());
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    expect(mockUpdate).not.toHaveBeenCalled();

    await reconnect();

    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    expect(screen.getByTestId('journal-title-input').props.value).toBe('Rivers');
    await advance(AUTOSAVE_MS);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ message: CARRIED_BODY }));
  });

  it('keeps and saves text typed while the first load was still in flight', async () => {
    const load = deferred<JournalMessage>();
    mockGet.mockReturnValueOnce(load.promise);
    const screen = renderScreen({ entryId: 7 });
    await typeBody(screen, TYPED);

    await act(async () => {
      load.resolve(entry());
    });

    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ message: CARRIED_BODY }));
  });

  it('never carries text typed on one entry into another route entry', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ id: 8, message: EIGHT_BODY }));
    const screen = await openFailed();
    await typeBody(screen, TYPED);

    screen.rerender(screenElement({ entryId: 8 }));

    await waitFor(() => expect(bodyValue(screen)).toBe(EIGHT_BODY));
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(updatesCarrying(TYPED)).toEqual([]);
  });

  it('never carries text typed on a later route entry back into the first', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry());
    const screen = await openFailed();
    screen.rerender(screenElement({ entryId: 8 }));
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith(8));
    await typeBody(screen, TYPED);

    screen.rerender(screenElement({ entryId: 7 }));

    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(updatesCarrying(TYPED)).toEqual([]);
  });

  it('seeds persist from the server copy after a reconnect load', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'intimate' }));
    const screen = await openFailed();
    await reconnect();
    await waitFor(() => expect(tierSelected(screen, 'intimate')).toBe(true));
    mockUpdate.mockRejectedValueOnce(new Error('network'));

    fireEvent.press(within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-public'));
    await advance(0);

    expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'public' });
    await waitFor(() => expect(tierSelected(screen, 'intimate')).toBe(true));
  });

  it('a fresh entry never loads on reconnect', async () => {
    const screen = renderScreen();
    await advance(AUTOSAVE_MS);

    await reconnect();
    await reconnect();

    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('journal-load-error')).toBeNull();
  });

  it('does not re-fetch after a successful reconnect load across re-renders and typing', async () => {
    mockGet.mockRejectedValueOnce(offlineError()).mockResolvedValue(entry());
    const screen = await openFailed();
    await reconnect();
    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));

    await typeBody(screen, REVISED_BODY);
    await typeBody(screen, `${REVISED_BODY} Again.`);
    screen.rerender(screenElement({ entryId: 7 }));
    await reconnect();

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('no save or create fires on the reconnect edge for an untouched page', async () => {
    mockGet.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(entry());
    const screen = await openFailed();

    await reconnect();
    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRespond).not.toHaveBeenCalled();
    // Nothing was written, so the footer must not claim a save either.
    expect(screen.getByTestId('journal-save-hint').props.children).not.toBe(SAVED_HINT);
  });

  it('ignores a stale load response for the entry the screen has moved off', async () => {
    const stale = deferred<JournalMessage>();
    mockGet
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(entry({ id: 8, message: EIGHT_BODY }));
    const screen = renderScreen({ entryId: 7 });
    screen.rerender(screenElement({ entryId: 8 }));
    await waitFor(() => expect(bodyValue(screen)).toBe(EIGHT_BODY));

    await act(async () => {
      stale.resolve(entry());
    });

    expect(bodyValue(screen)).toBe(EIGHT_BODY);
  });

  it('ignores a stale load failure for the entry the screen has moved off', async () => {
    const stale = deferred<JournalMessage>();
    mockGet
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(entry({ id: 8, message: EIGHT_BODY }));
    const screen = renderScreen({ entryId: 7 });
    screen.rerender(screenElement({ entryId: 8 }));
    await waitFor(() => expect(bodyValue(screen)).toBe(EIGHT_BODY));

    await act(async () => {
      stale.reject(offlineError());
    });

    expect(screen.queryByTestId('journal-load-error')).toBeNull();
  });
});
