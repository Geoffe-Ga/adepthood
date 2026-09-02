/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

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

function renderScreen(params?: { entryId?: number }) {
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
