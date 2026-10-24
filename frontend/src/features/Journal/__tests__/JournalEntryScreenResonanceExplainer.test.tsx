/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * The spend disclosure in front of "Get Resonance".
 *
 * A resonance pass has one payer: the backend deducts one message from the
 * account's BotMason wallet (402 when it is empty), or bills the user's own API
 * key without touching that wallet. Before this gate the first anyone heard of
 * the BotMason price was the 402 — the cost was disclosed only after a pass.
 *
 * The load-bearing assertion in this file is the negative one: pressing the
 * button must not reach ``resonance.generate``. A spec that only checked the
 * modal was on screen would pass just as happily against a build that showed
 * the modal *and* charged behind it.
 */
import type { JournalMessage, ResonanceResponse } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<
  (_id: number, _token?: string, _apiKey?: string | null) => Promise<ResonanceResponse>
>;
const mockFreeExits = jest.fn() as jest.MockedFunction<
  (_id: number, _token?: string) => Promise<ResonanceResponse>
>;
const mockEssay = jest.fn() as jest.MockedFunction<
  (
    _id: number,
    _options?: { priceAcknowledged?: boolean; disclosedRoute?: string },
  ) => Promise<unknown>
>;
const mockDetect = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ checked: boolean; items: unknown[] }>
>;
const mockUsage = jest.fn() as jest.MockedFunction<
  () => Promise<{
    monthly_messages_used: number;
    monthly_messages_remaining: number;
    monthly_cap: number;
    monthly_reset_date: string;
    offering_balance: number;
    resonance_route?: 'vault_bound' | 'app_provider';
  }>
>;
const mockApiKeyState: { apiKey: string | null; isLoading: boolean } = {
  apiKey: null,
  isLoading: false,
};
const mockNavigate = jest.fn();
let mockBlurListener = (): void => undefined;
const mockAddListener = jest.fn((event: string, listener: () => void) => {
  if (event === 'blur') mockBlurListener = listener;
  return jest.fn();
});

interface UsageSnapshot {
  monthly_messages_used: number;
  monthly_messages_remaining: number;
  monthly_cap: number;
  monthly_reset_date: string;
  offering_balance: number;
  resonance_route?: 'vault_bound' | 'app_provider';
}

function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    monthly_messages_used: 0,
    monthly_messages_remaining: 7,
    monthly_cap: 7,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    offering_balance: 0,
    resonance_route: 'vault_bound',
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (_value: T) => void;
  reject: (_reason: unknown) => void;
} {
  let resolve: (_value: T) => void = () => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function apiError(status: number, detail: string): Error & { status: number; detail: string } {
  return Object.assign(new Error(detail), { status, detail });
}

// A development build's stub seam answers keyless requests, so it keeps the
// shipped price lines; the specs below run as one unless they say otherwise
// (#3262). A production build is switched on per spec.
let mockKeylessReachesServer = true;
jest.mock('@/config', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/config');
  // `defineProperty` so each access reads the current value, not the first.
  return Object.defineProperty({ ...actual }, 'KEYLESS_GENERATION_REACHES_SERVER', {
    enumerable: true,
    get: (): boolean => mockKeylessReachesServer,
  });
});
const mockVaultConnection = jest.fn() as jest.MockedFunction<
  () => Promise<{ connected: boolean; vault_url: string | null; mcp_address: string | null }>
>;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));
jest.mock('@/context/ApiKeyContext', () => ({
  useApiKey: () => mockApiKeyState,
}));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
    freeExits: (...a: unknown[]) =>
      (mockFreeExits as unknown as (...x: unknown[]) => unknown)(...a),
    essay: (...a: unknown[]) => (mockEssay as unknown as (...x: unknown[]) => unknown)(...a),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    detect: (...a: unknown[]) => (mockDetect as unknown as (...x: unknown[]) => unknown)(...a),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  botmasonUsage: {
    get: (...a: unknown[]) => (mockUsage as unknown as (...x: unknown[]) => unknown)(...a),
  },
  vault: {
    connection: () => mockVaultConnection(),
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

const mockLoadDismissed = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
const mockSaveDismissed = jest.fn() as jest.MockedFunction<(_v: boolean) => Promise<void>>;

jest.mock('@/storage/resonanceExplainerStorage', () => ({
  loadResonanceExplainerDismissed: (...a: unknown[]) =>
    (mockLoadDismissed as unknown as (...x: unknown[]) => unknown)(...a),
  saveResonanceExplainerDismissed: (...a: unknown[]) =>
    (mockSaveDismissed as unknown as (...x: unknown[]) => unknown)(...a),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
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

function screenElement(): React.JSX.Element {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = {
    navigate: mockNavigate,
    goBack: jest.fn(),
    push: jest.fn(),
    addListener: mockAddListener,
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return <Screen navigation={navigation} route={route} autosaveDelayMs={100} />;
}

function renderScreen() {
  return render(screenElement());
}

/** Render, wait for the saved entry to settle, and press "Get Resonance". */
async function openEntryAndAsk() {
  const view = renderScreen();
  await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
  await act(async () => {
    fireEvent.press(view.getByTestId('get-resonance-button'));
  });
  return view;
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockGenerate.mockReset();
  mockFreeExits.mockReset();
  // An exhausted wallet's free-exits request is refused like any empty wallet
  // unless a spec says the server found a free answer (#3389).
  mockFreeExits.mockRejectedValue(apiError(402, 'insufficient_offerings'));
  mockDetect.mockReset();
  mockEssay.mockReset();
  mockUsage.mockReset();
  mockLoadDismissed.mockReset();
  mockSaveDismissed.mockReset();
  mockNavigate.mockReset();
  mockAddListener.mockClear();
  mockBlurListener = (): void => undefined;
  mockGet.mockResolvedValue(entry());
  mockList.mockResolvedValue({ items: [] });
  mockGenerate.mockResolvedValue({
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
  } as ResonanceResponse);
  mockDetect.mockResolvedValue({ checked: true, items: [] });
  mockLoadDismissed.mockResolvedValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
  mockApiKeyState.apiKey = null;
  mockApiKeyState.isLoading = false;
  mockUsage.mockResolvedValue(usageSnapshot());
  mockKeylessReachesServer = true;
  mockVaultConnection.mockReset();
  mockVaultConnection.mockResolvedValue({ connected: false, vault_url: null, mcp_address: null });
});

describe('JournalEntryScreen — nothing is charged before the cost is disclosed', () => {
  it('answers the first press with the explainer and no generate call', async () => {
    const { findByTestId } = await openEntryAndAsk();

    expect(await findByTestId('resonance-explainer')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('answers the first press with the explainer under StrictMode', async () => {
    // StrictMode replays the mount effects; the cost read's mounted guard must
    // read true again afterwards or the explainer never opens.
    const view = render(<React.StrictMode>{screenElement()}</React.StrictMode>);
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
    await act(async () => {
      fireEvent.press(view.getByTestId('get-resonance-button'));
    });

    expect(await view.findByTestId('resonance-explainer')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
    // The settled preflight must release the button's busy state too.
    await waitFor(() =>
      expect(view.getByTestId('get-resonance-button').props.accessibilityState.busy).toBe(false),
    );
  });

  it('uses the deployment-served monthly cap without calling the allowance free', async () => {
    mockUsage.mockResolvedValueOnce({
      monthly_messages_used: 0,
      monthly_messages_remaining: 7,
      monthly_cap: 7,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      offering_balance: 0,
      resonance_route: 'vault_bound',
    });
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() =>
      expect(body).toHaveTextContent(/one of your 7 BotMason messages for the month/u),
    );
    expect(body).not.toHaveTextContent(/free/i);
  });

  it('names an offering when the deployment serves no monthly allowance', async () => {
    mockUsage.mockResolvedValueOnce({
      monthly_messages_used: 0,
      monthly_messages_remaining: 0,
      monthly_cap: 0,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      offering_balance: 3,
      resonance_route: 'vault_bound',
    });
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(body).toHaveTextContent(/one BotMason offering/u));
    expect(body).not.toHaveTextContent(/key.*pays instead/u);
  });

  it('names an offering after a nonzero monthly allowance is exhausted', async () => {
    mockUsage.mockResolvedValueOnce({
      monthly_messages_used: 7,
      monthly_messages_remaining: 0,
      monthly_cap: 7,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      offering_balance: 3,
      resonance_route: 'vault_bound',
    });
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(body).toHaveTextContent(/one BotMason offering/u));
  });

  it('says a stored API key pays and no BotMason message is drawn', async () => {
    mockApiKeyState.apiKey = 'sk-stored-caller-key'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    expect(body).toHaveTextContent(/Your own API key pays for this reading/u);
    expect(body).toHaveTextContent(/Nothing is drawn from your BotMason messages/u);
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });

  it('opens a refill invitation instead of the spend explainer for an exhausted wallet', async () => {
    mockUsage.mockResolvedValueOnce(
      usageSnapshot({
        monthly_messages_used: 7,
        monthly_messages_remaining: 0,
        monthly_reset_date: '2026-07-01T00:00:00Z',
      }),
    );
    const { findByTestId, queryByTestId } = await openEntryAndAsk();

    const refill = await findByTestId('journal-resonance-refill');
    expect(refill).toHaveTextContent(/July 1, 2026/u);
    expect(refill).toHaveTextContent(
      /vault answers use BotMason credits, even when an API key is saved/u,
    );
    expect(refill).not.toHaveTextContent(/Don.t show this again/u);
    expect(refill).not.toHaveTextContent(/Continue/u);
    expect(queryByTestId('resonance-explainer')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockFreeExits).toHaveBeenCalledTimes(1);
    expect(mockFreeExits).toHaveBeenCalledWith(7);
  });

  it('does not promise a zero-cap deployment that messages return at reset', async () => {
    // Persistent: the refill remedy rereads the wallet after the server's 402.
    mockUsage.mockResolvedValue(
      usageSnapshot({ monthly_cap: 0, monthly_messages_remaining: 0, offering_balance: 0 }),
    );
    const { findByTestId } = await openEntryAndAsk();

    const refill = await findByTestId('journal-resonance-refill');
    expect(refill).toHaveTextContent(/next monthly reset is July 1, 2026/u);
    expect(refill).not.toHaveTextContent(/messages come back/u);
  });

  it('takes the key-required invitation directly to API-key settings', async () => {
    mockUsage.mockResolvedValueOnce(
      usageSnapshot({
        resonance_route: 'app_provider',
        monthly_messages_used: 7,
        monthly_messages_remaining: 0,
      }),
    );
    const { findByTestId, queryByTestId } = await openEntryAndAsk();

    fireEvent.press(await findByTestId('resonance-explainer-open-settings'));

    expect(queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
  });

  it('waits for stored-key hydration before disclosing and pins that key to the pass', async () => {
    mockApiKeyState.isLoading = true;
    const view = renderScreen();
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());

    fireEvent.press(view.getByTestId('get-resonance-button'));
    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(mockUsage).not.toHaveBeenCalled();

    mockApiKeyState.apiKey = 'sk-key-loaded-from-device'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    mockApiKeyState.isLoading = false;
    await act(async () => view.rerender(screenElement()));

    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith(
        7,
        undefined,
        'sk-key-loaded-from-device',
        'app_provider',
      ),
    );
  });

  it('cancels a press queued during key hydration when API-key settings opens', async () => {
    mockApiKeyState.isLoading = true;
    const view = renderScreen();
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());

    fireEvent.press(view.getByTestId('get-resonance-button'));
    fireEvent.press(view.getByTestId('journal-api-key-settings'));
    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');

    mockApiKeyState.apiKey = 'sk-key-loaded-in-settings'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    mockApiKeyState.isLoading = false;
    await act(async () => view.rerender(screenElement()));

    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockUsage).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('re-discloses instead of charging when the payer changes while the dialog is open', async () => {
    const view = await openEntryAndAsk();
    await waitFor(() =>
      expect(
        view.getByTestId('resonance-explainer-continue').props.accessibilityState.disabled,
      ).toBe(false),
    );

    mockApiKeyState.apiKey = 'sk-key-added-after-open'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    await act(async () => view.rerender(screenElement()));
    await act(async () => {
      fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    });

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(view.getByTestId('resonance-explainer')).toBeTruthy();
    expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );

    fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith(
        7,
        undefined,
        'sk-key-added-after-open',
        'app_provider',
      ),
    );
  });

  it('asks only for free answers when a payer change on Continue finds the wallet empty', async () => {
    const view = await openEntryAndAsk();
    await waitFor(() =>
      expect(
        view.getByTestId('resonance-explainer-continue').props.accessibilityState.disabled,
      ).toBe(false),
    );

    mockApiKeyState.apiKey = 'sk-key-added-after-open'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ monthly_messages_remaining: 0 }));
    await act(async () => view.rerender(screenElement()));
    await act(async () => {
      fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    });

    expect(await view.findByTestId('journal-resonance-refill')).toBeTruthy();
    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(mockFreeExits).toHaveBeenCalledWith(7);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('coalesces a pending preflight and rechecks the payer before publishing it', async () => {
    const heldUsage = deferred<UsageSnapshot>();
    mockUsage.mockReturnValueOnce(heldUsage.promise);
    const view = renderScreen();
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());

    fireEvent.press(view.getByTestId('get-resonance-button'));
    await waitFor(() => {
      const button = view.getByTestId('get-resonance-button');
      expect(button.props.accessibilityState.busy).toBe(true);
      expect(button.props.accessibilityState.disabled).toBe(true);
      expect(button.props.accessibilityLabel).toBe('Checking resonance availability');
    });
    fireEvent.press(view.getByTestId('get-resonance-button'));
    expect(mockUsage).toHaveBeenCalledTimes(1);

    fireEvent.press(view.getByTestId('journal-api-key-settings'));
    mockApiKeyState.apiKey = 'sk-key-saved-during-preflight'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    await act(async () => view.rerender(screenElement()));
    await act(async () => heldUsage.resolve(usageSnapshot({ monthly_messages_remaining: 0 })));

    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    fireEvent.press(view.getByTestId('get-resonance-button'));
    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );
    expect(mockUsage).toHaveBeenCalledTimes(2);
  });

  it('ignores an older 402 refresh that resolves after a newer disclosure', async () => {
    const oldRead = deferred<UsageSnapshot>();
    const newRead = deferred<UsageSnapshot>();
    mockUsage.mockReset();
    mockUsage
      .mockResolvedValueOnce(usageSnapshot({ monthly_messages_remaining: 4 }))
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    fireEvent.press(await view.findByTestId('journal-resonance-refill-cancel'));
    fireEvent.press(view.getByTestId('get-resonance-button'));

    await act(async () =>
      newRead.resolve(usageSnapshot({ monthly_cap: 11, monthly_messages_remaining: 11 })),
    );
    await waitFor(() =>
      expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/your 11 BotMason/u),
    );

    await act(async () =>
      oldRead.resolve(usageSnapshot({ monthly_cap: 0, monthly_messages_remaining: 0 })),
    );
    expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/your 11 BotMason/u);
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
  });

  it('says the entry leaves the device for a model', async () => {
    const { findByTestId } = await openEntryAndAsk();

    expect(await findByTestId('resonance-explainer-what')).toHaveTextContent(/AI model/i);
  });

  it('runs the pass exactly once when Continue is pressed', async () => {
    const { findByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
  });

  it('closes the explainer once Continue has been taken', async () => {
    const { findByTestId, queryByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    await waitFor(() => expect(queryByTestId('resonance-explainer')).toBeNull());
  });

  it('runs nothing at all when the reader backs out', async () => {
    const { findByTestId, queryByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-cancel'));

    await waitFor(() => expect(queryByTestId('resonance-explainer')).toBeNull());
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('shows it again on the next press when the box was left unticked', async () => {
    const { findByTestId, getByTestId, queryByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(queryByTestId('resonance-explainer')).toBeNull());

    fireEvent.press(getByTestId('get-resonance-button'));

    expect(await findByTestId('resonance-explainer')).toBeTruthy();
    expect(mockSaveDismissed).not.toHaveBeenCalled();
  });
});

describe('JournalEntryScreen — "don’t show this again" is honoured', () => {
  it('persists the dismissal when the box is ticked and Continue pressed', async () => {
    const { findByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-dont-show'));
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledWith(true));
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('persists it on the back-out arm too, and still charges nothing', async () => {
    const { findByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-dont-show'));
    fireEvent.press(await findByTestId('resonance-explainer-cancel'));

    await waitFor(() => expect(mockSaveDismissed).toHaveBeenCalledWith(true));
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('reports the tick to assistive tech as a checked checkbox', async () => {
    const { findByTestId } = await openEntryAndAsk();
    const box = await findByTestId('resonance-explainer-dont-show');
    expect(box.props.accessibilityState.checked).toBe(false);

    fireEvent.press(box);

    expect(box.props.accessibilityState.checked).toBe(true);
  });

  it('skips straight to the pass on the next press in the same session', async () => {
    const { findByTestId, getByTestId, queryByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-dont-show'));
    fireEvent.press(await findByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));

    fireEvent.press(getByTestId('get-resonance-button'));

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2));
    expect(queryByTestId('resonance-explainer')).toBeNull();
  });
});

describe('JournalEntryScreen — a reader who already dismissed it', () => {
  beforeEach(() => {
    mockLoadDismissed.mockResolvedValue(true);
  });

  it('goes straight to the pass with no explainer', async () => {
    const { queryByTestId } = await openEntryAndAsk();

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(queryByTestId('resonance-explainer')).toBeNull();
  });

  it('still shows the refill invitation when the wallet is exhausted', async () => {
    mockUsage.mockResolvedValueOnce(
      usageSnapshot({ monthly_messages_used: 7, monthly_messages_remaining: 0 }),
    );
    const { findByTestId } = await openEntryAndAsk();

    expect(await findByTestId('journal-resonance-refill')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockFreeExits).toHaveBeenCalledWith(7);
  });
});

describe('JournalEntryScreen — an exhausted wallet still reaches the free answers (#3389)', () => {
  const PRIVATE_MESSAGE =
    "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection.";
  const exhausted = (): UsageSnapshot =>
    usageSnapshot({ monthly_messages_used: 7, monthly_messages_remaining: 0 });

  function freeAnswer(overrides: Partial<ResonanceResponse>): ResonanceResponse {
    return {
      marginalia: [],
      suggestions: [],
      remaining_messages: 0,
      remaining_balance: 0,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      care: null,
      private: false,
      private_message: null,
      ...overrides,
    } as ResonanceResponse;
  }

  beforeEach(() => {
    mockUsage.mockResolvedValueOnce(exhausted());
  });

  it('shows the privacy message for an entry the server holds as intimate', async () => {
    mockFreeExits.mockResolvedValueOnce(
      freeAnswer({ private: true, private_message: PRIVATE_MESSAGE }),
    );
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('privacy-resonance-reason')).toHaveTextContent(PRIVATE_MESSAGE);
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('shows the reviewed care surface for a locally flagged entry', async () => {
    mockFreeExits.mockResolvedValueOnce(
      freeAnswer({
        care: {
          title: "You're not alone in this",
          message: 'What you shared sounds heavy. Here are some people who can help right now.',
          resources: [
            {
              kind: 'hotline',
              name: '988 Suicide & Crisis Lifeline',
              contact: '988',
              what_it_is: 'Free, confidential crisis support — call or text anytime.',
            },
          ],
        },
      }),
    );
    const view = await openEntryAndAsk();

    const card = await view.findByTestId('care-support-card');
    expect(card).toHaveTextContent(/988 Suicide & Crisis Lifeline/u);
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('opens the refill remedy for an ordinary entry without asking for completion detection', async () => {
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('journal-resonance-refill')).toBeTruthy();
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('never sends a saved key with the free-exits request', async () => {
    mockApiKeyState.apiKey = 'sk-saved-key-the-vault-never-uses'; // pragma: allowlist secret
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('journal-resonance-refill')).toBeTruthy();
    expect(mockFreeExits).toHaveBeenCalledWith(7);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('discloses the price instead of charging when the wallet was refilled meanwhile', async () => {
    mockFreeExits.mockRejectedValueOnce(apiError(409, 'resonance_payment_unconfirmed'));
    mockUsage.mockResolvedValueOnce(usageSnapshot({ monthly_messages_remaining: 4 }));
    const view = await openEntryAndAsk();

    const cost = await view.findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(cost).toHaveTextContent(/BotMason/u));
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockFreeExits).toHaveBeenCalledTimes(1);
  });

  it('falls back to the refill remedy, without asking again, when the reread is still empty', async () => {
    mockFreeExits.mockRejectedValueOnce(apiError(409, 'resonance_payment_unconfirmed'));
    mockUsage.mockResolvedValueOnce(exhausted());
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('journal-resonance-refill')).toBeTruthy();
    expect(mockFreeExits).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe('JournalEntryScreen — Continue is bound to the route it disclosed (#3385)', () => {
  it('sends the disclosed route with the pass it confirms', async () => {
    const view = await openEntryAndAsk();
    await waitFor(() =>
      expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/BotMason/u),
    );

    fireEvent.press(view.getByTestId('resonance-explainer-continue'));

    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith(7, undefined, null, 'vault_bound'),
    );
    expect(view.queryByTestId('resonance-explainer-payer-changed')).toBeNull();
  });

  it('discloses a route that changed after Continue again instead of charging it', async () => {
    mockApiKeyState.apiKey = 'sk-key-the-vault-never-uses'; // pragma: allowlist secret
    mockUsage.mockResolvedValueOnce(usageSnapshot({ resonance_route: 'app_provider' }));
    mockGenerate.mockRejectedValueOnce(apiError(409, 'resonance_payment_unconfirmed'));
    const view = await openEntryAndAsk();
    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );

    await act(async () => {
      fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    });

    // Another device connected a vault: the refreshed disclosure names its price.
    const cost = await view.findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(cost).toHaveTextContent(/BotMason/u));
    expect(view.getByTestId('resonance-explainer-payer-changed')).toBeTruthy();
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenLastCalledWith(
      7,
      undefined,
      'sk-key-the-vault-never-uses',
      'app_provider',
    );

    fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2));
    expect(mockGenerate).toHaveBeenLastCalledWith(
      7,
      undefined,
      'sk-key-the-vault-never-uses',
      'vault_bound',
    );
  });

  it('shows a reader who dismissed the note the changed route before anything is charged', async () => {
    mockLoadDismissed.mockResolvedValue(true);
    mockGenerate.mockRejectedValueOnce(apiError(409, 'resonance_payment_unconfirmed'));
    mockUsage
      .mockResolvedValueOnce(usageSnapshot())
      .mockResolvedValueOnce(usageSnapshot({ resonance_route: 'app_provider' }));
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('resonance-explainer-payer-changed')).toBeTruthy();
    expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/own API key/u);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(7, undefined, null, 'vault_bound');
  });
});

describe('JournalEntryScreen — a stale wallet read is corrected by the pass', () => {
  const fundingFailures: Array<[string, RegExp, RegExp | null]> = [
    ['insufficient_offerings', /BotMason balance has run out/u, null],
    ['llm_key_required', /needs an API key of your own/u, /balance has run out|monthly reset/u],
  ];

  it.each(fundingFailures)(
    'opens a truthful refill invitation when the server returns 402 %s',
    async (detail, expectedCopy, excludedCopy) => {
      mockGenerate.mockRejectedValueOnce(apiError(402, detail));
      const { findByTestId, queryByTestId } = await openEntryAndAsk();
      fireEvent.press(await findByTestId('resonance-explainer-continue'));

      const refill = await findByTestId('journal-resonance-refill');
      expect(refill).toHaveTextContent(expectedCopy);
      if (excludedCopy !== null) expect(refill).not.toHaveTextContent(excludedCopy);
      expect(queryByTestId('resonance-explainer')).toBeNull();
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    },
  );

  it('does not make the 402 recovery wait for a second usage read', async () => {
    const heldRefresh = deferred<UsageSnapshot>();
    mockUsage.mockReset();
    mockUsage
      .mockResolvedValueOnce(usageSnapshot({ monthly_messages_remaining: 4 }))
      .mockReturnValueOnce(heldRefresh.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const { findByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    expect(await findByTestId('journal-resonance-refill')).toBeTruthy();
  });

  it('uses coherent fallback copy when the reset date cannot be read', async () => {
    mockUsage
      .mockResolvedValueOnce(usageSnapshot())
      .mockRejectedValue(new Error('usage unavailable'));
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const { findByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    const refill = await findByTestId('journal-resonance-refill');
    expect(refill).toHaveTextContent(/check your BotMason balance again later/iu);
    expect(refill).not.toHaveTextContent(/reset is your next monthly reset/u);
  });

  it('does not make the 402 recovery wait for completion detection', async () => {
    const heldDetection = deferred<{ checked: boolean; items: unknown[] }>();
    mockDetect.mockReturnValueOnce(heldDetection.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const { findByTestId, queryByTestId } = await openEntryAndAsk();
    fireEvent.press(await findByTestId('resonance-explainer-continue'));

    expect(await findByTestId('journal-resonance-refill')).toBeTruthy();
    await act(async () => heldDetection.resolve({ checked: true, items: [] }));
    expect(queryByTestId('journal-resonance-error')).toBeNull();
  });

  it('keeps Not now final when the post-402 usage refresh resolves later', async () => {
    const heldRefresh = deferred<UsageSnapshot>();
    mockUsage.mockReset();
    mockUsage
      .mockResolvedValueOnce(usageSnapshot({ monthly_messages_remaining: 4 }))
      .mockReturnValueOnce(heldRefresh.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    fireEvent.press(await view.findByTestId('journal-resonance-refill-cancel'));

    await act(async () => heldRefresh.resolve(usageSnapshot({ monthly_messages_remaining: 0 })));
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
  });

  it('does not reopen stale no-key refill after Add key and a payer change', async () => {
    const heldRefresh = deferred<UsageSnapshot>();
    mockUsage.mockReset();
    mockUsage
      .mockResolvedValueOnce(usageSnapshot({ monthly_messages_remaining: 4 }))
      .mockReturnValueOnce(heldRefresh.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    fireEvent.press(await view.findByTestId('journal-api-key-settings'));
    mockApiKeyState.apiKey = 'sk-key-added-after-402'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    await act(async () => view.rerender(screenElement()));

    await act(async () => heldRefresh.resolve(usageSnapshot({ monthly_messages_remaining: 0 })));
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
  });

  it('does not let a held resonance 402 portal refill over API-key settings', async () => {
    const heldPass = deferred<ResonanceResponse>();
    mockGenerate.mockReturnValueOnce(heldPass.promise);
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));

    fireEvent.press(view.getByTestId('journal-api-key-settings'));
    mockApiKeyState.apiKey = 'sk-key-added-during-pass'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    await act(async () => view.rerender(screenElement()));
    await act(async () => heldPass.reject(apiError(402, 'insufficient_offerings')));

    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
  });

  it('cancels a held pass on blur before another journal route takes the foreground', async () => {
    const heldPass = deferred<ResonanceResponse>();
    mockGenerate.mockReturnValueOnce(heldPass.promise);
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));

    fireEvent.press(view.getByTestId('journal-edit-button'));
    fireEvent.press(view.getByTestId('edit-confirm-edit'));
    fireEvent.press(await view.findByTestId('journal-photograph-page'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalPhotograph', {
      appendTo: expect.any(String),
      appendTier: expect.any(String),
    });
    act(() => mockBlurListener());
    await act(async () => heldPass.reject(apiError(402, 'insufficient_offerings')));

    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
  });

  it('does not let old completion detection overwrite a newer successful BYOK pass', async () => {
    const heldDetection = deferred<{ checked: boolean; items: unknown[] }>();
    mockDetect.mockReturnValueOnce(heldDetection.promise);
    mockGenerate.mockRejectedValueOnce(apiError(402, 'insufficient_offerings'));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    fireEvent.press(await view.findByTestId('journal-api-key-settings'));
    mockApiKeyState.apiKey = 'sk-retry-key'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    await act(async () => view.rerender(screenElement()));

    fireEvent.press(view.getByTestId('get-resonance-button'));
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2));
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();

    await act(async () => heldDetection.resolve({ checked: true, items: [] }));
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();
  });
});

describe('JournalEntryScreen — a press that lands before the flag is read', () => {
  /** A stored-flag read that settles only when the test says so. */
  function pendingRead(): (_answer: boolean) => void {
    let settle: (_v: boolean) => void = () => undefined;
    mockLoadDismissed.mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    return (answer: boolean) => settle(answer);
  }

  it('waits for a stored "dismissed" rather than guessing at it', async () => {
    const settle = pendingRead();

    const { queryByTestId } = await openEntryAndAsk();
    expect(queryByTestId('resonance-explainer')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();

    settle(true);

    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(queryByTestId('resonance-explainer')).toBeNull();
  });

  it('discloses once the read comes back "not dismissed", still without charging', async () => {
    const settle = pendingRead();

    const { findByTestId } = await openEntryAndAsk();

    settle(false);

    // The press is honoured against the answer it waited for -- it neither
    // fell through to the charge nor was dropped on the floor.
    expect(await findByTestId('resonance-explainer')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

/** One essay-less margin note on the open entry, for the letter offer's specs. */
const ESSAY_NOTE = {
  id: 31,
  journal_entry_id: 7,
  kind: 'theme',
  anchor_start: 2,
  anchor_end: 6,
  anchor_text: 'page',
  note: 'A page, again.',
  essay: null,
  essay_generated_at: null,
  status: 'active',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

/**
 * A note's first letter spends from the same wallet as the pass (#623), so an
 * empty wallet on the letter must reach the same refill remedy — not a generic
 * error inside the essay card.
 */
// A non-secret fixture: this test needs only opaque key presence.
const TEST_OWN_CREDENTIAL = 'synthetic-test-only';

describe('JournalEntryScreen — an essay 402 opens the same refill remedy', () => {
  it.each([
    ['insufficient_offerings', /BotMason balance has run out/u],
    ['llm_key_required', /needs an API key of your own/u],
  ])('closes the note and opens the refill dialog on a 402 %s', async (detail, copy) => {
    mockApiKeyState.apiKey = TEST_OWN_CREDENTIAL;
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    mockList.mockResolvedValue({ items: [ESSAY_NOTE] });
    mockEssay.mockRejectedValueOnce(apiError(402, detail));
    const view = renderScreen();
    fireEvent.press(await view.findByTestId(`margin-note-${ESSAY_NOTE.id}`));
    expect(await view.findByTestId('essay-offer')).toBeTruthy();
    expect(mockEssay).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(view.getByTestId('essay-ask'));
    });

    expect(mockEssay).toHaveBeenCalledWith(ESSAY_NOTE.id, {
      priceAcknowledged: true,
      disclosedRoute: 'app_provider',
    });
    expect(await view.findByTestId('journal-resonance-refill')).toHaveTextContent(copy);
    await waitFor(() => expect(view.queryByTestId('essay-offer')).toBeNull());
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

/**
 * The letter's offer names its payer (#623). A writer whose own key pays is
 * told so, and the BotMason wallet is never consulted for them; a server-paid
 * writer is shown the wallet unit the letter will spend.
 */
describe('JournalEntryScreen — the letter offer names who pays', () => {
  it('tells a writer with their own key that the key pays, without reading the wallet', async () => {
    mockApiKeyState.apiKey = 'sk-letter-own-key'; // pragma: allowlist secret
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
    mockList.mockResolvedValue({ items: [ESSAY_NOTE] });
    const view = renderScreen();
    fireEvent.press(await view.findByTestId(`margin-note-${ESSAY_NOTE.id}`));

    const cost = await view.findByTestId('essay-ask-cost');
    await waitFor(() =>
      expect(cost).toHaveTextContent(
        'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
      ),
    );
    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(mockEssay).not.toHaveBeenCalled();
  });

  it('offers a vault-bound letter at one wallet unit without asking automatically', async () => {
    mockUsage.mockResolvedValueOnce(
      usageSnapshot({ monthly_messages_remaining: 0, offering_balance: 3 }),
    );
    mockList.mockResolvedValue({ items: [ESSAY_NOTE] });
    const view = renderScreen();
    fireEvent.press(await view.findByTestId(`margin-note-${ESSAY_NOTE.id}`));

    const cost = await view.findByTestId('essay-ask-cost');
    await waitFor(() =>
      expect(cost).toHaveTextContent('This letter spends one BotMason offering.'),
    );
    expect(mockUsage).toHaveBeenCalled();
    expect(view.getByTestId('essay-ask')).toBeTruthy();
    expect(mockEssay).not.toHaveBeenCalled();
  });
});

/**
 * A revoked entitlement (#1938, B21 E1) refuses a keyless pass with a 403. The
 * margin carries the plain copy, and never invites the writer to try resonance
 * again: asking again cannot succeed, and no refill would help.
 */
describe('JournalEntryScreen — a revoked entitlement is not a retry', () => {
  it('renders 403 ai_access_revoked without the retry invitation or the refill', async () => {
    mockGenerate.mockRejectedValueOnce(apiError(403, 'ai_access_revoked'));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));

    const line = await view.findByTestId('journal-resonance-error');
    expect(line).toHaveTextContent(/APTITUDE membership is no longer active/u);
    expect(line).toHaveTextContent(/We still checked it for completed habits\.$/u);
    expect(line).not.toHaveTextContent(/try resonance again/u);
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

/**
 * The generation guardrails (#623) refuse a pass with a 429 before anything is
 * charged. The margin says why, in the line a screen reader already announces,
 * and never opens the 402 refill invitation: no refill would help. Copy is
 * hand-written so a renamed constant cannot make the test agree with itself.
 */
describe('JournalEntryScreen — a guardrail refusal is honest and costs nothing', () => {
  it.each([
    [
      'generation_in_progress',
      'BotMason is already writing for you, and nothing was charged for this request. Ask again once that finishes.',
    ],
    [
      'daily_generation_limit_reached',
      "You've hit today's limit for new readings and letters, and nothing was charged. A fresh day's worth opens at midnight UTC — that's evening in the Americas.",
    ],
  ])('renders a 429 %s in the announced margin line, not the refill', async (detail, copy) => {
    mockGenerate.mockRejectedValueOnce(apiError(429, detail));
    const view = await openEntryAndAsk();
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));

    const line = await view.findByTestId('journal-resonance-error');
    // The refusal's own copy says when asking again can work, so the margin
    // does not also invite another pass "whenever you like".
    expect(line).toHaveTextContent(
      `We couldn't create a reflection for this entry. ${copy} We still checked it for completed habits.`,
    );
    expect(line).not.toHaveTextContent(/whenever you like/u);
    expect(line.props.accessibilityLiveRegion).toBe('polite');
    expect(view.queryByTestId('journal-resonance-refill')).toBeNull();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

/**
 * With no key, a production build prices only what credits can pay for
 * (#3262): a reading the writer's own vault answers. A letter, and a reading
 * with no vault, lead with "This needs your own API key" and send the writer to
 * Settings instead of to a request the server can only refuse.
 */
describe('JournalEntryScreen — with no key, only a vault-answered reading has a price', () => {
  const KEY_NEEDED_READING =
    'This needs your own API key. Add one in Settings to ask for this reading.';

  beforeEach(() => {
    mockKeylessReachesServer = false;
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'app_provider' }));
  });

  it('leads a vaultless reading with the key, names no price, and sends nothing', async () => {
    const view = await openEntryAndAsk();

    const cost = await view.findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(cost).toHaveTextContent(KEY_NEEDED_READING));
    expect(cost).not.toHaveTextContent(/BotMason/u);
    expect(view.queryByTestId('resonance-explainer-continue')).toBeNull();
    expect(view.queryByTestId('resonance-explainer-dont-show')).toBeNull();
    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('takes the writer to API-key settings from the reading', async () => {
    const view = await openEntryAndAsk();

    fireEvent.press(await view.findByTestId('resonance-explainer-open-settings'));

    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('still says so to a writer who dismissed the cost note, rather than sending', async () => {
    mockLoadDismissed.mockResolvedValue(true);
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      KEY_NEEDED_READING,
    );
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('keeps the shipped price for a reading a connected vault answers', async () => {
    mockVaultConnection.mockResolvedValue({
      connected: true,
      vault_url: 'https://vault.example',
      mcp_address: null,
    });
    mockUsage.mockResolvedValue(usageSnapshot({ resonance_route: 'vault_bound' }));
    const view = await openEntryAndAsk();

    const cost = await view.findByTestId('resonance-explainer-cost');
    await waitFor(() =>
      expect(cost).toHaveTextContent(
        'This reading spends one of your 7 BotMason messages for the month.',
      ),
    );
    expect(view.getByTestId('resonance-explainer-continue')).toBeTruthy();
  });

  it('keeps the key-pays line unchanged once a key is saved', async () => {
    mockApiKeyState.apiKey = 'sk-saved-own-key'; // pragma: allowlist secret
    const view = await openEntryAndAsk();

    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    );
    expect(mockVaultConnection).not.toHaveBeenCalled();
  });

  it('leads a letter with the key, even with a vault, and sends the writer to Settings', async () => {
    mockVaultConnection.mockResolvedValue({
      connected: true,
      vault_url: 'https://vault.example',
      mcp_address: null,
    });
    mockList.mockResolvedValue({ items: [ESSAY_NOTE] });
    const view = renderScreen();
    fireEvent.press(await view.findByTestId(`margin-note-${ESSAY_NOTE.id}`));

    const cost = await view.findByTestId('essay-ask-cost');
    await waitFor(() =>
      expect(cost).toHaveTextContent(
        'This needs your own API key. Add one in Settings to ask for this letter.',
      ),
    );
    expect(cost).not.toHaveTextContent(/BotMason/u);
    expect(view.queryByTestId('essay-ask')).toBeNull();

    fireEvent.press(view.getByTestId('essay-open-settings'));

    expect(mockNavigate).toHaveBeenCalledWith('ApiKeySettings');
    await waitFor(() => expect(view.queryByTestId('essay-offer')).toBeNull());
    expect(mockEssay).not.toHaveBeenCalled();
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });
});
