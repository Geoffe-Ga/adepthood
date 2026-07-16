/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

/**
 * Covers the JournalEntryScreen care-surface placement:
 * - When a resonance pass yields ``care``, ``CareSupportNote`` (testID
 *   ``"care-support"``) mounts at the SCREEN level — a direct sibling of
 *   ``JournalPage`` inside ``journal-screen``, NOT anywhere inside
 *   ``journal-margin-column`` or ``journal-sheet``.
 * - On an ordinary pass (no care), ``care-support`` is absent entirely.
 */
import type { CareResponse, JournalMessage, ResonanceResponse } from '@/api';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';

// ---------------------------------------------------------------------------
// API mocks — mirrors the shape in JournalEntryScreen.test.tsx exactly.
// ---------------------------------------------------------------------------

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;

const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
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
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'Today felt very dark.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'A heavy day',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function carePayload(): CareResponse {
  return {
    message: 'What you shared sounds heavy. Here are some people who can help right now.',
    resources: [
      {
        kind: 'hotline',
        name: '988 Suicide & Crisis Lifeline',
        contact: '988',
        what_it_is: 'Free, confidential crisis support — call or text anytime.',
      },
    ],
  };
}

function resonancePayload(care: CareResponse | null = null): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    care,
  };
}

function renderScreen(
  params?: {
    entryId?: number;
    weekNumber?: number;
    promptQuestion?: string;
    prefillTitle?: string;
    practiceSessionId?: number;
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockGenerate.mockReset();
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Placement tests
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — care-support surface placement (issue #891)', () => {
  it('does NOT render care-support on an ordinary resonance pass (no care)', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload(null));

      const { getByTestId, queryByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.changeText(getByTestId('journal-body-input'), 'A peaceful thought.');
      // Advance autosave debounce: create fires, entry gets id=42.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Advance idle timer: isIdle flips true, visible=true, button is findable.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      // Trigger the resonance generate pass.
      await act(async () => {
        fireEvent.press(getByTestId('get-resonance-button'));
        await Promise.resolve();
      });

      expect(queryByTestId('care-support')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('mounts care-support when the resonance pass returns care', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload(carePayload()));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.changeText(getByTestId('journal-body-input'), 'Today felt very dark.');
      // Advance autosave debounce: create fires, entry gets id=42.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Advance idle timer: isIdle flips true, visible=true, button is findable.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      await act(async () => {
        fireEvent.press(getByTestId('get-resonance-button'));
        await Promise.resolve();
      });

      await waitFor(() => expect(getByTestId('care-support')).toBeTruthy());
    } finally {
      jest.useRealTimers();
    }
  });

  it('care-support is a child of journal-screen, NOT of journal-margin-column', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload(carePayload()));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.changeText(getByTestId('journal-body-input'), 'Today felt very dark.');
      // Advance autosave debounce: create fires, entry gets id=42.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Advance idle timer: isIdle flips true, visible=true, button is findable.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      await act(async () => {
        fireEvent.press(getByTestId('get-resonance-button'));
        await Promise.resolve();
      });

      await waitFor(() => expect(getByTestId('care-support')).toBeTruthy());

      // The margin column must NOT contain care-support.
      expect(within(getByTestId('journal-margin-column')).queryByTestId('care-support')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('care-support is NOT a descendant of journal-sheet or journal-page', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload(carePayload()));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.changeText(getByTestId('journal-body-input'), 'Today felt very dark.');
      // Advance autosave debounce: create fires, entry gets id=42.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Advance idle timer: isIdle flips true, visible=true, button is findable.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      await act(async () => {
        fireEvent.press(getByTestId('get-resonance-button'));
        await Promise.resolve();
      });

      await waitFor(() => expect(getByTestId('care-support')).toBeTruthy());

      // Confirm care-support is NOT inside journal-sheet or journal-page.
      expect(within(getByTestId('journal-sheet')).queryByTestId('care-support')).toBeNull();
      expect(within(getByTestId('journal-page')).queryByTestId('care-support')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
