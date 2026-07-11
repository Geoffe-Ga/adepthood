/* eslint-env jest */
// Pins the Journal "Finish" data-loss bug: a failed final write can silently flip status to 'finished' on top of a stale/shorter autosaved body.
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
const mockRespond = jest.fn() as jest.MockedFunction<(_w: number, _b: string) => Promise<unknown>>;

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
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

// Comfortably longer than the shelf's EXCERPT_MAX (140 chars) and multi-paragraph,
// so a truncation regression on the Finish write path is meaningful, not incidental.
const LONG_BODY = `The morning light moved slowly across the kitchen table, and something about it made me want to keep writing well past the point where I would usually stop for the day.

By the time the kettle finally whistled the thought had unspooled into something far longer than I expected, so I kept going anyway, filling the page with more than I meant to say.`;

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

function renderScreen(
  params?: { entryId?: number; weekNumber?: number; promptQuestion?: string },
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

describe('JournalEntryScreen Finish — atomic write', () => {
  it('persists the full body atomically with the status flip, not a status-only PATCH', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Isolate exactly what Finish itself writes.
      mockCreate.mockClear();
      mockUpdate.mockClear();

      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockCreate).not.toHaveBeenCalled();
      // Exactly one write carrying the full body, not a body PATCH plus a separate status-only PATCH.
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(42, {
        message: LONG_BODY,
        title: null,
        status: 'finished',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates with the full (untruncated) body when Finish is pressed before the autosave debounce fires', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 1500 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      // Press Finish immediately, well inside the 1500ms debounce window, so the entry has no id yet.
      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ message: LONG_BODY }));
      expect(mockUpdate).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'finished' }));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen Finish — failure is visible and safe', () => {
  it('does not flip status to finished when the write fails partway (the data-loss case)', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, queryByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      mockUpdate.mockReset();
      // First write (the one Finish issues) fails; any later write would succeed.
      mockUpdate.mockResolvedValue(entry({ id: 42, status: 'finished' }));
      mockUpdate.mockRejectedValueOnce(new Error('network down'));

      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Still in edit mode: body input present, read-mode Edit affordance absent.
      expect(getByTestId('journal-body-input')).toBeTruthy();
      expect(queryByTestId('journal-edit-button')).toBeNull();
      expect(queryByTestId('journal-finish-error')).not.toBeNull();
      // The control is re-enabled so a retry is possible.
      const btn = getByTestId('journal-finish-button');
      expect(btn.props.accessibilityState.disabled).toBeFalsy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a retry succeed after a failed Finish attempt', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      mockUpdate.mockReset();
      mockUpdate.mockResolvedValue(entry({ id: 42, status: 'finished' }));
      mockUpdate.mockRejectedValueOnce(new Error('network down'));

      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      // First attempt failed — still editable.
      expect(getByTestId('journal-body-input')).toBeTruthy();

      fireEvent.press(getByTestId('journal-finish-button'));
      expect(await findByTestId('journal-edit-button')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a retryable draft when Finish creates the entry but the status write fails', async () => {
    jest.useFakeTimers();
    try {
      // Long debounce so the entry has no id yet: Finish must create it, then flip status.
      const { getByTestId, queryByTestId, findByTestId } = renderScreen(undefined, {
        autosaveDelayMs: 1500,
      });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      mockUpdate.mockReset();
      mockUpdate.mockResolvedValue(entry({ id: 42, status: 'finished' }));
      mockUpdate.mockRejectedValueOnce(new Error('network down'));

      // First Finish: the create lands (full body saved as a draft), the status write fails.
      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(queryByTestId('journal-finish-error')).not.toBeNull();
      expect(getByTestId('journal-body-input')).toBeTruthy();

      // Retry takes the update branch (the id now exists) and succeeds — no second create.
      fireEvent.press(getByTestId('journal-finish-button'));
      expect(await findByTestId('journal-edit-button')).toBeTruthy();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never leaves an unhandled promise rejection when the finish write fails outright', async () => {
    // Cast through `unknown`: process is a real EventEmitter at runtime, but this project's tsconfig omits ambient Node types.
    const emitter = process as unknown as {
      on: (_event: 'unhandledRejection', _listener: (_reason: unknown) => void) => void;
      off: (_event: 'unhandledRejection', _listener: (_reason: unknown) => void) => void;
    };
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    emitter.on('unhandledRejection', onUnhandled);
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 0 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));

      mockUpdate.mockReset();
      mockUpdate.mockRejectedValue(new Error('network down'));

      fireEvent.press(getByTestId('journal-finish-button'));
      // Give the real event loop a couple of full turns so a rejection would surface.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
    } finally {
      emitter.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('JournalEntryScreen Finish — busy state', () => {
  it('marks the Finish control busy/disabled while the write is in flight and ignores a second press', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), LONG_BODY);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      mockUpdate.mockReset();
      mockUpdate.mockReturnValue(new Promise<JournalMessage>(() => {})); // never resolves

      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
      });

      const btn = getByTestId('journal-finish-button');
      expect(btn.props.accessibilityState.busy).toBe(true);
      expect(btn.props.accessibilityState.disabled).toBe(true);

      fireEvent.press(getByTestId('journal-finish-button')); // second press while busy
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUpdate).toHaveBeenCalledTimes(1); // no double-fire
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen Finish — prompt-compose has no Finish affordance', () => {
  it('does not render the Finish control when weekNumber is set (respond has no local id to finish)', () => {
    const { getByTestId, queryByTestId } = renderScreen({
      weekNumber: 3,
      promptQuestion: 'What did you notice?',
    });
    fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
    expect(queryByTestId('journal-finish-button')).toBeNull();
  });
});
