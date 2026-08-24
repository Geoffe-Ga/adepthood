/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * What the page shows when a resonance pass comes back with no notes.
 *
 * Reported from the local web build: "the resonance button also did nothing
 * just now. Failed silently." The whole stack answered 200, zero notes were
 * persisted, and the page rendered no change and no message — so the writer's
 * entire signal was that nothing happened, which is what a broken button looks
 * like too. The pass must always leave something on the page.
 */
import type { JournalMessage, ResonanceResponse } from '@/api';

const NO_NOTES =
  'No margin notes came back this time. Your Higher Self read the page through and ' +
  "didn't find a passage it could answer yet. Keep writing and ask again whenever " +
  "you like; this pass wasn't charged.";

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;

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
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function payload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 50,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function marginNote(): ResonanceResponse['marginalia'][number] {
  return {
    id: 1,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 0,
    anchor_end: 6,
    anchor_text: 'A page',
    note: 'You return to water.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} autosaveDelayMs={100} />);
}

/** Load the entry, press the affordance, and wait for the pass to resolve. */
async function runPass(response: ResonanceResponse) {
  mockGet.mockResolvedValue(entry());
  mockGenerate.mockResolvedValue(response);
  const view = renderScreen();
  await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
  fireEvent.press(view.getByTestId('get-resonance-button'));
  await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockGenerate.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

describe('JournalEntryScreen — a pass that yields no notes', () => {
  it('renders the reason the server gave, rather than nothing at all', async () => {
    const { findByTestId } = await runPass(payload({ no_notes_message: NO_NOTES }));

    expect((await findByTestId('journal-resonance-no-notes')).props.children).toBe(NO_NOTES);
  });

  it('says nothing when the pass produced notes', async () => {
    const { queryByTestId, findByText } = await runPass(payload({ marginalia: [marginNote()] }));

    await findByText('You return to water.');
    expect(queryByTestId('journal-resonance-no-notes')).toBeNull();
  });

  it('still shows the notice beside notes an earlier pass had left', async () => {
    mockList.mockResolvedValue({ items: [marginNote()] });
    const { findByTestId } = await runPass(payload({ no_notes_message: NO_NOTES }));

    // The margin already holds a note, so the empty-margin branch cannot be
    // what surfaces this — pressing the button and getting nothing new still
    // has to leave a trace, or the press looks ignored.
    expect(await findByTestId('journal-resonance-no-notes')).toBeTruthy();
  });

  it('leaves the page silent before the writer has asked for anything', async () => {
    mockGet.mockResolvedValue(entry());
    const { queryByTestId } = renderScreen();

    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());

    expect(queryByTestId('journal-resonance-no-notes')).toBeNull();
  });
});
