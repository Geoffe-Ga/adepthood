/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Every other JournalEntryScreen test resolves completionSuggestions.list empty; these pin the pending-card render and the dismissed-suggestion filter.
import type { CompletionSuggestion, JournalMessage } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[] }>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<never>>;
const mockDetect = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[]; checked: boolean }>
>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    respond: jest.fn(),
  },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  completionSuggestions: {
    list: (...a: unknown[]) =>
      (mockCompletionList as unknown as (...x: unknown[]) => unknown)(...a),
    detect: (...a: unknown[]) => (mockDetect as unknown as (...x: unknown[]) => unknown)(...a),
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
    message: 'A page about a daily run.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Runs',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function suggestionRow(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return {
    id: 90,
    journal_entry_id: 7,
    target_type: 'habit',
    goal_id: 3,
    user_practice_id: null,
    label: 'Daily run',
    anchor_start: 2,
    anchor_end: 10,
    anchor_text: 'a daily',
    status: 'pending',
    accepted_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} />);
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
  mockGenerate.mockReset();
  mockDetect.mockReset();
  mockDetect.mockResolvedValue({ items: [], checked: true });
});

describe('JournalEntryScreen — completion-suggestion margin cards', () => {
  it('renders a pending completion-suggestion card in the margin when there are no notes', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });

    const { findByTestId } = renderScreen({ entryId: 7 });

    expect(await findByTestId('suggestion-90')).toBeTruthy();
    expect(await findByTestId('suggestion-90-accept')).toBeTruthy();
  });

  it('filters out a dismissed suggestion, leaving only the pending one in the margin', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({
      items: [suggestionRow({ id: 90 }), suggestionRow({ id: 91, status: 'dismissed' })],
    });

    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7 });

    expect(await findByTestId('suggestion-90')).toBeTruthy();
    expect(queryByTestId('suggestion-91')).toBeNull();
  });

  it('keeps the reflection error visible beside an independently detected habit offer', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, status: 'finished' }));
    mockGenerate.mockRejectedValue({ status: 502, detail: 'llm_provider_error' });
    mockDetect.mockResolvedValue({ items: [suggestionRow()], checked: true });

    const view = renderScreen({ entryId: 7 });
    fireEvent.press(await view.findByRole('button', { name: 'Get resonance' }));

    expect(await view.findByTestId('suggestion-90')).toBeTruthy();
    await waitFor(() => {
      expect(view.getByTestId('journal-resonance-error').props.children).toContain(
        'We still checked it for completed habits',
      );
    });
  });
});
