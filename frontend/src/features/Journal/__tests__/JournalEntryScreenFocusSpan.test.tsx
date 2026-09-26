import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Arriving from the Promoted quotes screen (#2865): the route's highlightSpan
// names a quote, and read mode marks it and wraps its block in the measured
// anchor the page scrolls to. A span that no longer names a live quote opens
// the page at the top, exactly as an ordinary open does.
import type { JournalMessage, PromotedQuote } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
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

function promotedQuote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 55,
    source_entry_id: 7,
    anchor_start: 2,
    anchor_end: 19,
    anchor_text: 'went for a daily',
    pending: true,
    stale: false,
    ...overrides,
  };
}

function renderScreen(params?: {
  entryId?: number;
  highlightSpan?: { start: number; end: number };
}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockCompletionList.mockReset();
  mockCompletionList.mockResolvedValue({ items: [] });
  mockPromote.mockReset();
  mockRemovePromotion.mockReset();
  mockPromotionsList.mockReset();
  mockPromotionsList.mockResolvedValue([]);
  mockGet.mockResolvedValue(entry());
});

const SPAN = { start: 2, end: 19 };

describe('JournalEntryScreen -- arriving to see a promoted quote', () => {
  it('marks the quote and anchors its block when the span names a live quote', async () => {
    mockPromotionsList.mockResolvedValue([promotedQuote()]);
    const { findByTestId, getByTestId, queryByTestId } = renderScreen({
      entryId: 7,
      highlightSpan: SPAN,
    });

    expect(await findByTestId('quote-highlight-55-focused')).toBeTruthy();
    expect(getByTestId('journal-focus-anchor')).toBeTruthy();
    expect(queryByTestId('quote-highlight-55')).toBeNull();
  });

  it('opens an ordinary page when no span was asked for', async () => {
    mockPromotionsList.mockResolvedValue([promotedQuote()]);
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7 });

    expect(await findByTestId('quote-highlight-55')).toBeTruthy();
    expect(queryByTestId('journal-focus-anchor')).toBeNull();
  });

  it.each([
    ['stale', { stale: true }, SPAN],
    [
      'out of range',
      { anchor_start: 2, anchor_end: BODY.length + 5 },
      { start: 2, end: BODY.length + 5 },
    ],
  ])('opens at the top, without crashing, for a %s span', async (_why, overrides, span) => {
    mockPromotionsList.mockResolvedValue([promotedQuote(overrides)]);
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7, highlightSpan: span });

    expect(await findByTestId('journal-body-read')).toBeTruthy();
    await waitFor(() => expect(mockPromotionsList).toHaveBeenCalledWith(7));
    expect(queryByTestId('journal-focus-anchor')).toBeNull();
    expect(queryByTestId('quote-highlight-55-focused')).toBeNull();
  });
});
