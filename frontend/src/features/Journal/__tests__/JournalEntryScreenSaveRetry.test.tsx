// #2930: the footer Retry re-sends whatever actually failed, one lane's success
// never clears another lane's failure, and coming back online retries once.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { captureNetInfoListener, type NetInfoHandle } from './netInfoTestKit';

import type { JournalMessage } from '@/api';
import { NetworkStatusProvider } from '@/context/NetworkStatusContext';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
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
const SAVE_ERROR_HINT = "Couldn't save — keep writing, we'll retry";
const RETRY_NAME = 'Retry saving this entry';

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'A page about rivers.',
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

function deferred<T>() {
  let resolve: (_value: T) => void = () => undefined;
  let reject: (_error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let net: NetInfoHandle;

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(
    <NetworkStatusProvider>
      <Screen navigation={navigation} route={route} autosaveDelayMs={AUTOSAVE_MS} />
    </NetworkStatusProvider>,
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openLoaded(overrides: Partial<JournalMessage> = {}) {
  mockGet.mockResolvedValue(entry(overrides));
  const screen = renderScreen({ entryId: 7 });
  await waitFor(() => {
    expect(screen.getByTestId('journal-body-input').props.value).toBeTruthy();
  });
  mockUpdate.mockClear();
  return screen;
}

type Screen = ReturnType<typeof renderScreen>;

async function typeBody(screen: Screen, text: string) {
  fireEvent.changeText(screen.getByTestId('journal-body-input'), text);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
  });
  await settle();
}

async function pressRetry(screen: Screen) {
  fireEvent.press(screen.getByRole('button', { name: RETRY_NAME }));
  await settle();
}

function hint(screen: Screen): unknown {
  return screen.getByTestId('journal-save-hint').props.children;
}

function tierSelected(screen: Screen, tier: string): boolean {
  const page = within(screen.getByTestId('journal-page'));
  return page.getByTestId(`privacy-tier-${tier}`).props.accessibilityState.selected;
}

async function pressTier(screen: Screen, tier: string) {
  fireEvent.press(within(screen.getByTestId('journal-page')).getByTestId(`privacy-tier-${tier}`));
  await settle();
}

async function pickPrimaryAspect(screen: Screen, aspect: number) {
  fireEvent.press(within(screen.getByTestId('journal-page')).getByTestId('aspect-chord-trigger'));
  fireEvent.press(
    within(screen.getByTestId('journal-page')).getByTestId(`aspect-primary-${aspect}`),
  );
  await settle();
}

function updatesCarrying(key: string): unknown[][] {
  return mockUpdate.mock.calls.filter(([, payload]) => key in (payload as object));
}

beforeEach(() => {
  jest.useFakeTimers();
  net = captureNetInfoListener();
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry());
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('one lane succeeding never clears another lane’s failure (#2930)', () => {
  it('keeps a body failure owed through a successful tier and chord change, and Retry re-sends it', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A page about rivers, and the sea.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await pressTier(screen, 'intimate');
    expect(mockUpdate).toHaveBeenLastCalledWith(7, { classification: 'intimate' });
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(screen.queryByTestId('journal-save-retry')).not.toBeNull();

    await pickPrimaryAspect(screen, 5);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, { primary_aspect: 5, secondary_aspect: null });
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    const before = mockUpdate.mock.calls.length;
    await pressRetry(screen);

    expect(mockUpdate).toHaveBeenCalledTimes(before + 1);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, {
      message: 'A page about rivers, and the sea.',
      title: 'Rivers',
    });
    expect(hint(screen)).toBe('Saved');
    expect(screen.queryByTestId('journal-save-retry')).toBeNull();
  });

  it('keeps a tier failure owed through a successful body autosave until it is retried', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await pressTier(screen, 'intimate');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await typeBody(screen, 'A page about rivers, and the sea.');
    expect(mockUpdate).toHaveBeenLastCalledWith(7, {
      message: 'A page about rivers, and the sea.',
      title: 'Rivers',
    });
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await pressRetry(screen);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, { classification: 'intimate' });
    expect(hint(screen)).toBe('Saved');
    expect(tierSelected(screen, 'intimate')).toBe(true);
  });
});

describe('writing on settles a failed body save without a tap (#2930)', () => {
  it('clears the owed body once a later autosave lands', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A page about rivers, and the sea.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await typeBody(screen, 'A page about rivers, and the sea, and the rain.');

    expect(hint(screen)).toBe('Saved');
    expect(screen.queryByTestId('journal-save-retry')).toBeNull();
  });

  it('owes nothing for a body cleared to empty, which is never written', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A page about rivers, and the sea.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await typeBody(screen, '');
    // A later tier save publishes "Saved"; it shows only if the body lane cleared.
    await pressTier(screen, 'intimate');

    expect(hint(screen)).toBe('Saved');
    expect(updatesCarrying('message')).toHaveLength(1);
  });
});

describe('a retry runs its steps one at a time (#2930)', () => {
  /** Loaded Public; a body write and a move to Personal both fail. */
  async function bodyAndTierOwed() {
    const screen = await openLoaded({ classification: 'public' } as Partial<JournalMessage>);
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A page about rivers, and the sea.');
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await pressTier(screen, 'personal');
    expect(tierSelected(screen, 'public')).toBe(true);
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    return screen;
  }

  it('sends the tier only after the body retry has landed', async () => {
    const screen = await bodyAndTierOwed();
    const heldBody = deferred<JournalMessage>();
    mockUpdate.mockReturnValueOnce(heldBody.promise);
    await pressRetry(screen);
    expect(updatesCarrying('message')).toHaveLength(2);
    expect(updatesCarrying('classification')).toHaveLength(1);

    await act(async () => {
      heldBody.resolve(entry());
    });
    await settle();

    expect(updatesCarrying('classification')).toHaveLength(2);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, { classification: 'personal' });
    expect(hint(screen)).toBe('Saved');
  });
});

describe('Finish settles or keeps what it owes (#2930)', () => {
  it('keeps a Finish that failed after the writer typed on, and Retry finishes it', async () => {
    const screen = await openLoaded();
    const heldFinish = deferred<JournalMessage>();
    mockUpdate.mockReturnValueOnce(heldFinish.promise);
    fireEvent.press(screen.getByTestId('journal-finish-button'));
    await settle();
    // A keystroke during the Finish write makes its outcome stale.
    fireEvent.changeText(screen.getByTestId('journal-body-input'), 'One more line.');
    await act(async () => {
      heldFinish.reject(new Error('network'));
    });
    await settle();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(AUTOSAVE_MS);
    });
    await settle();

    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(screen.queryByTestId('journal-save-retry')).not.toBeNull();

    await pressRetry(screen);
    expect(mockUpdate).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ message: 'One more line.', status: 'finished' }),
    );
    expect(screen.getByTestId('journal-edit-button')).toBeTruthy();
  });

  it('a Finish that lands settles a body save that failed before it', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A page about rivers, and the sea.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    fireEvent.press(screen.getByTestId('journal-finish-button'));
    await settle();
    fireEvent.press(screen.getByTestId('journal-edit-button'));
    fireEvent.press(screen.getByTestId('edit-confirm-edit'));

    expect(hint(screen)).toBe('Saved');
    expect(screen.queryByTestId('journal-save-retry')).toBeNull();
  });
});

describe('Retry sends the writing on screen now (#2930)', () => {
  it('re-sends the latest body, not the text whose write first failed', async () => {
    const screen = await openLoaded();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'First try.');
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'First try, then a second thought.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await pressRetry(screen);

    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, {
      message: 'First try, then a second thought.',
      title: 'Rivers',
    });
    expect(hint(screen)).toBe('Saved');
  });

  it('keeps the single-flight create: a Retry and a keystroke on an id-less page create once (#1144)', async () => {
    const screen = renderScreen();
    mockCreate.mockRejectedValueOnce(new Error('network'));
    await typeBody(screen, 'A new page.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    const held = deferred<JournalMessage>();
    mockCreate.mockReturnValueOnce(held.promise);
    await pressRetry(screen);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // A keystroke's autosave fires while the retried create is still on the wire.
    await typeBody(screen, 'A new page, continued.');
    await act(async () => {
      held.resolve(entry({ id: 11 }));
    });
    await settle();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith(11, {
      message: 'A new page, continued.',
      title: null,
    });
    expect(hint(screen)).toBe('Saved');
  });
});

describe('coming back online retries once (#2930)', () => {
  it('re-sends a failed body once on reconnect with no tap, and not again', async () => {
    const screen = await openLoaded();
    await net.emit(false);
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    await typeBody(screen, 'Written on the train.');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    await net.emit(true);
    await settle();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, {
      message: 'Written on the train.',
      title: 'Rivers',
    });
    expect(hint(screen)).toBe('Saved');

    // A repeated online event, or a reconnect while nothing failed, sends nothing.
    await net.emit(true);
    await net.emit(false);
    await net.emit(true);
    await settle();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not retry on reconnect while a Finish write holds the writer', async () => {
    // A tier failure during an in-flight Finish leaves the hint on "Couldn't
    // save" while the Finish still holds the writer's slot: only the
    // write-in-flight gate keeps a reconnect from racing it.
    const screen = await openLoaded({ classification: 'personal' } as Partial<JournalMessage>);
    const heldFinish = deferred<JournalMessage>();
    mockUpdate.mockReturnValueOnce(heldFinish.promise);
    fireEvent.press(screen.getByTestId('journal-finish-button'));
    await settle();
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await pressTier(screen, 'intimate');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(updatesCarrying('classification')).toHaveLength(1);

    await net.emit(false);
    await net.emit(true);
    await settle();
    expect(updatesCarrying('classification')).toHaveLength(1);

    await act(async () => {
      heldFinish.resolve(entry({ status: 'finished' }));
    });
    await settle();
    expect(updatesCarrying('classification')).toHaveLength(1);
  });

  it('joins a tier Retry still on the wire rather than PATCHing it twice', async () => {
    // A tier PATCH does not hold the body writer's slot and the hint stays
    // "Couldn't save" while it runs, so only the retry's own single-flight
    // stands between it and a duplicate PATCH from a reconnect or a second tap.
    const screen = await openLoaded({ classification: 'personal' } as Partial<JournalMessage>);
    mockUpdate.mockRejectedValueOnce(new Error('network'));
    await pressTier(screen, 'intimate');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    const held = deferred<JournalMessage>();
    mockUpdate.mockReturnValueOnce(held.promise);
    await pressRetry(screen);
    expect(updatesCarrying('classification')).toHaveLength(2);
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await pressRetry(screen);
    await net.emit(false);
    await net.emit(true);
    await settle();
    expect(updatesCarrying('classification')).toHaveLength(2);

    await act(async () => {
      held.resolve(entry({ classification: 'intimate' } as Partial<JournalMessage>));
    });
    await settle();
    expect(hint(screen)).toBe('Saved');
    expect(updatesCarrying('classification')).toHaveLength(2);
  });

  it('re-sends a stricter tier on reconnect, keeping the choice the writer made', async () => {
    const screen = await openLoaded({ classification: 'personal' } as Partial<JournalMessage>);
    await net.emit(false);
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    await pressTier(screen, 'intimate');
    expect(tierSelected(screen, 'personal')).toBe(true);

    await net.emit(true);
    await settle();

    expect(mockUpdate).toHaveBeenLastCalledWith(7, { classification: 'intimate' });
    expect(tierSelected(screen, 'intimate')).toBe(true);
    expect(hint(screen)).toBe('Saved');
  });

  it('never moves an entry to a looser tier on reconnect', async () => {
    const screen = await openLoaded({ classification: 'personal' } as Partial<JournalMessage>);
    await net.emit(false);
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    await pressTier(screen, 'public');
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);

    await net.emit(true);
    await settle();

    expect(updatesCarrying('classification')).toEqual([[7, { classification: 'public' }]]);
    expect(tierSelected(screen, 'personal')).toBe(true);
    expect(hint(screen)).toBe('Saved');
  });

  it('never finishes an entry on reconnect; the Finish waits for a tap', async () => {
    const screen = await openLoaded();
    await net.emit(false);
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    fireEvent.press(screen.getByTestId('journal-finish-button'));
    await settle();
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(updatesCarrying('status')).toHaveLength(1);

    await net.emit(true);
    await settle();

    expect(updatesCarrying('status')).toHaveLength(1);
    expect(hint(screen)).toBe(SAVE_ERROR_HINT);
    expect(screen.getByTestId('journal-body-input')).toBeTruthy();
  });
});
