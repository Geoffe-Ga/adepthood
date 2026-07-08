/* eslint-env jest */
// RED: `JournalEntryScreen` does not yet recognize the `reflectionLevel` /
// `reflectionScopeKey` route params, does not call `reflections.sources`, and
// never sends `reflection_level`/`reflection_scope_key` on `journal.create` --
// every case below fails until the implementation-specialist wires reflection
// mode through the screen.
//
// `../ReflectionSourcesPanel` is stubbed to a button that fires
// `onInsertQuote(quote, sourceItem)` -- this file pins the create/setIncluded/
// 409 wiring, not the panel's own rendering (covered by
// `ReflectionSourcesPanel.test.tsx`).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type {
  JournalMessage,
  PromotedQuoteSummary,
  ReflectionDue,
  ReflectionSourceItem,
} from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: unknown[] }>
>;
const mockRespond = jest.fn() as jest.MockedFunction<(_w: number, _b: string) => Promise<unknown>>;
const mockSetIncluded = jest.fn() as jest.MockedFunction<
  (_id: number, _entryId: number | null) => Promise<unknown>
>;
const mockReflectionsDue = jest.fn() as jest.MockedFunction<
  () => Promise<{ due: ReflectionDue | null }>
>;
const mockReflectionsSources = jest.fn() as jest.MockedFunction<
  (_level: string, _scopeKey: string) => Promise<{ items: ReflectionSourceItem[] }>
>;

jest.mock('@/api', () => ({
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
    list: (...a: unknown[]) =>
      (mockCompletionList as unknown as (...x: unknown[]) => unknown)(...a),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: (...a: unknown[]) =>
      (mockSetIncluded as unknown as (...x: unknown[]) => unknown)(...a),
  },
  reflections: {
    due: (...a: unknown[]) => (mockReflectionsDue as unknown as (...x: unknown[]) => unknown)(...a),
    sources: (...a: unknown[]) =>
      (mockReflectionsSources as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

// Names are `mock`-prefixed so babel-plugin-jest-hoist allows referencing
// them from inside the `jest.mock(...)` factory below.
const mockStubQuote: PromotedQuoteSummary = {
  id: 90,
  anchor_start: 2,
  anchor_end: 19,
  anchor_text: 'went for a daily walk',
  pending: true,
};

const mockStubSourceItem: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Runs',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'I went for a daily walk to the river.',
  reflection_level: null,
  promoted_quotes: [mockStubQuote],
};

jest.mock('../ReflectionSourcesPanel', () => {
  const { Text, TouchableOpacity } = require('react-native');
  const Stub = ({
    onInsertQuote,
  }: {
    onInsertQuote: (_q: PromotedQuoteSummary, _item: ReflectionSourceItem) => void;
  }) => (
    <TouchableOpacity
      testID="stub-insert-quote"
      onPress={() => onInsertQuote(mockStubQuote, mockStubSourceItem)}
    >
      <Text>Insert stub quote</Text>
    </TouchableOpacity>
  );
  return { __esModule: true, default: Stub };
});

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 42,
    message: 'A reflection on the week.',
    sender: 'user',
    timestamp: '2026-07-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Stage Reflection — Survival',
    status: 'draft',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function renderScreen(params?: Record<string, unknown>, extraProps: Record<string, unknown> = {}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    push: jest.fn(),
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} {...extraProps} />),
    navigation,
  };
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
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
  mockSetIncluded.mockReset();
  mockSetIncluded.mockResolvedValue(mockStubQuote);
  mockReflectionsDue.mockReset();
  mockReflectionsDue.mockResolvedValue({ due: null });
  mockReflectionsSources.mockReset();
  mockReflectionsSources.mockResolvedValue({ items: [] });
});

const REFLECTION_PARAMS = {
  reflectionLevel: 'stage',
  reflectionScopeKey: 'c1:s1',
  prefillTitle: 'Stage Reflection — Survival',
};

describe('JournalEntryScreen -- reflection mode', () => {
  it('pre-fills the title, sends reflection fields on create, offers Finish, and never calls prompts.respond', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
      expect(getByTestId('journal-title-input').props.value).toBe('Stage Reflection — Survival');

      fireEvent.changeText(getByTestId('journal-body-input'), 'A reflection on the week.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'A reflection on the week.',
          reflection_level: 'stage',
          reflection_scope_key: 'c1:s1',
        }),
      );
      expect(mockRespond).not.toHaveBeenCalled();
      expect(getByTestId('journal-finish-button')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fetches the sources feed for the reflection level/scope on mount', async () => {
    renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockReflectionsSources.mock.calls[0]?.slice(0, 2)).toEqual(['stage', 'c1:s1']);
  });

  it('inserts a blockquote on a tapped pending quote and folds it in via setIncluded once the entry saves', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });

      const body = getByTestId('journal-body-input').props.value as string;
      expect(body).toContain('went for a daily walk');
      expect(body).toContain('>');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockSetIncluded).toHaveBeenCalledWith(90, 42);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves the quote pending and surfaces a warm hint when setIncluded rejects, without crashing', async () => {
    mockSetIncluded.mockRejectedValue({ status: 500, detail: 'boom' });
    jest.useFakeTimers();
    try {
      const { findByTestId } = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(await findByTestId('quote-inclusion-hint')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('on a 409 create conflict, consults reflections.due and routes to the existing entry', async () => {
    mockCreate.mockRejectedValue({ status: 409, detail: 'reflection_already_exists' });
    mockReflectionsDue.mockResolvedValue({
      due: {
        level: 'stage',
        scope_key: 'c1:s1',
        window_start: '2026-06-01T00:00:00Z',
        window_end: '2026-07-01T00:00:00Z',
        existing_entry_id: 77,
      },
    });
    jest.useFakeTimers();
    try {
      const { getByTestId, navigation } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A reflection on the week.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockReflectionsDue).toHaveBeenCalled();
      const replaceCall = navigation.replace.mock.calls[0];
      const navigateCall = navigation.navigate.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'JournalEntry' &&
          (call[1] as Record<string, unknown> | undefined)?.entryId === 77,
      );
      const routedToExisting =
        (replaceCall != null &&
          replaceCall[0] === 'JournalEntry' &&
          (replaceCall[1] as Record<string, unknown> | undefined)?.entryId === 77) ||
        navigateCall != null;
      expect(routedToExisting).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen -- weekly-prompt mode regression', () => {
  it('still calls prompts.respond and carries no reflection scope fields', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledWith(3, 'I noticed the willow.', 'Week 3 Reflection');
      expect(mockCreate).not.toHaveBeenCalled();
      const respondArgs = mockRespond.mock.calls[0];
      expect(respondArgs).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
