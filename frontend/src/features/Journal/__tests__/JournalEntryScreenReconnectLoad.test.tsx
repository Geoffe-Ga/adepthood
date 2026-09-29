// #2935: an existing entry whose load was short-circuited offline (or failed on
// a dead connection) re-runs that load on the device's next offline -> online
// edge, lifts the entry-not-loaded gate, and never loses a word the writer typed
// into the page while it was unloaded.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { captureNetInfoListener, type NetInfoHandle } from './netInfoTestKit';

import type { JournalClassification, JournalMessage } from '@/api';
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
const HELD_HINT_PERSONAL = 'Not saved yet — waiting until this entry is Personal or more private';
const RETRY_NAME = 'Retry saving this entry';
const FLIGHT_WORDS = 'Typed while the privacy change was still on its way.';
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

type BeforeRemove = (_event: { preventDefault: () => void; data: { action: unknown } }) => void;

/**
 * One navigation double per test, so exits can be asserted across re-renders.
 * Like the real stack, ``navigate`` and ``dispatch`` first fire ``beforeRemove``
 * with the action and only take effect (``effective``) if nothing prevented it.
 */
function makeNav() {
  const listeners: Record<string, BeforeRemove | undefined> = {};
  const effective: unknown[] = [];
  const removeThenRun = (action: unknown) => {
    const preventDefault = jest.fn();
    listeners.beforeRemove?.({ preventDefault, data: { action } });
    if (preventDefault.mock.calls.length === 0) effective.push(action);
  };
  return {
    effective,
    navigate: jest.fn((...args: unknown[]) => removeThenRun({ type: 'NAVIGATE', args })),
    goBack: jest.fn(),
    push: jest.fn(),
    dispatch: jest.fn((action: unknown) => removeThenRun(action)),
    addListener: jest.fn((event: string, listener: BeforeRemove) => {
      listeners[event] = listener;
      return () => undefined;
    }),
    /** Fire the stack's removal of this screen (back gesture, hardware back). */
    removeScreen(action: unknown) {
      const preventDefault = jest.fn();
      act(() => listeners.beforeRemove?.({ preventDefault, data: { action } }));
      return preventDefault;
    },
  };
}

let nav: ReturnType<typeof makeNav>;

interface ScreenParams {
  entryId?: number;
  prefillQuote?: { text: string; sourceTitle: string };
  classification?: JournalClassification;
  returnTo?: { screen: 'Course'; params: { contentId: number } };
}

function screenElement(params?: ScreenParams) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return (
    <NetworkStatusProvider>
      <Screen navigation={nav} route={route} autosaveDelayMs={AUTOSAVE_MS} />
    </NetworkStatusProvider>
  );
}

function renderScreen(params?: ScreenParams) {
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

function hint(screen: Screen): unknown {
  return screen.getByTestId('journal-save-hint').props.children;
}

/** Tap a tier on the page and let its PATCH settle. */
async function pressTierAndSettle(screen: Screen, tier: string) {
  fireEvent.press(within(screen.getByTestId('journal-page')).getByTestId(`privacy-tier-${tier}`));
  await advance(0);
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
  nav = makeNav();
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

  it('asks before adding offline words to a finished entry, and saves them only after Edit', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ status: 'finished' }));
    const screen = await openFailed();
    await typeBody(screen, TYPED);

    await reconnect();
    await screen.findByTestId('edit-confirm-dialog');
    expect(screen.getByTestId('edit-confirm-carried-note')).toBeTruthy();
    // Read mode shows only what is stored; the held words are not presented as saved.
    expect(screen.queryByText(TYPED, { exact: false })).toBeNull();
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(mockUpdate).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('edit-confirm-edit'));
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ message: CARRIED_BODY }));
  });

  it('keeps offline words for a finished entry after Cancel, and offers them again on Edit', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ status: 'finished' }));
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await screen.findByTestId('edit-confirm-dialog');

    fireEvent.press(screen.getByTestId('edit-confirm-cancel'));
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(mockUpdate).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('journal-edit-button'));
    expect(screen.getByTestId('edit-confirm-carried-note')).toBeTruthy();
    fireEvent.press(screen.getByTestId('edit-confirm-edit'));
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ message: CARRIED_BODY }));
  });

  it('escalates a looser stored tier to the one shown while typing before saving offline words', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    const screen = await openFailed();
    expect(tierSelected(screen, 'personal')).toBe(true);
    await typeBody(screen, TYPED);

    await reconnect();
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);

    expect(mockUpdate.mock.calls).toEqual([
      [7, { classification: 'personal' }],
      [7, expect.objectContaining({ message: CARRIED_BODY })],
    ]);
    expect(tierSelected(screen, 'personal')).toBe(true);
  });

  it('keeps offline words off the page and unsaved when the tier escalation fails', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    const screen = await openFailed();
    await typeBody(screen, TYPED);

    await reconnect();
    await screen.findByTestId('journal-carry-waiting');
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);

    // The words typed under Personal are held, not on the public page.
    expect(bodyValue(screen)).toBe(SERVER_BODY);
    expect(mockUpdate.mock.calls).toEqual([[7, { classification: 'personal' }]]);
    expect(updatesCarrying(TYPED)).toEqual([]);
    // The control now tells the truth: the entry is still stored as public.
    expect(tierSelected(screen, 'public')).toBe(true);
  });

  it('never lets the close flush write held words', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await screen.findByTestId('journal-carry-waiting');

    fireEvent.press(screen.getByTestId('journal-close-entry'));
    await advance(AUTOSAVE_MS);

    expect(updatesCarrying(TYPED)).toEqual([]);
  });

  it('puts held words back and saves them once a retry makes the entry strict enough', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await screen.findByTestId('journal-carry-waiting');

    fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);

    expect(tierSelected(screen, 'personal')).toBe(true);
    expect(screen.queryByTestId('journal-carry-waiting')).toBeNull();
    const saves = updatesCarrying(TYPED);
    expect(saves).toHaveLength(1);
    const payloads = mockUpdate.mock.calls.map(([, p]) => p as Record<string, unknown>);
    const lastTier = payloads.map((p) => p.classification).lastIndexOf('personal');
    const firstCarry = payloads.findIndex((p) => String(p.message ?? '').includes(TYPED));
    expect(firstCarry).toBeGreaterThan(lastTier);
  });

  it('puts held words back once the writer chooses a strict enough tier', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await screen.findByTestId('journal-carry-waiting');

    fireEvent.press(
      within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
    );
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);

    expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'intimate' });
    expect(updatesCarrying(TYPED)).toHaveLength(1);
  });

  it('holds keystrokes typed during an in-flight escalation until the tier is confirmed', async () => {
    const escalation = deferred<JournalMessage>();
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockReturnValueOnce(escalation.promise);
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'personal' }));

    await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    expect(updatesCarrying(FLIGHT_WORDS)).toEqual([]);

    await act(async () => {
      escalation.resolve(entry({ classification: 'personal' }));
    });
    await advance(AUTOSAVE_MS);
    const saves = updatesCarrying(FLIGHT_WORDS);
    expect(saves).toHaveLength(1);
    expect(JSON.stringify(saves[0]?.[1])).toContain(JSON.stringify(TYPED).slice(1, -1));
  });

  it('never saves in-flight keystrokes under the looser tier when the escalation fails', async () => {
    const escalation = deferred<JournalMessage>();
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockReturnValueOnce(escalation.promise);
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'personal' }));
    await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);

    await act(async () => {
      escalation.reject(new Error('network'));
    });
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);
    fireEvent.press(screen.getByTestId('journal-close-entry'));
    await advance(AUTOSAVE_MS);

    expect(tierSelected(screen, 'public')).toBe(true);
    expect(updatesCarrying(FLIGHT_WORDS)).toEqual([]);
    expect(updatesCarrying(TYPED)).toEqual([]);
    expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
  });

  it('refuses Finish while in-flight keystrokes wait on a failed escalation', async () => {
    const escalation = deferred<JournalMessage>();
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'public' }));
    mockUpdate.mockReturnValueOnce(escalation.promise);
    const screen = await openFailed();
    await typeBody(screen, TYPED);
    await reconnect();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'personal' }));
    await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);
    await act(async () => {
      escalation.reject(new Error('network'));
    });
    await screen.findByTestId('journal-carry-waiting');

    fireEvent.press(screen.getByTestId('journal-finish-button'));
    await advance(AUTOSAVE_MS);

    expect(updatesCarrying(FLIGHT_WORDS)).toEqual([]);
    expect(screen.getByTestId('journal-finish-error')).toBeTruthy();
  });

  it('never escalates or re-tiers when the stored tier is already as strict', async () => {
    mockGet
      .mockRejectedValueOnce(offlineError())
      .mockResolvedValueOnce(entry({ classification: 'intimate' }));
    const screen = await openFailed();
    await typeBody(screen, TYPED);

    await reconnect();
    await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
    await advance(AUTOSAVE_MS);

    expect(mockUpdate.mock.calls).toEqual([
      [7, expect.objectContaining({ message: CARRIED_BODY })],
    ]);
    expect(tierSelected(screen, 'intimate')).toBe(true);
  });

  it('drops a pre-load debounce that would write the pre-fill over the stored body', async () => {
    const load = deferred<JournalMessage>();
    mockGet.mockReturnValueOnce(load.promise);
    const quote = { text: 'A line worth keeping.', sourceTitle: 'Rivers' };
    const screen = renderScreen({ entryId: 7, prefillQuote: quote });
    const prefill = bodyValue(screen) as string;
    fireEvent.changeText(screen.getByTestId('journal-body-input'), `${prefill} more`);
    fireEvent.changeText(screen.getByTestId('journal-body-input'), prefill);

    await act(async () => {
      load.resolve(entry());
    });
    await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));
    await advance(AUTOSAVE_MS * QUIET_WINDOWS);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  describe('leaving while words are held (#2935 round 4)', () => {
    async function heldAfterFailedEscalation(stored = 'public' as const) {
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ classification: stored }));
      mockUpdate.mockRejectedValueOnce(new Error('network'));
      const screen = await openFailed();
      await typeBody(screen, TYPED);
      await reconnect();
      await screen.findByTestId('journal-carry-waiting');
      return screen;
    }

    async function heldOnFinishedAfterCancel() {
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ status: 'finished' }));
      const screen = await openFailed();
      await typeBody(screen, TYPED);
      await reconnect();
      await screen.findByTestId('edit-confirm-dialog');
      fireEvent.press(screen.getByTestId('edit-confirm-cancel'));
      return screen;
    }

    async function pressClose(screen: Screen) {
      fireEvent.press(screen.getByTestId('journal-close-entry'));
      await advance(AUTOSAVE_MS);
    }

    it.each([
      ['a failed tier move', heldAfterFailedEscalation],
      ['a finished entry after Cancel', heldOnFinishedAfterCancel],
    ])('Close asks before leaving held words behind (%s)', async (_path, open) => {
      const screen = await open();

      await pressClose(screen);

      expect(nav.navigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('held-leave-dialog')).toBeTruthy();
      fireEvent.press(screen.getByTestId('held-leave-stay'));
      await advance(AUTOSAVE_MS);
      expect(screen.queryByTestId('held-leave-dialog')).toBeNull();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(updatesCarrying(TYPED)).toEqual([]);

      await pressClose(screen);
      fireEvent.press(screen.getByTestId('held-leave-leave'));
      await advance(AUTOSAVE_MS);
      expect(nav.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
      expect(updatesCarrying(TYPED)).toEqual([]);
    });

    it('guards Back to reading the same way', async () => {
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ classification: 'public' }));
      mockUpdate.mockRejectedValueOnce(new Error('network'));
      const returnTo = { screen: 'Course' as const, params: { contentId: 3 } };
      const screen = renderScreen({ entryId: 7, returnTo });
      await screen.findByTestId('journal-load-error');
      await typeBody(screen, TYPED);
      await reconnect();
      await screen.findByTestId('journal-carry-waiting');

      fireEvent.press(screen.getByTestId('journal-return-to-reading'));

      expect(nav.navigate).not.toHaveBeenCalled();
      fireEvent.press(screen.getByTestId('held-leave-leave'));
      expect(nav.navigate).toHaveBeenCalledWith('Tabs', returnTo);
      expect(updatesCarrying(TYPED)).toEqual([]);
    });

    it('guards the back gesture and hardware back the same way', async () => {
      const screen = await heldAfterFailedEscalation();
      const action = { type: 'GO_BACK' };

      const prevented = nav.removeScreen(action);

      expect(prevented).toHaveBeenCalled();
      expect(screen.getByTestId('held-leave-dialog')).toBeTruthy();
      fireEvent.press(screen.getByTestId('held-leave-leave'));
      expect(nav.dispatch).toHaveBeenCalledWith(action);
      // The re-dispatched removal passes the guard once: no second dialog, no loop.
      expect(nav.effective).toEqual([action]);
      expect(screen.queryByTestId('held-leave-dialog')).toBeNull();
    });

    it('offers the tier retry from the leave dialog after a failed tier move', async () => {
      const screen = await heldAfterFailedEscalation();
      await pressClose(screen);

      fireEvent.press(screen.getByTestId('held-leave-retry'));
      await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
      await advance(AUTOSAVE_MS);

      expect(nav.navigate).not.toHaveBeenCalled();
      expect(updatesCarrying(TYPED)).toHaveLength(1);
    });

    it('never saves the words after Leave without them, even when a tier write confirms later', async () => {
      const screen = await heldAfterFailedEscalation();
      const intimate = deferred<JournalMessage>();
      mockUpdate.mockClear();
      mockUpdate.mockReturnValueOnce(intimate.promise);
      fireEvent.press(
        within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
      );
      await advance(0);
      await pressClose(screen);
      fireEvent.press(screen.getByTestId('held-leave-leave'));
      await advance(0);
      expect(nav.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
      screen.unmount();

      await act(async () => {
        intimate.resolve(entry({ classification: 'intimate' }));
      });
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(updatesCarrying(TYPED)).toEqual([]);
      // No page-text PATCH at all from the screen the writer left.
      const bodyWrites = mockUpdate.mock.calls.filter(
        ([, p]) => (p as { message?: string }).message != null,
      );
      expect(bodyWrites).toEqual([]);
    });

    it('never saves the words when the tier confirms after Leave but before the screen goes', async () => {
      const screen = await heldAfterFailedEscalation();
      const intimate = deferred<JournalMessage>();
      mockUpdate.mockClear();
      mockUpdate.mockReturnValueOnce(intimate.promise);
      fireEvent.press(
        within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
      );
      await advance(0);
      await pressClose(screen);
      fireEvent.press(screen.getByTestId('held-leave-leave'));
      await advance(0);

      // The navigation has not unmounted the screen yet when the write confirms.
      await act(async () => {
        intimate.resolve(entry({ classification: 'intimate' }));
      });
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(updatesCarrying(TYPED)).toEqual([]);
      expect(bodyValue(screen)).not.toContain(TYPED);
    });

    it('still puts the words back under StrictMode, whose effect re-run is not a leave', async () => {
      // StrictMode runs the load effect twice on mount: both attempts fail offline.
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ classification: 'public' }));
      const screen = render(<React.StrictMode>{screenElement({ entryId: 7 })}</React.StrictMode>);
      await screen.findByTestId('journal-load-error');
      await typeBody(screen, TYPED);
      await reconnect();

      await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
      await advance(AUTOSAVE_MS);
      expect(updatesCarrying(TYPED)).toHaveLength(1);
    });

    it('never saves the words when the screen goes away with a tier write still out', async () => {
      const screen = await heldAfterFailedEscalation();
      const intimate = deferred<JournalMessage>();
      mockUpdate.mockClear();
      mockUpdate.mockReturnValueOnce(intimate.promise);
      fireEvent.press(
        within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
      );
      await advance(0);
      screen.unmount();

      await act(async () => {
        intimate.resolve(entry({ classification: 'intimate' }));
      });
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(updatesCarrying(TYPED)).toEqual([]);
    });

    it('closes straight away when nothing is held and the page is the stored text', async () => {
      mockGet.mockResolvedValue(entry());
      const screen = renderScreen({ entryId: 7 });
      await waitFor(() => expect(bodyValue(screen)).toBe(SERVER_BODY));

      await pressClose(screen);

      expect(screen.queryByTestId('held-leave-dialog')).toBeNull();
      expect(nav.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
      expect(nav.removeScreen({ type: 'GO_BACK' })).not.toHaveBeenCalled();
    });

    it('keeps in-view text typed during a failed move unsaved on Close', async () => {
      const escalation = deferred<JournalMessage>();
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ classification: 'public' }));
      mockUpdate.mockReturnValueOnce(escalation.promise);
      const screen = await openFailed();
      await typeBody(screen, TYPED);
      await reconnect();
      await waitFor(() =>
        expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'personal' }),
      );
      await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);
      await act(async () => {
        escalation.reject(new Error('network'));
      });

      await pressClose(screen);

      expect(nav.navigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('held-leave-dialog')).toBeTruthy();
      expect(updatesCarrying(FLIGHT_WORDS)).toEqual([]);
    });

    it.each<[JournalClassification, JournalClassification]>([
      ['public', 'personal'],
      ['personal', 'intimate'],
    ])(
      'a looser choice after a failed move (stored %s, typed under %s) keeps the words held',
      async (stored, typedUnder) => {
        mockGet
          .mockRejectedValueOnce(offlineError())
          .mockResolvedValueOnce(entry({ classification: stored }));
        mockUpdate.mockRejectedValueOnce(new Error('network'));
        // The page opens (from the route) showing the tier the words are typed under.
        const screen = renderScreen({ entryId: 7, classification: typedUnder });
        await screen.findByTestId('journal-load-error');
        expect(tierSelected(screen, typedUnder)).toBe(true);
        await typeBody(screen, TYPED);
        await reconnect();
        await screen.findByTestId('journal-carry-waiting');
        await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);

        await pressTierAndSettle(screen, stored);
        await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS} more`);
        await advance(AUTOSAVE_MS * QUIET_WINDOWS);

        expect(bodyValue(screen)).not.toContain(TYPED);
        expect(updatesCarrying(TYPED)).toEqual([]);
        expect(updatesCarrying(FLIGHT_WORDS)).toEqual([]);
        expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
      },
    );

    it('lifts the gate on a confirmed stricter choice: one save under it, and Finish works', async () => {
      const screen = await heldAfterFailedEscalation();

      await pressTierAndSettle(screen, 'intimate');
      await waitFor(() => expect(bodyValue(screen)).toBe(CARRIED_BODY));
      await advance(AUTOSAVE_MS);
      mockUpdate.mockClear();
      await typeBody(screen, `${CARRIED_BODY} Later.`);

      const saves = mockUpdate.mock.calls.filter(([, p]) => 'message' in (p as object));
      expect(saves).toHaveLength(1);
      expect(tierSelected(screen, 'intimate')).toBe(true);
      expect(mockUpdate.mock.calls.some(([, p]) => 'classification' in (p as object))).toBe(false);

      fireEvent.press(screen.getByTestId('journal-finish-button'));
      await advance(AUTOSAVE_MS);
      expect(screen.queryByTestId('journal-finish-error')).toBeNull();
      expect(mockUpdate).toHaveBeenLastCalledWith(
        7,
        expect.objectContaining({ status: 'finished' }),
      );
    });

    describe('after a looser choice (#2935 round 5)', () => {
      async function heldAfterLooserChoice() {
        const screen = await heldAfterFailedEscalation();
        await pressTierAndSettle(screen, 'public');
        await typeBody(screen, `${SERVER_BODY} ${FLIGHT_WORDS}`);
        return screen;
      }

      it('never says Saved while words are held', async () => {
        const screen = await heldAfterLooserChoice();

        expect(hint(screen)).not.toBe(SAVED_HINT);
        expect(hint(screen)).toBe(HELD_HINT_PERSONAL);
      });

      it('offers Retry, which re-sends the typed-under tier and then saves under it', async () => {
        const screen = await heldAfterLooserChoice();
        mockUpdate.mockClear();

        fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
        await waitFor(() => expect(bodyValue(screen)).toContain(TYPED));
        await advance(AUTOSAVE_MS);

        expect(mockUpdate.mock.calls[0]).toEqual([7, { classification: 'personal' }]);
        expect(tierSelected(screen, 'personal')).toBe(true);
        expect(updatesCarrying(TYPED)).toHaveLength(1);
        expect(updatesCarrying(FLIGHT_WORDS)).toHaveLength(1);
        expect(screen.queryByTestId('journal-carry-waiting')).toBeNull();
      });

      it('keeps the words held when the re-send fails', async () => {
        const screen = await heldAfterLooserChoice();
        mockUpdate.mockClear();
        mockUpdate.mockRejectedValueOnce(new Error('network'));

        fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
        await advance(AUTOSAVE_MS * QUIET_WINDOWS);

        expect(mockUpdate.mock.calls).toEqual([[7, { classification: 'personal' }]]);
        expect(bodyValue(screen)).not.toContain(TYPED);
        expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
        expect(hint(screen)).toBe(HELD_HINT_PERSONAL);
        expect(screen.getByRole('button', { name: RETRY_NAME })).toBeTruthy();
      });

      it('lets the leave dialog re-send the typed-under tier too', async () => {
        const screen = await heldAfterLooserChoice();
        mockUpdate.mockClear();
        await pressClose(screen);

        fireEvent.press(screen.getByTestId('held-leave-retry'));
        await waitFor(() => expect(bodyValue(screen)).toContain(TYPED));
        await advance(AUTOSAVE_MS);

        expect(mockUpdate.mock.calls[0]).toEqual([7, { classification: 'personal' }]);
        expect(updatesCarrying(TYPED)).toHaveLength(1);
        expect(nav.effective).toEqual([]);
      });

      it('says in the leave dialog that text written on the page is unsaved too', async () => {
        const screen = await heldAfterLooserChoice();
        await pressClose(screen);

        const dialog = within(screen.getByTestId('held-leave-dialog'));
        expect(dialog.getByText(/written here since/)).toBeTruthy();
      });
    });

    describe("while the writer's own tier change is on its way (#2935 round 6)", () => {
      /** Held after a failed move, then the writer taps Intimate and it stays in flight. */
      async function heldWithWriterTierInFlight() {
        const screen = await heldAfterFailedEscalation();
        const intimate = deferred<JournalMessage>();
        mockUpdate.mockClear();
        mockUpdate.mockReturnValueOnce(intimate.promise);
        fireEvent.press(
          within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
        );
        await advance(0);
        return { screen, intimate };
      }

      it('hides Retry, then puts the words back under Intimate with no downgrade', async () => {
        const { screen, intimate } = await heldWithWriterTierInFlight();

        expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
        await act(async () => {
          intimate.resolve(entry({ classification: 'intimate' }));
        });
        await waitFor(() => expect(bodyValue(screen)).toContain(TYPED));
        await advance(AUTOSAVE_MS);

        const tiers = mockUpdate.mock.calls
          .map(([, p]) => (p as { classification?: string }).classification)
          .filter((t) => t != null);
        expect(tiers).toEqual(['intimate']);
        expect(tierSelected(screen, 'intimate')).toBe(true);
        expect(updatesCarrying(TYPED)).toHaveLength(1);
      });

      it('ignores a Retry pressed in the same instant as the tier change', async () => {
        // Retry is still on screen when the writer taps Intimate and then Retry
        // before React re-renders (both presses in one act, so the second hits
        // the Retry rendered as ready). resendCarryTier itself must refuse while
        // the tap's write is out: a second tier write would race the writer's.
        const screen = await heldAfterFailedEscalation();
        const intimate = deferred<JournalMessage>();
        mockUpdate.mockClear();
        mockUpdate.mockReturnValueOnce(intimate.promise);
        const retry = screen.getByRole('button', { name: RETRY_NAME });
        act(() => {
          fireEvent.press(
            within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-intimate'),
          );
          fireEvent.press(retry);
        });
        await advance(0);
        expect(mockUpdate.mock.calls).toEqual([[7, { classification: 'intimate' }]]);

        await act(async () => {
          intimate.resolve(entry({ classification: 'intimate' }));
        });
        await advance(AUTOSAVE_MS * QUIET_WINDOWS);

        const tiers = mockUpdate.mock.calls
          .map(([, p]) => (p as { classification?: string }).classification)
          .filter((t) => t != null);
        expect(tiers).toEqual(['intimate']);
        expect(tierSelected(screen, 'intimate')).toBe(true);
      });

      it("sends the writer's stricter choice after the escalation, and never lowers it", async () => {
        const escalation = deferred<JournalMessage>();
        mockGet
          .mockRejectedValueOnce(offlineError())
          .mockResolvedValueOnce(entry({ classification: 'public' }));
        mockUpdate.mockReturnValueOnce(escalation.promise);
        const screen = await openFailed();
        await typeBody(screen, TYPED);
        await reconnect();
        await waitFor(() =>
          expect(mockUpdate).toHaveBeenCalledWith(7, { classification: 'personal' }),
        );

        // Tier writes are serialized (round 8): the tap waits for the escalation.
        await pressTierAndSettle(screen, 'intimate');
        expect(mockUpdate).not.toHaveBeenCalledWith(7, { classification: 'intimate' });
        await act(async () => {
          escalation.resolve(entry({ classification: 'personal' }));
        });
        await waitFor(() => expect(bodyValue(screen)).toContain(TYPED));
        await advance(AUTOSAVE_MS);

        const tiers = mockUpdate.mock.calls
          .map(([, p]) => (p as { classification?: string }).classification)
          .filter((t) => t != null);
        expect(tiers).toEqual(['personal', 'intimate']);
        expect(updatesCarrying(TYPED)).toHaveLength(1);
        expect(tierSelected(screen, 'intimate')).toBe(true);
      });

      it('keeps the control on the tier sent when a failed tap had the #2930 retry queued behind it', async () => {
        const screen = await heldAfterFailedEscalation();
        const tap = deferred<JournalMessage>();
        mockUpdate.mockClear();
        mockUpdate
          .mockReturnValueOnce(tap.promise)
          .mockResolvedValueOnce(entry({ classification: 'personal' }));
        fireEvent.press(
          within(screen.getByTestId('journal-page')).getByTestId('privacy-tier-personal'),
        );
        await advance(0);
        // The reconnect's #2930 retry of the failed Personal waits behind the tap.
        await reconnect();
        await advance(0);

        await act(async () => {
          tap.reject(new Error('network'));
        });
        await waitFor(() => expect(bodyValue(screen)).toContain(TYPED));
        await advance(AUTOSAVE_MS);

        const tiers = mockUpdate.mock.calls
          .map(([, p]) => (p as { classification?: string }).classification)
          .filter((t) => t != null);
        expect(tiers).toEqual(['personal', 'personal']);
        // The server holds Personal, and so does the control.
        expect(tierSelected(screen, 'personal')).toBe(true);
        expect(tierSelected(screen, 'public')).toBe(false);
        expect(updatesCarrying(TYPED)).toHaveLength(1);
      });

      it('does not offer Try saving again in the leave dialog meanwhile', async () => {
        const { screen } = await heldWithWriterTierInFlight();

        await pressClose(screen);

        expect(screen.getByTestId('held-leave-dialog')).toBeTruthy();
        expect(screen.queryByTestId('held-leave-retry')).toBeNull();
      });
    });
  });

  describe('release follows confirmed server writes only (#2935 round 7)', () => {
    const MAX_SETTLE_ROUNDS = 12;
    const STRICTNESS: Record<JournalClassification, number> = {
      public: 0,
      personal: 1,
      intimate: 2,
    };

    /**
     * A server double: every tier PATCH waits for the test to settle it, and the
     * row's tier (``row``) moves only when one succeeds. Each message PATCH
     * records the row's tier at the moment it was sent.
     */
    function serverDouble() {
      const tierWrites: {
        tier: JournalClassification;
        settle: (ok: boolean) => Promise<void>;
        settled: boolean;
      }[] = [];
      const messages: { message: string; rowTier: JournalClassification }[] = [];
      const state = {
        row: 'public' as JournalClassification,
        autoSettle: false,
        /** When set, a successful tier write stores (and reports) this tier instead. */
        storesAs: null as JournalClassification | null,
        /**
         * Commit order ≠ response order: the server commits each tier write the
         * moment it arrives, whatever its response later says, and responses
         * are delivered whenever the test settles them.
         */
        commitAtSend: false,
      };
      mockUpdate.mockImplementation((_id, payload) => {
        const p = payload as { classification?: JournalClassification; message?: string };
        if (p.classification != null) {
          const tier = p.classification;
          if (state.autoSettle) {
            state.row = tier;
            return Promise.resolve(entry({ classification: tier }));
          }
          const write = deferred<JournalMessage>();
          const committed = state.storesAs ?? tier;
          if (state.commitAtSend) state.row = committed;
          const record = {
            tier,
            settled: false,
            settle: async (ok: boolean) => {
              record.settled = true;
              await act(async () => {
                if (ok) {
                  const stored = state.commitAtSend ? committed : (state.storesAs ?? tier);
                  if (!state.commitAtSend) state.row = stored;
                  write.resolve(entry({ classification: stored }));
                } else {
                  write.reject(new Error('network'));
                }
              });
              await advance(0);
            },
          };
          tierWrites.push(record);
          return write.promise;
        }
        if (p.message != null) messages.push({ message: p.message, rowTier: state.row });
        return Promise.resolve(entry({ classification: state.row }));
      });
      return { tierWrites, messages, state };
    }

    /** Stored public, words typed under Personal, the escalation to Personal out. */
    async function escalationOut(options: { commitAtSend?: boolean } = {}) {
      mockGet
        .mockRejectedValueOnce(offlineError())
        .mockResolvedValueOnce(entry({ classification: 'public' }));
      const server = serverDouble();
      server.state.commitAtSend = options.commitAtSend ?? false;
      const screen = await openFailed();
      await typeBody(screen, TYPED);
      await reconnect();
      await waitFor(() => expect(server.tierWrites).toHaveLength(1));
      expect(server.tierWrites[0]?.tier).toBe('personal');
      return { screen, server };
    }

    async function tapTier(screen: Screen, tier: JournalClassification) {
      fireEvent.press(
        within(screen.getByTestId('journal-page')).getByTestId(`privacy-tier-${tier}`),
      );
      await advance(0);
    }

    /**
     * Answer every tier write the page sends, ``outcome(index)`` deciding each.
     * Tier writes are serialized (round 8): only one is ever out, so responses
     * can only arrive in send order. Out-of-order delivery is pinned where it
     * can still be expressed, in the ``confirmTierWrite`` unit rows.
     */
    async function settleAll(
      server: ReturnType<typeof serverDouble>,
      outcome: (index: number) => boolean,
    ) {
      for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
        const index = server.tierWrites.findIndex((w) => !w.settled);
        if (index === -1) return;
        expect(server.tierWrites.filter((w) => !w.settled)).toHaveLength(1);
        await server.tierWrites[index]?.settle(outcome(index));
      }
    }

    function carried(server: ReturnType<typeof serverDouble>) {
      return server.messages.filter((m) => m.message.includes(TYPED));
    }

    it('trusts the tier the server reports storing, not the tier it was sent', async () => {
      const { screen, server } = await escalationOut();
      server.state.storesAs = 'public';

      await server.tierWrites[0]?.settle(true);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.messages).toEqual([]);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
    });

    it('a queued stricter tap the server stores looser never releases', async () => {
      const { screen, server } = await escalationOut();
      await tapTier(screen, 'intimate');
      await server.tierWrites[0]?.settle(false);
      expect(server.tierWrites.map((w) => w.tier)).toEqual(['personal', 'intimate']);

      server.state.storesAs = 'public';
      await server.tierWrites[1]?.settle(true);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.messages).toEqual([]);
      expect(bodyValue(screen)).not.toContain(TYPED);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
    });

    it('review (a): a looser tap committed on arrival never releases onto its row', async () => {
      const { screen, server } = await escalationOut({ commitAtSend: true });
      await tapTier(screen, 'public');

      // Both succeed, in send order (the only order serialized writes allow).
      await settleAll(server, () => true);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.state.row).toBe('public');
      expect(server.messages).toEqual([]);
      expect(bodyValue(screen)).not.toContain(TYPED);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
    });

    it('review (b): a looser write that fails after committing never releases', async () => {
      const { screen, server } = await escalationOut({ commitAtSend: true });
      await tapTier(screen, 'public');

      await settleAll(server, (i) => i === 0);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.state.row).toBe('public');
      expect(server.messages).toEqual([]);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
      expect(screen.getByRole('button', { name: RETRY_NAME })).toBeTruthy();
    });

    it('queues a tap behind the write in flight and sends only the last one', async () => {
      const { screen, server } = await escalationOut();

      await tapTier(screen, 'public');
      await tapTier(screen, 'intimate');
      expect(server.tierWrites.map((w) => w.tier)).toEqual(['personal']);
      expect(tierSelected(screen, 'intimate')).toBe(true);

      await server.tierWrites[0]?.settle(true);
      expect(server.tierWrites.map((w) => w.tier)).toEqual(['personal', 'intimate']);
      await server.tierWrites[1]?.settle(true);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.state.row).toBe('intimate');
      expect(carried(server)).toHaveLength(1);
    });

    it('repro B: tapping the shown tier then failing never releases', async () => {
      const { screen, server } = await escalationOut();
      await tapTier(screen, 'personal');

      await settleAll(server, () => false);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.messages).toEqual([]);
      expect(bodyValue(screen)).not.toContain(TYPED);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
      expect(screen.getByRole('button', { name: RETRY_NAME })).toBeTruthy();
    });

    it('repro A: a stricter tap and its re-assert both failing never release', async () => {
      const { screen, server } = await escalationOut();
      await tapTier(screen, 'intimate');

      await server.tierWrites[0]?.settle(false);
      for (let i = 1; i < server.tierWrites.length; i += 1) {
        await server.tierWrites[i]?.settle(false);
      }
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.messages).toEqual([]);
      expect(bodyValue(screen)).not.toContain(TYPED);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
      expect(screen.getByRole('button', { name: RETRY_NAME })).toBeTruthy();
    });

    it('releases once, under the confirmed tier, when the tap succeeds and the escalation fails', async () => {
      const { screen, server } = await escalationOut();
      await tapTier(screen, 'personal');

      await settleAll(server, (i) => i === 1);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(carried(server)).toEqual([expect.objectContaining({ rowTier: 'personal' })]);
      expect(screen.queryByTestId('journal-carry-waiting')).toBeNull();
    });

    it('never releases when every tier write fails', async () => {
      const { screen, server } = await escalationOut();
      await server.tierWrites[0]?.settle(false);
      fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
      await advance(0);
      await server.tierWrites[1]?.settle(false);
      await tapTier(screen, 'intimate');
      for (let i = 2; i < server.tierWrites.length; i += 1) {
        await server.tierWrites[i]?.settle(false);
      }
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(server.messages).toEqual([]);
      expect(screen.getByTestId('journal-carry-waiting')).toBeTruthy();
    });

    it('releases exactly once when a success arrives after a failure', async () => {
      const { screen, server } = await escalationOut();
      await tapTier(screen, 'intimate');

      await settleAll(server, (i) => i === 1);
      await advance(AUTOSAVE_MS * QUIET_WINDOWS);

      expect(carried(server)).toHaveLength(1);
      expect(carried(server)[0]?.rowTier).toBe('intimate');
      expect(tierSelected(screen, 'intimate')).toBe(true);
    });

    type Tap = 'personal' | 'intimate' | 'public';
    const TAPS: Tap[] = ['personal', 'intimate', 'public'];
    const BOOLS = [true, false];
    type Case = [boolean, Tap, boolean, boolean, boolean];
    // No response-order dimension: tier writes are serialized, so every
    // response arrives in send order (see ``settleAll``).
    type Setup = [boolean, Tap, boolean];
    const setups: Setup[] = BOOLS.flatMap((e) =>
      TAPS.flatMap((tap) => BOOLS.map((k): Setup => [e, tap, k])),
    );
    const cases: Case[] = setups.flatMap(([escalationOk, tap, tapOk]) =>
      BOOLS.flatMap((commitAtSend) =>
        BOOLS.map((retry): Case => [escalationOk, tap, tapOk, commitAtSend, retry]),
      ),
    );

    /**
     * The escalation out with the writer's tap queued behind it. With
     * ``retryWhileQueued`` the first escalation fails and Retry re-sends it,
     * and then, with the tap still waiting, a reconnect fires the #2930 retry
     * of that failed tier. Returns the escalation's write index.
     */
    async function tapQueuedBehindEscalation(
      commitAtSend: boolean,
      tap: Tap,
      retryWhileQueued: boolean,
    ) {
      const { screen, server } = await escalationOut({ commitAtSend });
      if (retryWhileQueued) {
        await server.tierWrites[0]?.settle(false);
        fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
        await advance(0);
      }
      const escalation = server.tierWrites.length - 1;
      await tapTier(screen, tap);
      if (retryWhileQueued) await reconnect();
      // The tap is still queued: nothing past the escalation has been sent.
      expect(server.tierWrites).toHaveLength(escalation + 1);
      return { screen, server, escalation };
    }

    it.each(cases)(
      'escalation ok=%s, tap %s ok=%s, commit-at-send=%s, retry while the tap is queued=%s: carried words go out only under a confirmed strict tier',
      async (escalationOk, tap, tapOk, commitAtSend, retryWhileQueued) => {
        const { screen, server, escalation } = await tapQueuedBehindEscalation(
          commitAtSend,
          tap,
          retryWhileQueued,
        );
        const outcome = (i: number) =>
          i === escalation ? escalationOk : i === escalation + 1 ? tapOk : true;
        await settleAll(server, outcome);
        await advance(AUTOSAVE_MS * QUIET_WINDOWS);

        // The writer's tap is always sent, right after the escalation: no retry
        // ever replaces it, and nothing sent after it is looser than it.
        const after = server.tierWrites.slice(escalation + 1);
        expect(after[0]?.tier).toBe(tap);
        for (const later of after) {
          expect(STRICTNESS[later.tier]).toBeGreaterThanOrEqual(STRICTNESS[tap]);
        }

        const sent = carried(server);
        expect(sent.length).toBeLessThanOrEqual(1);
        for (const m of sent) {
          expect(STRICTNESS[m.rowTier]).toBeGreaterThanOrEqual(STRICTNESS.personal);
        }
        if (sent.length === 0) expect(bodyValue(screen)).not.toContain(TYPED);
      },
    );
  });
});
