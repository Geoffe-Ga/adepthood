/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * RED tests for the JournalEntryScreen contraction-reflection surface.
 *
 * Requirements:
 * - A resonance pass returning ``contraction`` mounts
 *   ``ContractionReflectionNote`` (testID ``"contraction-reflection"``).
 * - An ordinary pass (no contraction) renders nothing for it.
 * - The care surface and the contraction surface can coexist on one pass.
 *
 * These tests fail until the implementation-specialist wires ``contraction``
 * from ``useResonance`` into ``JournalEntryScreen``.
 */
import type { CareResponse, ContractionReflection, JournalMessage, ResonanceResponse } from '@/api';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';

// ---------------------------------------------------------------------------
// API mocks — mirrors the shape in JournalEntryScreenCare.test.tsx exactly.
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
    message: 'Today felt quiet.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'A quiet day',
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

function contractionPayload(overrides: Partial<ContractionReflection> = {}): ContractionReflection {
  return {
    variant: 'simple_ease_off',
    message: 'Your practice has eased off a little. No rush back.',
    ...overrides,
  };
}

function resonancePayload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    care: null,
    contraction: null,
    ...overrides,
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

interface ScreenQueries {
  getByTestId: (_id: string) => { props: Record<string, unknown> };
}

async function triggerResonancePass(screen: ScreenQueries): Promise<void> {
  fireEvent.changeText(screen.getByTestId('journal-body-input'), 'Today felt quiet.');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(100);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('get-resonance-button'));
    await Promise.resolve();
  });
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
// Tests
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — contraction-reflection surface', () => {
  it('renders contraction-reflection when the resonance pass returns a contraction', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload({ contraction: contractionPayload() }));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      await triggerResonancePass({ getByTestId });

      await waitFor(() => expect(getByTestId('contraction-reflection')).toBeTruthy());
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders nothing for contraction-reflection on an ordinary pass', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload());

      const { getByTestId, queryByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      await triggerResonancePass({ getByTestId });

      expect(queryByTestId('contraction-reflection')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders both care-support and contraction-reflection when a pass returns both', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(
        resonancePayload({ care: carePayload(), contraction: contractionPayload() }),
      );

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      await triggerResonancePass({ getByTestId });

      await waitFor(() => expect(getByTestId('care-support')).toBeTruthy());
      expect(getByTestId('contraction-reflection')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
