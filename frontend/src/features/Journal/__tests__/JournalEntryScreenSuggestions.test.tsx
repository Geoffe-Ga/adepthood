/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Every other JournalEntryScreen test resolves completionSuggestions.list empty; these pin the pending-card render and the dismissed-suggestion filter.
import type { AcceptSuggestionResult, CompletionSuggestion, JournalMessage } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[] }>
>;
const mockAccept = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<AcceptSuggestionResult>
>;
const mockLoadHabits = jest.fn() as jest.MockedFunction<(_tz?: string) => Promise<void>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<never>>;
const mockDetect = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[]; checked: boolean }>
>;

const mockUserTz = 'America/Chicago';

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
    accept: (...a: unknown[]) => (mockAccept as unknown as (...x: unknown[]) => unknown)(...a),
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

// Deliberately not ``authContextTestKit``: its zone is UTC, which Jest also pins
// as the device zone, so an assertion against it could not tell the threaded
// auth zone apart from a silent device-zone fallback. This one can.
// These specs are about what a pass produces, not about the note in front of it:
// render as a reader who has already read the cost note and set it aside.
jest.mock('@/storage/resonanceExplainerStorage', () => require('./resonanceExplainerTestKit'));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: mockUserTz }),
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: {
    loadHabits: (...a: unknown[]) =>
      (mockLoadHabits as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

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
  mockAccept.mockReset();
  mockLoadHabits.mockReset();
  mockLoadHabits.mockResolvedValue(undefined);
  mockGenerate.mockReset();
  mockDetect.mockReset();
  mockDetect.mockResolvedValue({ items: [], checked: true });
});

function acceptResult(overrides: Partial<CompletionSuggestion> = {}): AcceptSuggestionResult {
  return {
    suggestion: suggestionRow({
      status: 'accepted',
      accepted_at: '2026-06-01T00:00:00Z',
      ...overrides,
    }),
    check_in: { streak: 3, milestones: [], reason_code: 'logged', day_units: 1 },
  };
}

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

  it('surfaces a rejected accept in the margin while the pending card is still mounted', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });
    mockAccept.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const view = renderScreen({ entryId: 7 });
    fireEvent.press(await view.findByTestId('suggestion-90-accept'));

    const error = await view.findByTestId('journal-resonance-error');
    // The whole point: the failure is legible *beside* the card that produced it.
    expect(view.getByTestId('suggestion-90')).toBeTruthy();
    expect(view.queryByTestId('suggestion-90-checked')).toBeNull();
    // Announced, not merely drawn — silence in another medium is the same bug.
    expect(error.props.accessibilityLiveRegion).toBe('polite');
  });

  it('leaves the card re-pressable, so a second press issues a second accept', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });
    mockAccept.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const view = renderScreen({ entryId: 7 });
    fireEvent.press(await view.findByTestId('suggestion-90-accept'));
    await view.findByTestId('journal-resonance-error');
    fireEvent.press(view.getByTestId('suggestion-90-accept'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(2));
  });

  it('settles a successful accept to the checked card, with no error and a habit refresh', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });
    mockAccept.mockResolvedValue(acceptResult());

    const view = renderScreen({ entryId: 7 });
    fireEvent.press(await view.findByTestId('suggestion-90-accept'));

    expect(await view.findByTestId('suggestion-90-checked')).toBeTruthy();
    expect(view.queryByTestId('journal-resonance-error')).toBeNull();
    // The Habits tab and the shelf tile stay mounted behind this screen, so the
    // store only agrees with the card if the accept refreshes it — on the
    // auth-hydrated zone, or "today" is wrong near midnight.
    await waitFor(() => expect(mockLoadHabits).toHaveBeenCalledWith(mockUserTz));
  });

  it('clears a stale accept error once a later accept succeeds', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });
    mockAccept.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    mockAccept.mockResolvedValue(acceptResult());

    const view = renderScreen({ entryId: 7 });
    fireEvent.press(await view.findByTestId('suggestion-90-accept'));
    await view.findByTestId('journal-resonance-error');
    fireEvent.press(view.getByTestId('suggestion-90-accept'));

    expect(await view.findByTestId('suggestion-90-checked')).toBeTruthy();
    await waitFor(() => expect(view.queryByTestId('journal-resonance-error')).toBeNull());
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
