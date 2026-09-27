/* eslint-env jest */
// No journal body, anchor text or selected text may reach a logger, diagnostic
// or error copy on the anchor paths #2891 touched: a failed Finish (whose
// stored-body adoption must not leak), a failed promote, a failed post-edit
// promotions refresh, and a failed inclusion mark on a folded-in quote.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import React from 'react';

import { useReflectionMode } from '../useReflectionMode';

import { ApiError } from '@/api';
import type { JournalMessage, PromotedQuote } from '@/api';

/** A phrase that must never appear in any diagnostic sink. */
const PRIVATE_PHRASE = 'my private grief about the river';
const BODY = `Today: ${PRIVATE_PHRASE}. Then tea.`;

const mockGet = jest.fn<(_id: number) => Promise<JournalMessage>>();
const mockUpdate = jest.fn<(_id: number, _p: unknown) => Promise<JournalMessage>>();
const mockCreate = jest.fn<(_e: unknown) => Promise<JournalMessage>>();
const mockPromote = jest.fn<(_id: number, _span: unknown) => Promise<PromotedQuote>>();
const mockPromotionsList = jest.fn<(_id: number) => Promise<PromotedQuote[]>>();
const mockSetIncluded = jest.fn<(_id: number, _entryId: number | null) => Promise<unknown>>();
const mockReportException = jest.fn();

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));
jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));
jest.mock('@/storage/promoteExplainerStorage', () => require('./promoteExplainerTestKit'));
jest.mock('@/observability/sentry', () => ({
  reportException: (...a: unknown[]) => mockReportException(...a),
  initErrorMonitoring: () => false,
}));
jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ApiError: actual.ApiError,
    journal: {
      get: (...a: [number]) => mockGet(...a),
      create: (...a: [unknown]) => mockCreate(...a),
      update: (...a: [number, unknown]) => mockUpdate(...a),
    },
    prompts: { respond: jest.fn() },
    resonance: { list: () => Promise.resolve({ items: [] }), generate: jest.fn() },
    completionSuggestions: {
      list: () => Promise.resolve({ items: [] }),
      accept: jest.fn(),
      dismiss: jest.fn(),
    },
    promotions: {
      create: (...a: [number, unknown]) => mockPromote(...a),
      remove: jest.fn(),
      setIncluded: (...a: [number, number | null]) => mockSetIncluded(...a),
      list: (...a: [number]) => mockPromotionsList(...a),
    },
    reflections: { sources: () => Promise.resolve({ items: [] }) },
  };
});

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: BODY,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Private',
    status: 'finished',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

type Spy = { mock: { calls: unknown[][] } };
let spies: Spy[] = [];

/** Every argument any diagnostic sink received, as one searchable string. */
function everythingLogged(): string {
  return [...spies, mockReportException]
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ''}` : String(arg)))
    .join('\n');
}

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} autosaveDelayMs={100} />);
}

beforeEach(() => {
  spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {}),
  );
  mockReportException.mockReset();
  mockGet.mockReset();
  mockGet.mockResolvedValue(entry());
  mockUpdate.mockReset();
  mockCreate.mockReset();
  mockPromote.mockReset();
  mockPromotionsList.mockReset();
  mockPromotionsList.mockResolvedValue([]);
  mockSetIncluded.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('anchor paths keep the writer’s words out of diagnostics (#2891)', () => {
  it('a failed Finish logs and shows nothing of the body', async () => {
    mockCreate.mockRejectedValue(new ApiError(503, 'service_unavailable'));
    const { getByTestId, findByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), BODY);
    await act(async () => {
      fireEvent.press(getByTestId('journal-finish-button'));
    });
    expect(await findByTestId('journal-finish-button')).toBeTruthy();
    expect(everythingLogged()).not.toContain(PRIVATE_PHRASE);
  });

  it('a failed promote logs nothing of the selection and its notice quotes none of it', async () => {
    mockPromote.mockRejectedValue(new ApiError(422, 'anchor_out_of_range'));
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const start = BODY.indexOf(PRIVATE_PHRASE);
    fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
      nativeEvent: { selection: { start, end: start + PRIVATE_PHRASE.length } },
    });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    const notice = await findByTestId('quote-promotion-error');
    expect(String(notice.props.children)).not.toContain(PRIVATE_PHRASE);
    expect(everythingLogged()).not.toContain(PRIVATE_PHRASE);
  });

  it('a failed post-edit promotions refresh logs nothing of the quote', async () => {
    jest.useFakeTimers();
    try {
      mockPromotionsList.mockResolvedValueOnce([
        {
          id: 1,
          source_entry_id: 7,
          anchor_start: BODY.indexOf(PRIVATE_PHRASE),
          anchor_end: BODY.indexOf(PRIVATE_PHRASE) + PRIVATE_PHRASE.length,
          anchor_text: PRIVATE_PHRASE,
          pending: true,
          stale: false,
        },
      ]);
      mockUpdate.mockResolvedValue(entry({ message: `New. ${BODY}` }));
      const { getByTestId, findByTestId } = renderScreen({ entryId: 7 });
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-edit'));
      mockPromotionsList.mockRejectedValueOnce(new ApiError(503, 'service_unavailable'));
      fireEvent.changeText(await findByTestId('journal-body-input'), `New. ${BODY}`);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockPromotionsList).toHaveBeenCalledTimes(2);
      expect(everythingLogged()).not.toContain(PRIVATE_PHRASE);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed inclusion mark logs nothing of the folded quote', async () => {
    mockSetIncluded.mockRejectedValue(new ApiError(503, 'service_unavailable'));
    const bodyRef = { current: '' };
    const { result } = renderHook(() =>
      useReflectionMode({
        reflectionLevel: 'week',
        reflectionScopeKey: '2026-W23',
        bodyRef,
        onChangeBody: (next: string) => {
          bodyRef.current = next;
        },
        flush: () => Promise.resolve(42),
      }),
    );
    await act(async () => {
      await result.current.onInsertQuote(
        {
          id: 1,
          anchor_start: 0,
          anchor_end: PRIVATE_PHRASE.length,
          anchor_text: PRIVATE_PHRASE,
          pending: true,
        },
        {
          kind: 'entry',
          id: 7,
          title: 'Private',
          timestamp: '2026-06-01T00:00:00Z',
          body: BODY,
          reflection_level: null,
          promoted_quotes: [],
        },
      );
    });
    expect(result.current.inclusionHint).toBe(true);
    expect(everythingLogged()).not.toContain(PRIVATE_PHRASE);
  });
});
