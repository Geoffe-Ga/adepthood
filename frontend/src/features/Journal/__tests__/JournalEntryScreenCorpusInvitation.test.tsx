/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { note, resonancePayload } from './resonanceTestKit';

/**
 * The corpus invitation at the Resonance moment (#2407, owner ruling 2026-09-05).
 *
 * After the first COMPLETED pass on an account whose journal-source consent is
 * undecided, the screen renders a one-tap-declinable note as a sibling of the
 * page -- never in the margin column or the sheet -- and only when the server
 * says ``offer: true``. The pass itself is never gated: ``resonance.generate``
 * is called exactly once per press and the margin renders identically whether
 * the invitation is offered, declined, or its read fails.
 */
import type { CorpusInvitation, JournalMessage, ResonanceResponse } from '@/api';
import {
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_LEAD,
} from '@/features/Settings/corpusConsentCopy';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockStatus = jest.fn() as jest.MockedFunction<() => Promise<CorpusInvitation>>;
const mockDismiss = jest.fn() as jest.MockedFunction<
  (_never: boolean) => Promise<CorpusInvitation>
>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
// These specs are about what a pass produces, not about the note in front of it:
// render as a reader who has already read the cost note and set it aside.
jest.mock('@/storage/resonanceExplainerStorage', () => require('./resonanceExplainerTestKit'));

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

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
  corpusInvitation: {
    status: (...a: unknown[]) => (mockStatus as unknown as (...x: unknown[]) => unknown)(...a),
    dismiss: (...a: unknown[]) => (mockDismiss as unknown as (...x: unknown[]) => unknown)(...a),
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

const INVITATION = 'journal-corpus-invitation';
const OFFERED: CorpusInvitation = { offer: true, dismissed_at: null, do_not_ask_again: false };
const SILENT: CorpusInvitation = { offer: false, dismissed_at: null, do_not_ask_again: false };

function entry(): JournalMessage {
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
    updated_at: '2026-06-01T00:00:00Z',
  } as JournalMessage;
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} autosaveDelayMs={100} />),
    navigation,
  };
}

/** Load the entry in read mode and press the inline resonance affordance. */
async function pressResonance() {
  const view = renderScreen();
  await view.findByTestId('get-resonance-button');
  expect(view.queryByTestId(INVITATION)).toBeNull();
  fireEvent.press(view.getByTestId('get-resonance-button'));
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
  return view;
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockGenerate.mockReset();
  mockStatus.mockReset();
  mockDismiss.mockReset();
  mockGet.mockResolvedValue(entry());
  mockList.mockResolvedValue({ items: [] });
  mockGenerate.mockResolvedValue(resonancePayload({ marginalia: [note()] }));
  mockStatus.mockResolvedValue(OFFERED);
  mockDismiss.mockResolvedValue(SILENT);
});

describe('JournalEntryScreen — the corpus invitation after a first completed pass', () => {
  it('offers the corpus decision once the first resonance pass has completed on an account that has never decided', async () => {
    const view = await pressResonance();

    await view.findByTestId(INVITATION);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(within(view.getByTestId('journal-screen')).getByTestId(INVITATION)).toBeTruthy();
    expect(within(view.getByTestId('journal-margin-column')).queryByTestId(INVITATION)).toBeNull();
    expect(within(view.getByTestId('journal-sheet')).queryByTestId(INVITATION)).toBeNull();
    expect(view.getByTestId(`${INVITATION}-dismiss`)).toBeTruthy();
    expect(view.getByTestId(`${INVITATION}-never`)).toBeTruthy();
    expect(view.getByText(CORPUS_CONSENT_LEAD, { exact: false })).toBeTruthy();
    expect(view.getByText(CORPUS_CONSENT_CONSEQUENCE_SENDING, { exact: false })).toBeTruthy();
    // The pass itself was never gated: the note landed in the margin regardless.
    expect(await view.findByText('A beginning.')).toBeTruthy();
  });

  it('renders nothing when the server says not to offer, and the margin is unchanged', async () => {
    mockStatus.mockResolvedValue(SILENT);
    const view = await pressResonance();

    expect(await view.findByText('A beginning.')).toBeTruthy();
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });

  it('asks the server nothing when the pass rejected', async () => {
    mockGenerate.mockRejectedValue(new Error('provider down'));
    const view = await pressResonance();

    await waitFor(() => expect(view.queryByTestId('journal-resonance-error')).not.toBeNull());
    expect(mockStatus).not.toHaveBeenCalled();
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });

  it('stays silent when the offer read itself fails', async () => {
    mockStatus.mockRejectedValue(new Error('offline'));
    const view = await pressResonance();

    expect(await view.findByText('A beginning.')).toBeTruthy();
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });

  it('"Not now" records a plain decline and takes the note away', async () => {
    const view = await pressResonance();
    await view.findByTestId(INVITATION);

    fireEvent.press(view.getByTestId(`${INVITATION}-dismiss`));

    expect(view.queryByTestId(INVITATION)).toBeNull();
    expect(mockDismiss).toHaveBeenCalledWith(false);
  });

  it('"Do not ask again" records the final decline and takes the note away', async () => {
    const view = await pressResonance();
    await view.findByTestId(INVITATION);

    fireEvent.press(view.getByTestId(`${INVITATION}-never`));

    expect(view.queryByTestId(INVITATION)).toBeNull();
    expect(mockDismiss).toHaveBeenCalledWith(true);
  });

  it('"Look at the decision" opens the consent screen and spends the offer as a Not now', async () => {
    const view = await pressResonance();
    await view.findByTestId(INVITATION);

    fireEvent.press(view.getByTestId(`${INVITATION}-open`));

    expect(view.navigation.navigate).toHaveBeenCalledWith('CorpusConsent');
    expect(mockDismiss).toHaveBeenCalledWith(false);
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });
});
