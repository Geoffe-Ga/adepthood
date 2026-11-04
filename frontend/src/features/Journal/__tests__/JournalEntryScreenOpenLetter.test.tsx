import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Arriving from a letter quote's Open on the Promoted quotes screen (#3659):
// the route's openLetterFor names a margin note, and once the page's notes
// load its Resonance Letter opens over the page -- once. A note that is gone
// opens nothing, and the page reads as an ordinary open.
import type { JournalMessage, Marginalia, PromotedQuote } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: Marginalia[] }>
>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: unknown[] }>
>;
const mockPromote = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockRemovePromotion = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockPromotionsList = jest.fn() as jest.MockedFunction<
  (_entryId: number) => Promise<PromotedQuote[]>
>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  ...require('./journalUiFlagsTestKit'),
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
    list: (...a: unknown[]) =>
      (mockCompletionList as unknown as (...x: unknown[]) => unknown)(...a),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: (...a: unknown[]) => (mockPromote as unknown as (...x: unknown[]) => unknown)(...a),
    remove: (...a: unknown[]) =>
      (mockRemovePromotion as unknown as (...x: unknown[]) => unknown)(...a),
    setIncluded: jest.fn(),
    list: (...a: unknown[]) =>
      (mockPromotionsList as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: BODY,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Runs',
    status: 'finished', // read mode -- the surface this issue lives in
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 9,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 2,
    anchor_end: 8,
    anchor_text: 'page a',
    note: 'You keep returning to the river.',
    essay: 'Dear writer, be gentle with the miles.',
    essay_generated_at: '2026-06-02T00:00:00Z',
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function renderScreen(params?: { entryId?: number; openLetterFor?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    push: jest.fn(),
    addListener: jest.fn(() => () => {}),
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockResolvedValue(entry());
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [note(), note({ id: 10, essay: null })] });
  mockCompletionList.mockReset();
  mockCompletionList.mockResolvedValue({ items: [] });
  mockPromote.mockReset();
  mockRemovePromotion.mockReset();
  mockPromotionsList.mockReset();
  mockPromotionsList.mockResolvedValue([]);
});

describe('JournalEntryScreen -- arriving to read a letter (#3659)', () => {
  it('opens the named note’s letter once the page’s notes load', async () => {
    const { findByTestId, findByText } = renderScreen({ entryId: 7, openLetterFor: 9 });

    expect(await findByTestId('essay-modal')).toBeTruthy();
    expect(await findByText('Dear writer, be gentle with the miles.')).toBeTruthy();
    expect(mockList).toHaveBeenCalledWith(7);
  });

  it('opens it only once: closed, it stays closed', async () => {
    const { findByTestId, queryByTestId, getByTestId } = renderScreen({
      entryId: 7,
      openLetterFor: 9,
    });
    await findByTestId('essay-modal');

    fireEvent.press(getByTestId('essay-scrim'));

    await waitFor(() => expect(queryByTestId('essay-modal')).toBeNull());
    expect(await findByTestId('margin-note-9')).toBeTruthy();
    expect(queryByTestId('essay-modal')).toBeNull();
  });

  it('opens nothing when that note is gone', async () => {
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7, openLetterFor: 99 });

    expect(await findByTestId('margin-note-9')).toBeTruthy();
    expect(queryByTestId('essay-modal')).toBeNull();
  });

  it('opens nothing on an ordinary open', async () => {
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7 });

    expect(await findByTestId('margin-note-9')).toBeTruthy();
    expect(queryByTestId('essay-modal')).toBeNull();
  });
});
