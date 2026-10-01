/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

// Every other JournalEntryScreen test resolves completionSuggestions.list empty; these pin the pending-card render and the dismissed-suggestion filter.
import type { AcceptSuggestionResult, CompletionSuggestion, JournalMessage } from '@/api';
// The real store and the real day math: the card reads its unit out of one and
// its "today" out of the other, and a stub of either would pass a lookup that
// happily returned another row's unit.
import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitStore } from '@/store/useHabitStore';
import { addDaysInTZ, todayInUserTZ } from '@/utils/dateUtils';

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

/** A server-backed habit whose goal 3 tracks ounces -- the unit the card names. */
function waterHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 11,
    stage: 'Beige',
    name: 'Drink water',
    icon: '\u{1F4A7}',
    streak: 0,
    energy_cost: 1,
    energy_return: 1,
    start_date: new Date('2026-01-01T00:00:00Z'),
    goals: [
      {
        id: 3,
        title: 'Water',
        tier: 'clear' as const,
        target: 64,
        target_unit: 'oz',
        frequency: 1,
        frequency_unit: 'day',
        is_additive: true,
      },
    ],
    ...overrides,
  };
}

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
    completed_units: null,
    completed_on: null,
    logged_on: null,
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
  useHabitStore.getState().setHabits([]);
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

  it('places a completion suggestion after every anchored margin note, even when its anchor comes first', async () => {
    // "run" is characters 21-24 of the body, so the note's highlight is drawn
    // and the note is anchored. The suggestion's anchor (2) comes first and it
    // is the OLDER row -- so neither anchor order nor creation order alone would
    // put the note first: only "drawn notes lead, unanchored rows trail" does.
    mockGet.mockResolvedValue(entry({ id: 7, status: 'finished' }));
    mockList.mockResolvedValue({
      items: [
        {
          id: 51,
          journal_entry_id: 7,
          kind: 'theme',
          anchor_start: 21,
          anchor_end: 24,
          anchor_text: 'run',
          note: 'You keep moving.',
          essay: null,
          essay_generated_at: null,
          status: 'active',
          created_at: '2026-06-02T00:00:00Z',
          updated_at: '2026-06-02T00:00:00Z',
        },
      ],
    });
    mockCompletionList.mockResolvedValue({
      items: [suggestionRow({ created_at: '2026-06-01T00:00:00Z' })],
    });

    const view = renderScreen({ entryId: 7 });
    await view.findByTestId('suggestion-90');
    await view.findByTestId('margin-note-51');

    const order = within(view.getByTestId('journal-margin-column'))
      .queryAllByTestId(/^(margin-note|suggestion)-\d+$/)
      .map((node) => String(node.props.testID));
    expect(order).toEqual(['margin-note-51', 'suggestion-90']);
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

  it('names the amount and the day the accept will log, in the goal\u2019s own unit', async () => {
    // The unit is not on the suggestion; it is read out of the habit store by
    // goal_id. Seeding the REAL store is the point -- a lookup that accepted a
    // demo or client-minted row would pass a stubbed one just as happily.
    useHabitStore.getState().setHabits([waterHabit()]);
    const yesterday = addDaysInTZ(todayInUserTZ(mockUserTz), -1, mockUserTz);
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({
      items: [
        suggestionRow({
          label: 'drank 64 oz of water',
          completed_units: 64,
          completed_on: yesterday,
        }),
      ],
    });

    const view = renderScreen({ entryId: 7 });

    const accept = await view.findByTestId('suggestion-90-accept');
    expect(accept.props.accessibilityLabel).toBe(
      'Check off drank 64 oz of water, 64 oz, yesterday',
    );
    expect(view.getByText(/64 oz \u00b7 yesterday\. Log it\?/u)).toBeTruthy();
  });

  it('picks up the unit when the store fills while the card is already on screen', async () => {
    // The card SUBSCRIBES to the habit store; it does not read it once at
    // mount. In production the store is empty when the offer first paints and
    // the warm-up fills it a round trip later, so a non-reactive read would
    // leave the writer consenting to "64" with no unit -- and every other test
    // here seeds the store before render, so none of them can tell the two
    // apart.
    const yesterday = addDaysInTZ(todayInUserTZ(mockUserTz), -1, mockUserTz);
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({
      items: [
        suggestionRow({
          label: 'drank 64 oz of water',
          completed_units: 64,
          completed_on: yesterday,
        }),
      ],
    });

    const view = renderScreen({ entryId: 7 });

    await view.findByTestId('suggestion-90');
    expect(view.getByText(/64 \u00b7 yesterday\. Log it\?/u)).toBeTruthy();

    await act(async () => {
      useHabitStore.getState().setHabits([waterHabit()]);
    });

    expect(view.getByText(/64 oz \u00b7 yesterday\. Log it\?/u)).toBeTruthy();
    expect(view.getByTestId('suggestion-90-accept').props.accessibilityLabel).toBe(
      'Check off drank 64 oz of water, 64 oz, yesterday',
    );
  });

  it('asks for the goal\u2019s unit once when the store is cold, and the day is the AUTH zone\u2019s', async () => {
    // Nothing on this route hydrates the habit store, so without the warm-up
    // the card would read "64" with no unit after a cold open.
    const yesterday = addDaysInTZ(todayInUserTZ(mockUserTz), -1, mockUserTz);
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({
      items: [suggestionRow({ completed_units: 64, completed_on: yesterday })],
    });

    const view = renderScreen({ entryId: 7 });

    await view.findByTestId('suggestion-90');
    await waitFor(() => expect(mockLoadHabits).toHaveBeenCalledWith(mockUserTz));
    expect(mockLoadHabits).toHaveBeenCalledTimes(1);
  });

  it('names the day in the signed-in person\u2019s zone, not the device\u2019s', async () => {
    // 03:00 UTC is still the previous evening in Chicago, so the two zones
    // disagree about what "today" is. Jest pins the device zone to UTC, so a
    // card reading the device clock would say "yesterday" here. Frozen rather
    // than left to the wall clock: the two zones only disagree for six hours a
    // day, and a guard that can only fail at 1am is not a guard.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-12T03:00:00Z'));
    try {
      mockGet.mockResolvedValue(entry({ id: 7 }));
      mockCompletionList.mockResolvedValue({
        items: [suggestionRow({ completed_units: 64, completed_on: '2026-09-11' })],
      });

      const view = renderScreen({ entryId: 7 });

      await view.findByTestId('suggestion-90');
      expect(view.getByText(/64 \u00b7 today\. Log it\?/u)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('spends no round trip warming a habit store that is already hydrated', async () => {
    useHabitStore.getState().setHabits([waterHabit()]);
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items: [suggestionRow()] });

    const view = renderScreen({ entryId: 7 });

    await view.findByTestId('suggestion-90');
    expect(mockLoadHabits).not.toHaveBeenCalled();
  });

  it('does not warm the habit store for a practice-only offer', async () => {
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({
      items: [suggestionRow({ target_type: 'practice', goal_id: null, user_practice_id: 4 })],
    });

    const view = renderScreen({ entryId: 7 });

    await view.findByTestId('suggestion-90');
    expect(mockLoadHabits).not.toHaveBeenCalled();
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

/** Every string leaf under `node`, concatenated — the card's copy as read. */
function flattenText(node: { children: Array<unknown> }): string {
  return node.children
    .map((child) =>
      typeof child === 'string' ? child : flattenText(child as { children: Array<unknown> }),
    )
    .join('');
}

// #2905. The accept ran on day N = 2026-09-12 (Chicago). The detected day was
// N+1 -- what a westward timezone move turns "today" into -- so the server fell
// back and logged N. Every clock below is Chicago midday on the named day.
const LOGGED_DAY = '2026-09-12';
const DETECTED_DAY = '2026-09-13';
const midday = (dayKey: string): Date => new Date(`${dayKey}T17:00:00Z`);
const DAY_AFTER_LOGGED = '2026-09-13';
// Past the 30-day backfill window, so a window-gated settled card drops the day.
const FORTY_DAYS_AFTER_LOGGED = '2026-10-22';
const LOGGED_DAY_AS_A_DATE = 'Sat, Sep 12';

function acceptedRow(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return suggestionRow({
    status: 'accepted',
    accepted_at: '2026-09-12T18:00:00Z',
    completed_units: 64,
    completed_on: DETECTED_DAY,
    logged_on: LOGGED_DAY,
    ...overrides,
  });
}

/** Render the entry with `items` hydrated from the list endpoint, as a reopen does. */
async function settledTextOnReopen(
  items: CompletionSuggestion[],
  todayKey: string,
): Promise<string> {
  jest.useFakeTimers();
  jest.setSystemTime(midday(todayKey));
  try {
    useHabitStore.getState().setHabits([waterHabit()]);
    mockGet.mockResolvedValue(entry({ id: 7 }));
    mockCompletionList.mockResolvedValue({ items });
    const view = renderScreen({ entryId: 7 });
    return flattenText(await view.findByTestId('suggestion-90-checked'));
  } finally {
    jest.useRealTimers();
  }
}

describe('JournalEntryScreen — a settled offer names the day the accept logged (#2905)', () => {
  it('names the day the accept logged on a settled card reopened the next day', async () => {
    const text = await settledTextOnReopen([acceptedRow()], DAY_AFTER_LOGGED);

    expect(text).toBe('✓ Checked off · 64 oz · yesterday');
    expect(text).not.toMatch(/today/u);
  });

  it('names the logged day on the day itself', async () => {
    expect(await settledTextOnReopen([acceptedRow()], LOGGED_DAY)).toBe(
      '✓ Checked off · 64 oz · today',
    );
  });

  it('still names the logged day forty days on, past the backfill window', async () => {
    expect(await settledTextOnReopen([acceptedRow()], FORTY_DAYS_AFTER_LOGGED)).toBe(
      `✓ Checked off · 64 oz · ${LOGGED_DAY_AS_A_DATE}`,
    );
  });

  it('omits the day for a legacy accepted row rather than re-deriving it', async () => {
    // Accepted before the day was recorded. `completed_on` is today, so a card
    // that fell back to it would print "today" -- a guess, not a record.
    const legacy = acceptedRow({ logged_on: null, completed_on: DAY_AFTER_LOGGED });

    expect(await settledTextOnReopen([legacy], DAY_AFTER_LOGGED)).toBe('✓ Checked off · 64 oz');
  });

  it('names the logged day straight after OK, from the accept response', async () => {
    // The in-session path: the card is replaced wholesale by the accept
    // response's row, so the day must ride on THAT, not only on the list.
    jest.useFakeTimers();
    jest.setSystemTime(midday(DAY_AFTER_LOGGED));
    try {
      useHabitStore.getState().setHabits([waterHabit()]);
      mockGet.mockResolvedValue(entry({ id: 7 }));
      mockCompletionList.mockResolvedValue({
        items: [suggestionRow({ completed_units: 64, completed_on: DAY_AFTER_LOGGED })],
      });
      mockAccept.mockResolvedValue(
        acceptResult({
          completed_units: 64,
          completed_on: DAY_AFTER_LOGGED,
          logged_on: LOGGED_DAY,
        }),
      );

      const view = renderScreen({ entryId: 7 });
      fireEvent.press(await view.findByTestId('suggestion-90-accept'));
      const text = flattenText(await view.findByTestId('suggestion-90-checked'));

      expect(text).toMatch(/^✓ Checked off · 64 oz · yesterday/u);
      expect(text).not.toMatch(/today/u);
    } finally {
      jest.useRealTimers();
    }
  });
});
