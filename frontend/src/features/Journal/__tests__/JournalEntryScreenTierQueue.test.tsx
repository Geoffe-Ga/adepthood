// #2935 round 9: a tier tap waiting in the serialized tier-write queue is the
// writer's latest choice. The #2930 retry and the carried-words escalation must
// never replace it with anything looser (from the round-8 review's repro).
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

function renderScreen(params?: { entryId?: number; weekNumber?: number }) {
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

function updatesCarrying(key: string): unknown[][] {
  return mockUpdate.mock.calls.filter(([, payload]) => key in (payload as object));
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

/** The tiers PATCHed, in send order. */
function tiersSent(): unknown[] {
  return updatesCarrying('classification').map(
    ([, p]) => (p as { classification: string }).classification,
  );
}

/**
 * Stored Intimate. A Personal tap fails (pending, reverted); a Public tap goes
 * on the wire and is held there; an Intimate tap queues behind it.
 */
async function queuedIntimateBehindPublic(options: { offline?: boolean } = {}) {
  const screen = await openLoaded({ classification: 'intimate' } as Partial<JournalMessage>);
  if (options.offline) await net.emit(false);
  mockUpdate.mockRejectedValueOnce(new Error('offline'));
  await pressTier(screen, 'personal');
  expect(tierSelected(screen, 'intimate')).toBe(true);
  expect(hint(screen)).toBe(SAVE_ERROR_HINT);
  const pub = deferred<JournalMessage>();
  mockUpdate.mockImplementationOnce(() => pub.promise);
  await pressTier(screen, 'public');
  await pressTier(screen, 'intimate');
  expect(tierSelected(screen, 'intimate')).toBe(true);
  return { screen, pub };
}

async function resolvePublic(pub: ReturnType<typeof deferred<JournalMessage>>) {
  await act(async () => {
    pub.resolve(entry({ classification: 'public' } as Partial<JournalMessage>));
  });
  await settle();
  await settle();
}

describe('the #2930 retry never replaces a queued writer tap (#2935 round 9)', () => {
  it('a Retry while a tap is queued never loosens the queued stricter choice', async () => {
    const { screen, pub } = await queuedIntimateBehindPublic();

    await pressRetry(screen);
    await resolvePublic(pub);

    expect(tiersSent()).toEqual(['personal', 'public', 'intimate']);
    expect(tierSelected(screen, 'intimate')).toBe(true);
    expect(mockUpdate).toHaveBeenLastCalledWith(7, { classification: 'intimate' });
  });

  it('a reconnect retry while a tap is queued never loosens the queued stricter choice', async () => {
    const { screen, pub } = await queuedIntimateBehindPublic({ offline: true });

    await net.emit(true);
    await settle();
    await resolvePublic(pub);

    expect(tiersSent()).toEqual(['personal', 'public', 'intimate']);
    expect(tierSelected(screen, 'intimate')).toBe(true);
  });

  it('drops a pending retry tier looser than the queued writer tap', async () => {
    const { screen, pub } = await queuedIntimateBehindPublic();

    await pressRetry(screen);
    // The retry itself drops the pending Personal (it reads the writer's latest
    // request, Intimate, as its floor), so the failure is settled at once.
    expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
    await resolvePublic(pub);

    // The failed Personal is never re-sent: the writer has since asked for Intimate.
    expect(tiersSent().slice(1)).toEqual(['public', 'intimate']);
    expect(screen.queryByRole('button', { name: RETRY_NAME })).toBeNull();
  });

  it('never sends a tier looser than the writer asked for when the queued tap is looser than pending', async () => {
    const screen = await openLoaded({ classification: 'public' } as Partial<JournalMessage>);
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    await pressTier(screen, 'intimate');
    expect(tierSelected(screen, 'public')).toBe(true);
    const held = deferred<JournalMessage>();
    mockUpdate.mockImplementationOnce(() => held.promise);
    await pressTier(screen, 'personal');
    await pressTier(screen, 'public');

    await pressRetry(screen);
    await act(async () => {
      held.resolve(entry({ classification: 'personal' } as Partial<JournalMessage>));
    });
    await settle();
    await settle();

    // Pending Intimate is stricter than the writer's latest (Public), so the
    // retry waits behind the tap and is then sent: the entry only ever gets
    // stricter than what the writer asked for, never looser.
    expect(tiersSent()).toEqual(['intimate', 'personal', 'public', 'intimate']);
    expect(tierSelected(screen, 'intimate')).toBe(true);
  });
});
