/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

/**
 * Where the writing timer lives on the page, and what it has to survive.
 *
 * Two of these are placement claims rather than behaviour claims, and they are
 * here because the placement IS the behaviour: the engine ticks ten times a
 * second, so whatever subtree hosts it repaints ten times a second, and the one
 * subtree that must not is the one holding the writer's own text fields.
 */
import type { JournalMessage } from '@/api';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';
import { saveWritingOfferAnswered } from '@/storage/writingOfferStorage';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(() => Promise.resolve({ id: 7 })),
    update: jest.fn(() => Promise.resolve({ id: 7 })),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: jest.fn(),
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

const mockRootNavigate = jest.fn();

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
  useRootNavigation: () => ({ navigate: mockRootNavigate }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const mockCheckOff = jest.fn((_request: { habitId: number; elapsedMs: number }) =>
  Promise.resolve(),
);

jest.mock('../writingHabitCheckOff', () => ({
  ...(jest.requireActual('../writingHabitCheckOff') as Record<string, unknown>),
  checkOffLinkedHabit: (request: { habitId: number; elapsedMs: number }) => mockCheckOff(request),
}));

const { useWritingHabitLinkStore } = require('@/store/useWritingHabitLinkStore') as {
  useWritingHabitLinkStore: {
    getState: () => { reset: () => void };
    setState: (_state: { habitId: number | null; hydrated: boolean }) => void;
  };
};

const JournalEntryScreen = require('../JournalEntryScreen').default;

/** The timer's default length, in milliseconds — long enough to run one out. */
const TWENTY_MINUTES_MS = 20 * 60 * 1000;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'A page written days ago about the river.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform',
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'finished',
    classification: 'personal',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function renderScreen(params?: {
  entryId?: number;
  writingSession?: { minutes: number; userPracticeId: number | null };
}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} autosaveDelayMs={100} />);
}

/** Let the page's own idle clock run out, which is what floats the resonance button. */
async function settle(ms: number = DEFAULT_IDLE_DELAY_MS): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockCheckOff.mockClear();
  useWritingHabitLinkStore.getState().reset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('JournalEntryScreen — where the writing timer appears', () => {
  it('offers the timer on the writing surface', () => {
    const { queryByTestId } = renderScreen();

    expect(queryByTestId('writing-timer-readout')).not.toBeNull();
  });

  it('offers none in the reading view, where nothing is being written', async () => {
    mockGet.mockResolvedValue(entry());
    const { queryByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());

    expect(queryByTestId('writing-timer-readout')).toBeNull();
  });

  /**
   * The engine's 100ms tick repaints whatever holds it. Inside the page that
   * would be both text fields and the live word count, ten times a second,
   * under the writer's hands — so the timer is mounted as a sibling of the
   * page, not a descendant of it.
   */
  it('mounts the timer outside the page, so a tick never lands on the text fields', () => {
    const { getByTestId } = renderScreen();

    expect(within(getByTestId('journal-page')).queryByTestId('writing-timer-readout')).toBeNull();
    expect(within(getByTestId('journal-page')).queryByTestId('journal-body-input')).not.toBeNull();
  });
});

describe('JournalEntryScreen — the timer and the resonance button share a corner', () => {
  /**
   * The resonance button's floating wrapper spans the page edge to edge, and it
   * is up precisely when the writer has paused with something written — which is
   * exactly the moment they reach for the timer. This drives that moment.
   *
   * It proves the two affordances are simultaneously mounted and independently
   * operable. It does NOT prove the geometry: RNTL performs no layout, so an
   * overlapping absolutely-positioned sibling is invisible to `fireEvent`. The
   * geometric half is pinned structurally in `writingTimerLayout.test.tsx` and
   * `GetResonanceButton.test.tsx`.
   */
  it('starts a session from the pill while the resonance button is up', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
    await settle();
    expect(queryByTestId('get-resonance-button')).not.toBeNull();

    fireEvent.press(getByTestId('writing-timer-start'));

    expect(queryByTestId('writing-timer-stop')).not.toBeNull();
    expect(queryByTestId('get-resonance-button')).not.toBeNull();
  });
});

describe('JournalEntryScreen — the timer does not interrupt the writing', () => {
  it('keeps counting while the writer keeps typing', async () => {
    jest.useFakeTimers();
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));

    for (const line of ['The willow', 'The willow leans', 'The willow leans over']) {
      fireEvent.changeText(getByTestId('journal-body-input'), line);
      await settle(2_000);
    }

    expect(getByTestId('writing-timer-readout').props.children).toBe('19:54');
    expect(getByTestId('journal-body-input').props.value).toBe('The willow leans over');
  });
});

/**
 * Reachability, not behaviour: the offer's own rules are pinned beside it in
 * `WritingSessionOffer.test.tsx`. What no test there can show is that a writer on
 * the real page ever meets it — six shipped features in this repo turned out to
 * be reachable by nobody while testing green the whole way. So this drives the
 * page itself, runs a session out, and looks for the offer in the note.
 */
describe('JournalEntryScreen — a finished session is offered as a habit', () => {
  it('puts the offer in the note the page leaves, once the session has run', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);

    expect(queryByTestId('writing-session-banner')).not.toBeNull();
    await waitFor(() => expect(queryByTestId('save-as-habit-accept')).not.toBeNull());
    expect(
      within(getByTestId('writing-session-banner')).queryByTestId('save-as-habit-decline'),
    ).not.toBeNull();
  });

  it('offers nothing to a writer who stopped early, because nothing was reported', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(60_000);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(queryByTestId('save-as-habit-accept')).toBeNull();
  });
});

/**
 * #2861: the seam that checks the linked habit off is the page's own session
 * handler, so this drives the real page rather than the hook alone — a screen
 * that forgot to pass the wrapped handler on would still pass a hook test.
 */
describe('JournalEntryScreen — a finished session checks off the linked habit', () => {
  const LINKED_HABIT_ID = 42;

  it('hands the finished session to the check-off when a habit is linked', async () => {
    jest.useFakeTimers();
    useWritingHabitLinkStore.setState({ habitId: LINKED_HABIT_ID, hydrated: true });
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff.mock.calls[0]?.[0]).toMatchObject({
      habitId: LINKED_HABIT_ID,
      elapsedMs: TWENTY_MINUTES_MS,
    });
  });

  it('checks nothing off when no habit is linked', async () => {
    jest.useFakeTimers();
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);

    expect(mockCheckOff).not.toHaveBeenCalled();
  });
});

/**
 * #3006: a finished session with no habit linked points to Settings, on BOTH
 * kinds of page — and on the ordinary page only once the end-of-session offer
 * has been answered, so a note never carries two invitations.
 */
describe('JournalEntryScreen — an unlinked timer points to Settings', () => {
  const LAUNCH = { minutes: 20, userPracticeId: null };
  const LINKED_HABIT_ID = 42;

  /** A running session collapses the pill; the next one starts from it re-opened. */
  function startAnotherSession(getByTestId: ReturnType<typeof renderScreen>['getByTestId']): void {
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId('writing-timer-start'));
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    await AsyncStorage.clear();
    useWritingHabitLinkStore.setState({ habitId: null, hydrated: true });
  });

  it('shows the link-a-habit note at the end of a quick-launched session when no habit is linked', async () => {
    const { getByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(TWENTY_MINUTES_MS);

    const banner = getByTestId('writing-session-banner');
    await within(banner).findByTestId('link-habit-nudge');
    expect(within(banner).getByTestId('link-habit-nudge-settings')).toBeTruthy();
    expect(within(banner).getByLabelText("Don't show this note again")).toBeTruthy();
    expect(queryByTestId('save-as-habit-offer')).toBeNull();
  });

  it('never makes the keep-this offer on a quick-launched page, even unanswered', async () => {
    const { findByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(TWENTY_MINUTES_MS);
    await findByTestId('link-habit-nudge');

    expect(queryByTestId('save-as-habit-offer')).toBeNull();
    expect(queryByTestId('save-as-habit-accept')).toBeNull();
  });

  it('shows the note on an ordinary page once the offer has been answered', async () => {
    await saveWritingOfferAnswered(true);
    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);

    await within(getByTestId('writing-session-banner')).findByTestId('link-habit-nudge');
    expect(queryByTestId('save-as-habit-offer')).toBeNull();
  });

  it('lets the unanswered offer have the note to itself on an ordinary page', async () => {
    const { getByTestId, findByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);

    await findByTestId('save-as-habit-offer');
    await settle(0);
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('does not swap a declined offer for the note in the same note, only in the next', async () => {
    const { getByTestId, findByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);
    fireEvent.press(await findByTestId('save-as-habit-decline'));
    // Long enough for any re-read of the offer's flag to land: there must be none.
    await settle(1_000);

    expect(queryByTestId('save-as-habit-offer')).toBeNull();
    expect(queryByTestId('link-habit-nudge')).toBeNull();

    startAnotherSession(getByTestId);
    await settle(TWENTY_MINUTES_MS);

    await within(getByTestId('writing-session-banner')).findByTestId('link-habit-nudge');
  });

  it('shows nothing when a habit is linked, even though the note was never declined', async () => {
    useWritingHabitLinkStore.setState({ habitId: LINKED_HABIT_ID, hydrated: true });
    const { getByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(TWENTY_MINUTES_MS);
    await settle(0);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('shows nothing while the link is unknown: a failed read is not "unlinked"', async () => {
    useWritingHabitLinkStore.setState({ habitId: null, hydrated: false });
    const { getByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(TWENTY_MINUTES_MS);
    await settle(0);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('shows nothing to a writer who stopped early, because no note is left', async () => {
    const { getByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(60_000);
    fireEvent.press(getByTestId('writing-timer-stop'));
    await settle(0);

    expect(queryByTestId('writing-session-banner')).toBeNull();
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('opens Settings on the writing-habit row', async () => {
    const { findByTestId } = renderScreen({ writingSession: LAUNCH });

    await settle(TWENTY_MINUTES_MS);
    fireEvent.press(await findByTestId('link-habit-nudge-settings'));

    expect(mockRootNavigate).toHaveBeenCalledWith('Settings', { focus: 'writing-habit' });
  });

  it("stays gone after Don't show again, on a later session and a later page", async () => {
    const first = renderScreen({ writingSession: LAUNCH });
    await settle(TWENTY_MINUTES_MS);
    fireEvent.press(await first.findByTestId('link-habit-nudge-decline'));

    expect(first.queryByTestId('link-habit-nudge')).toBeNull();
    first.unmount();

    await saveWritingOfferAnswered(true);
    const second = renderScreen();
    fireEvent.press(second.getByTestId('writing-timer-start'));
    await settle(TWENTY_MINUTES_MS);
    await settle(0);

    expect(second.getByTestId('writing-session-banner')).toBeTruthy();
    expect(second.queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('is absent on the next session once a habit has been linked', async () => {
    const { getByTestId, findByTestId, queryByTestId } = renderScreen({ writingSession: LAUNCH });
    await settle(TWENTY_MINUTES_MS);
    await findByTestId('link-habit-nudge');

    act(() => {
      useWritingHabitLinkStore.setState({ habitId: LINKED_HABIT_ID, hydrated: true });
    });
    expect(queryByTestId('link-habit-nudge')).toBeNull();

    startAnotherSession(getByTestId);
    await settle(TWENTY_MINUTES_MS);
    await settle(0);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });
});
