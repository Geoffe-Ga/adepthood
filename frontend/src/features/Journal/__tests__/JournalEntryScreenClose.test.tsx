/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockRespond = jest.fn() as jest.MockedFunction<
  (_week: number, _body: string, _options?: unknown) => Promise<unknown>
>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

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

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

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
  params?: {
    entryId?: number;
    returnTo?: ReturnToCourse;
    weekNumber?: number;
    promptQuestion?: string;
    prefillTitle?: string;
  },
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
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
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

  it('returns an empty draft to the Journal shelf', async () => {
    const { getByTestId, navigation } = renderScreen();
    await act(async () => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });

  it('still renders when the writer arrived from the course reader', () => {
    const { getByTestId } = renderScreen({ returnTo: RETURN_TO });
    expect(getByTestId('journal-close-entry')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The close contract: the final save settles before the shelf is allowed to read
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — closing flushes the pending draft', () => {
  it('does not navigate until the first save has persisted', async () => {
    let resolveCreate: (_entry: JournalMessage) => void = () => undefined;
    mockCreate.mockImplementation(
      () =>
        new Promise<JournalMessage>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { getByTestId, navigation } = renderScreen(undefined, { autosaveDelayMs: 100 });
    fireEvent.changeText(getByTestId('journal-body-input'), 'A thought worth keeping.');

    act(() => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A thought worth keeping.' }),
    );
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate(entry({ id: 42, message: 'A thought worth keeping.' }));
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });

  it('keeps the writer on the page with the save error when the final write fails', async () => {
    mockCreate.mockRejectedValue(new Error('offline'));
    const { getByTestId, navigation } = renderScreen(undefined, { autosaveDelayMs: 100 });
    fireEvent.changeText(getByTestId('journal-body-input'), 'A thought that is still safe here.');

    await act(async () => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(getByTestId('journal-save-hint').props.children).toMatch(/couldn't save/i);
    expect(getByTestId('journal-save-retry')).toBeTruthy();
  });

  it('closes after a weekly-prompt response persists even though that endpoint returns no entry id', async () => {
    const { getByTestId, navigation } = renderScreen(
      {
        weekNumber: 3,
        promptQuestion: 'What did you notice?',
        prefillTitle: 'Week 3 Reflection',
      },
      { autosaveDelayMs: 100 },
    );
    fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');

    await act(async () => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });

    expect(mockRespond).toHaveBeenCalledWith(3, 'I noticed the willow.', {
      title: 'Week 3 Reflection',
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });

  it('does not call a second weekly edit Saved or close over text the server refused to store', async () => {
    jest.useFakeTimers();
    try {
      let resolveRespond: (_value: unknown) => void = () => undefined;
      mockRespond.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRespond = resolve;
          }),
      );
      const { getByTestId, navigation } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'The first durable answer.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      fireEvent.changeText(
        getByTestId('journal-body-input'),
        'A later edit the one-response endpoint cannot store.',
      );
      await act(async () => {
        resolveRespond({});
      });

      await act(async () => {
        fireEvent.press(getByTestId('journal-close-entry'));
      });

      expect(mockRespond).toHaveBeenCalledTimes(1);
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(getByTestId('journal-save-hint').props.children).toMatch(/already answered/i);
      expect(getByTestId('journal-save-hint').props.children).not.toBe('Saved');
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes a loaded finished entry without making its durable text depend on another PATCH', async () => {
    mockGet.mockResolvedValue(entry({ status: 'finished' }));
    mockUpdate.mockRejectedValue(new Error('offline'));
    const { getByTestId, navigation } = renderScreen({ entryId: 7 });
    await waitFor(() => expect(getByTestId('journal-edit-button')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
  });

  it('does not repeat an already successful autosave just to close', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, navigation } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'Already safe on the shelf.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      mockUpdate.mockRejectedValue(new Error('offline'));

      await act(async () => {
        fireEvent.press(getByTestId('journal-close-entry'));
      });

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(navigation.navigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not announce an older save as Saved while newer text is still pending', async () => {
    jest.useFakeTimers();
    try {
      let resolveCreate: (_entry: JournalMessage) => void = () => undefined;
      mockCreate.mockImplementation(
        () =>
          new Promise<JournalMessage>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'Older text.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'Newer text is still pending.');

      await act(async () => {
        resolveCreate(entry({ id: 42, message: 'Older text.' }));
      });

      expect(getByTestId('journal-save-hint').props.children).not.toBe('Saved');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalledWith(42, {
        message: 'Newer text is still pending.',
        title: null,
      });
      expect(getByTestId('journal-save-hint').props.children).toBe('Saved');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps flushing text typed after X until the newest body is durable', async () => {
    let resolveCreate: (_entry: JournalMessage) => void = () => undefined;
    let resolveUpdate: (_entry: JournalMessage) => void = () => undefined;
    mockCreate.mockImplementation(
      () =>
        new Promise<JournalMessage>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mockUpdate.mockImplementation(
      () =>
        new Promise<JournalMessage>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { getByTestId, navigation } = renderScreen(undefined, { autosaveDelayMs: 100 });
    fireEvent.changeText(getByTestId('journal-body-input'), 'The body when X was pressed.');
    act(() => {
      fireEvent.press(getByTestId('journal-close-entry'));
    });
    fireEvent.changeText(getByTestId('journal-body-input'), 'Newer text typed while X waits.');

    await act(async () => {
      resolveCreate(entry({ id: 42, message: 'The body when X was pressed.' }));
    });
    expect(mockUpdate).toHaveBeenCalledWith(42, {
      message: 'Newer text typed while X waits.',
      title: null,
    });
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdate(entry({ id: 42, message: 'Newer text typed while X waits.' }));
    });
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
