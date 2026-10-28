/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React, { Profiler } from 'react';

import { note, resonancePayload } from './resonanceTestKit';

/**
 * The offer to sort the rest of the writing, beside the page (#3500).
 *
 * Rendered from the same host as the consent invitation, after a completed
 * pass, only under a standing yes with something unsorted -- and never while
 * the invitation is on the page: one offer at a time, and the decision about
 * sorting outranks an offer to sort. Its affirmative navigates to the
 * sort-the-rest screen and never sorts in place.
 */

import type {
  CorpusConsent,
  CorpusInvitation,
  CorpusSweepEstimate,
  JournalMessage,
  ResonanceResponse,
} from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockStatus = jest.fn() as jest.MockedFunction<() => Promise<CorpusInvitation>>;
const mockDismiss = jest.fn() as jest.MockedFunction<
  (_never: boolean) => Promise<CorpusInvitation>
>;
const mockConsentList = jest.fn() as jest.MockedFunction<() => Promise<CorpusConsent[]>>;
const mockEstimate = jest.fn() as jest.MockedFunction<() => Promise<CorpusSweepEstimate>>;
const mockSweep = jest.fn() as jest.MockedFunction<() => Promise<unknown>>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
// These specs are about what a pass produces, not about the note in front of it:
// render as a reader who has already read the cost note and set it aside.
jest.mock('@/storage/resonanceExplainerStorage', () => require('./resonanceExplainerTestKit'));

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  ...require('./journalUiFlagsTestKit'),
  ...require('./readingRouteTestKit'),
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
  corpusConsent: {
    list: (...a: unknown[]) => (mockConsentList as unknown as (...x: unknown[]) => unknown)(...a),
  },
  corpus: {
    sweepEstimate: (...a: unknown[]) =>
      (mockEstimate as unknown as (...x: unknown[]) => unknown)(...a),
    sweep: (...a: unknown[]) => (mockSweep as unknown as (...x: unknown[]) => unknown)(...a),
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

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const INVITATION = 'journal-corpus-invitation';
const OFFER = 'journal-corpus-sweep-offer';
const GRANTED: CorpusConsent[] = [
  { source: 'journal', granted: true, decided_at: '2026-10-01T00:00:00Z' },
];
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

/**
 * Every commit is checked for the sweep offer, so a single frame in which it
 * rendered is caught even though a later commit took it away again.
 */
const sightings = { offer: 0 };
let currentView: { queryByTestId: (id: string) => unknown } | null = null;

function noteCommit() {
  if (currentView?.queryByTestId(OFFER)) sightings.offer += 1;
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  const view = render(
    <Profiler id="journal-entry" onRender={noteCommit}>
      <Screen navigation={navigation} route={route} autosaveDelayMs={100} />
    </Profiler>,
  );
  currentView = view;
  return { ...view, navigation };
}

/** A read the test answers by hand, so the order of arrivals is the test's. */
function deferred<T>() {
  let settle: (value: T) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** Load the entry in read mode and press the inline resonance affordance. */
async function pressResonance() {
  const view = renderScreen();
  await view.findByTestId('get-resonance-button');
  expect(view.queryByTestId(INVITATION)).toBeNull();
  // Opening an entry asks nothing: the offer waits for a completed pass.
  expect(view.queryByTestId(OFFER)).toBeNull();
  expect(mockEstimate).not.toHaveBeenCalled();
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
  mockStatus.mockResolvedValue(SILENT);
  mockDismiss.mockResolvedValue(SILENT);
  mockConsentList.mockReset();
  mockEstimate.mockReset();
  mockSweep.mockReset();
  mockConsentList.mockResolvedValue(GRANTED);
  mockEstimate.mockResolvedValue({ entries_pending: 412 });
});

beforeEach(async () => {
  sightings.offer = 0;
  currentView = null;
  await AsyncStorage.clear();
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  setActiveUser(null);
});

describe('JournalEntryScreen — the offer to sort the rest of the writing', () => {
  it('offers the backlog beside the page after a completed pass, never in the margin or sheet', async () => {
    const view = await pressResonance();

    await view.findByTestId(OFFER);
    expect(within(view.getByTestId('journal-screen')).getByTestId(OFFER)).toBeTruthy();
    expect(within(view.getByTestId('journal-margin-column')).queryByTestId(OFFER)).toBeNull();
    expect(within(view.getByTestId('journal-sheet')).queryByTestId(OFFER)).toBeNull();
    expect(view.queryByTestId(INVITATION)).toBeNull();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('gives way to the consent invitation: one offer on the page at a time', async () => {
    mockStatus.mockResolvedValue(OFFERED);
    const view = await pressResonance();

    await view.findByTestId(INVITATION);
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId(OFFER)).toBeNull();
  });

  it('the affirmative opens the sort-the-rest screen and sorts nothing', async () => {
    const view = await pressResonance();
    await view.findByTestId(OFFER);

    fireEvent.press(view.getByTestId(`${OFFER}-open`));

    expect(view.navigation.navigate).toHaveBeenCalledWith('CorpusSweep');
    expect(mockSweep).not.toHaveBeenCalled();
    expect(view.queryByTestId(OFFER)).toBeNull();
  });

  it('renders nothing at zero pending', async () => {
    mockEstimate.mockResolvedValue({ entries_pending: 0 });
    const view = await pressResonance();

    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId(OFFER)).toBeNull();
  });
});

describe('JournalEntryScreen — the sweep offer waits for the invitation to settle (#3604)', () => {
  it('never shows the sweep offer while a slow invitation read is still out, then yields to it', async () => {
    const invitation = deferred<CorpusInvitation>();
    mockStatus.mockReturnValue(invitation.promise);
    const view = await pressResonance();

    // Every sweep read has answered "offer" while the invitation is still on the wire.
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(view.queryByTestId(OFFER)).toBeNull();

    await act(async () => {
      invitation.settle(OFFERED);
    });

    await view.findByTestId(INVITATION);
    expect(view.queryByTestId(OFFER)).toBeNull();
    // Not one commit carried the sweep offer, not even for a frame.
    expect(sightings.offer).toBe(0);
  });

  it('shows the sweep offer once a slow invitation read settles silent', async () => {
    const invitation = deferred<CorpusInvitation>();
    mockStatus.mockReturnValue(invitation.promise);
    const view = await pressResonance();
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(view.queryByTestId(OFFER)).toBeNull();

    await act(async () => {
      invitation.settle(SILENT);
    });

    await view.findByTestId(OFFER);
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });

  it('a failed invitation read counts as settled and silent, so the sweep offer is not held forever', async () => {
    const invitation = deferred<CorpusInvitation>();
    mockStatus.mockReturnValue(invitation.promise);
    const view = await pressResonance();
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(1));

    await act(async () => {
      invitation.fail(new Error('offline'));
    });

    await view.findByTestId(OFFER);
    expect(view.queryByTestId(INVITATION)).toBeNull();
  });

  it('when the invitation answers first and the sweep reads after, the invitation alone shows', async () => {
    const estimate = deferred<CorpusSweepEstimate>();
    mockStatus.mockResolvedValue(OFFERED);
    mockEstimate.mockReturnValue(estimate.promise);
    const view = await pressResonance();
    await view.findByTestId(INVITATION);

    await act(async () => {
      estimate.settle({ entries_pending: 412 });
    });

    expect(view.queryByTestId(OFFER)).toBeNull();
    expect(view.getByTestId(INVITATION)).toBeTruthy();
    expect(sightings.offer).toBe(0);
  });

  it('when a silent invitation answers first, the sweep offer shows once its own reads land', async () => {
    const estimate = deferred<CorpusSweepEstimate>();
    mockStatus.mockResolvedValue(SILENT);
    mockEstimate.mockReturnValue(estimate.promise);
    const view = await pressResonance();
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(view.queryByTestId(OFFER)).toBeNull();

    await act(async () => {
      estimate.settle({ entries_pending: 412 });
    });

    await view.findByTestId(OFFER);
  });

  it('asks nothing more than before: one invitation read and one sweep chain per pass', async () => {
    const view = await pressResonance();
    await view.findByTestId(OFFER);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(mockConsentList).toHaveBeenCalledTimes(1);
    expect(mockEstimate).toHaveBeenCalledTimes(1);
  });
});
