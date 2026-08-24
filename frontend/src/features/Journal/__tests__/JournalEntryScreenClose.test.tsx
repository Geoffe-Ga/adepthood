/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

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
    message: 'An existing page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

interface ReturnToCourse {
  screen: 'Course';
  params: { stageNumber?: number; contentId: number; scrollOffset: number };
}

const RETURN_TO: ReturnToCourse = {
  screen: 'Course',
  params: { stageNumber: 2, contentId: 17, scrollOffset: 480 },
};

function renderScreen(
  params?: { entryId?: number; returnTo?: ReturnToCourse },
  extraProps: Record<string, unknown> = {},
) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
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
});

// ---------------------------------------------------------------------------
// An exit that does not depend on where the writer came from
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — always-available close', () => {
  it('renders a close control on the ordinary path (no returnTo)', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('journal-close-entry')).toBeTruthy();
  });

  it('names the control for assistive tech', () => {
    const { getByTestId } = renderScreen();
    const close = getByTestId('journal-close-entry');
    expect(close.props.accessibilityRole).toBe('button');
    expect(typeof close.props.accessibilityLabel).toBe('string');
    expect(close.props.accessibilityLabel.length).toBeGreaterThan(0);
  });

  it('returns the writer to the Journal shelf', () => {
    const { getByTestId, navigation } = renderScreen();
    fireEvent.press(getByTestId('journal-close-entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });

  it('still renders when the writer arrived from the course reader', () => {
    const { getByTestId } = renderScreen({ returnTo: RETURN_TO });
    expect(getByTestId('journal-close-entry')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The autosave contract: fired, not awaited
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — closing flushes the pending draft', () => {
  it('persists the typed draft after the close navigates away', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A thought worth keeping.');
      fireEvent.press(getByTestId('journal-close-entry'));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'A thought worth keeping.' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('navigates immediately rather than waiting on the write to resolve', () => {
    // ``create`` never settles here: a close that awaited the flush would leave
    // the writer stranded on the page it is meant to let them leave.
    mockCreate.mockImplementation(() => new Promise<JournalMessage>(() => {}));
    const { getByTestId, navigation } = renderScreen(undefined, { autosaveDelayMs: 100 });
    fireEvent.changeText(getByTestId('journal-body-input'), 'A thought mid-flight.');
    fireEvent.press(getByTestId('journal-close-entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });
});

// ---------------------------------------------------------------------------
// The course-return path is a separate affordance and must not regress
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — Back to reading is unchanged', () => {
  it('still shows beside the close control and still returns to the Course content', () => {
    const { getByTestId, navigation } = renderScreen({ returnTo: RETURN_TO });
    expect(getByTestId('journal-return-to-reading')).toBeTruthy();
    fireEvent.press(getByTestId('journal-return-to-reading'));
    expect(navigation.navigate).toHaveBeenCalledWith(
      'Tabs',
      expect.objectContaining({
        screen: 'Course',
        params: { stageNumber: 2, contentId: 17, scrollOffset: 480 },
      }),
    );
  });

  it('stays absent on the ordinary path', () => {
    const { queryByTestId } = renderScreen();
    expect(queryByTestId('journal-return-to-reading')).toBeNull();
  });
});
