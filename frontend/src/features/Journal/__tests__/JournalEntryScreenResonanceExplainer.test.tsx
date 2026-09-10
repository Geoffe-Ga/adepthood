/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, configure, fireEvent, render, waitFor } from '@testing-library/react-native';
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
const mockUsage = jest.fn() as jest.MockedFunction<
  () => Promise<{
    monthly_messages_used: number;
    monthly_messages_remaining: number;
    monthly_cap: number;
    monthly_reset_date: string;
    offering_balance: number;
  }>
>;
const mockApiKeyState: { apiKey: string | null; isLoading: boolean } = {
  apiKey: null,
  isLoading: false,
};

interface UsageSnapshot {
  monthly_messages_used: number;
  monthly_messages_remaining: number;
  monthly_cap: number;
  monthly_reset_date: string;
  offering_balance: number;
}

function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    monthly_messages_used: 0,
    monthly_messages_remaining: 7,
    monthly_cap: 7,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    offering_balance: 0,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (_value: T) => void } {
  let resolve: (_value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  botmasonUsage: {
    get: (...a: unknown[]) => (mockUsage as unknown as (...x: unknown[]) => unknown)(...a),
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

/**
 * A wider find budget than the one-second default.
 *
 * The disclosure renders inside a Modal on top of the whole entry screen, and
 * under `--coverage` every module in that tree is instrumented; the default
 * budget is thin enough there to time out on a card that does arrive. This
 * weakens no assertion — each `findBy` below still fails if the card never
 * comes — it only stops a slow machine from reading as a missing gate.
 */
configure({ asyncUtilTimeout: 5_000 });

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
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
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
  mockUsage.mockReset();
  mockLoadDismissed.mockReset();
  mockSaveDismissed.mockReset();
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
  mockLoadDismissed.mockResolvedValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
  mockApiKeyState.apiKey = null;
  mockApiKeyState.isLoading = false;
  mockUsage.mockResolvedValue(usageSnapshot());
});

describe('JournalEntryScreen — nothing is charged before the cost is disclosed', () => {
  it('answers the first press with the explainer and no generate call', async () => {
    const { findByTestId } = await openEntryAndAsk();

    expect(await findByTestId('resonance-explainer')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('uses the deployment-served monthly cap without calling the allowance free', async () => {
    mockUsage.mockResolvedValueOnce({
      monthly_messages_used: 0,
      monthly_messages_remaining: 7,
      monthly_cap: 7,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      offering_balance: 0,
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
    });
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(body).toHaveTextContent(/one BotMason offering/u));
    expect(body).toHaveTextContent(/Add your own API key in Settings/u);
  });

  it('names an offering after a nonzero monthly allowance is exhausted', async () => {
    mockUsage.mockResolvedValueOnce({
      monthly_messages_used: 7,
      monthly_messages_remaining: 0,
      monthly_cap: 7,
      monthly_reset_date: '2026-07-01T00:00:00Z',
      offering_balance: 3,
    });
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() => expect(body).toHaveTextContent(/one BotMason offering/u));
  });

  it('says a stored API key pays and no BotMason message is drawn', async () => {
    mockApiKeyState.apiKey = 'sk-stored-caller-key'; // pragma: allowlist secret
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    expect(body).toHaveTextContent(/Your own API key pays for this reading/u);
    expect(body).toHaveTextContent(/Nothing is drawn from your BotMason messages/u);
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it('names an exhausted wallet and disables an impossible pass', async () => {
    mockUsage.mockResolvedValueOnce(
      usageSnapshot({ monthly_messages_used: 7, monthly_messages_remaining: 0 }),
    );
    const { findByTestId } = await openEntryAndAsk();

    const body = await findByTestId('resonance-explainer-cost');
    await waitFor(() =>
      expect(body).toHaveTextContent(/no BotMason monthly messages or offerings/u),
    );
    const continueButton = await findByTestId('resonance-explainer-continue');
    expect(continueButton.props.accessibilityState.disabled).toBe(true);

    fireEvent.press(continueButton);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('waits for stored-key hydration before disclosing and pins that key to the pass', async () => {
    mockApiKeyState.isLoading = true;
    const view = renderScreen();
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());

    fireEvent.press(view.getByTestId('get-resonance-button'));
    expect(view.queryByTestId('resonance-explainer')).toBeNull();
    expect(mockUsage).not.toHaveBeenCalled();

    mockApiKeyState.apiKey = 'sk-key-loaded-from-device'; // pragma: allowlist secret
    mockApiKeyState.isLoading = false;
    await act(async () => view.rerender(screenElement()));

    expect(await view.findByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );
    fireEvent.press(await view.findByTestId('resonance-explainer-continue'));
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith(7, undefined, 'sk-key-loaded-from-device'),
    );
  });

  it('re-discloses instead of charging when the payer changes while the dialog is open', async () => {
    const view = await openEntryAndAsk();
    await waitFor(() =>
      expect(
        view.getByTestId('resonance-explainer-continue').props.accessibilityState.disabled,
      ).toBe(false),
    );

    mockApiKeyState.apiKey = 'sk-key-added-after-open'; // pragma: allowlist secret
    await act(async () => view.rerender(screenElement()));
    fireEvent.press(view.getByTestId('resonance-explainer-continue'));

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(view.getByTestId('resonance-explainer')).toBeTruthy();
    expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(
      /Your own API key pays/u,
    );

    fireEvent.press(view.getByTestId('resonance-explainer-continue'));
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith(7, undefined, 'sk-key-added-after-open'),
    );
  });

  it('ignores an older wallet read that resolves after a newer disclosure', async () => {
    const oldRead = deferred<UsageSnapshot>();
    const newRead = deferred<UsageSnapshot>();
    mockUsage.mockReset();
    mockUsage.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const view = await openEntryAndAsk();
    fireEvent.press(view.getByTestId('resonance-explainer-cancel'));
    await act(async () => {
      fireEvent.press(view.getByTestId('get-resonance-button'));
    });

    await act(async () =>
      newRead.resolve(usageSnapshot({ monthly_cap: 11, monthly_messages_remaining: 11 })),
    );
    await waitFor(() =>
      expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/your 11 BotMason/u),
    );

    await act(async () => oldRead.resolve(usageSnapshot()));
    expect(view.getByTestId('resonance-explainer-cost')).toHaveTextContent(/your 11 BotMason/u);
    expect(view.getByTestId('resonance-explainer-cost')).not.toHaveTextContent(/your 7 BotMason/u);
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
