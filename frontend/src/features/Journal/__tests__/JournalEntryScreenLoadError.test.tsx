/* eslint-env jest */
// Exact banner copy the implementer must use verbatim for testID
// 'journal-load-error':
// "We couldn't open this entry. Check your connection and try again —
// your existing writing is safe."
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

const JournalEntryScreen = require('../JournalEntryScreen').default;

// The exact copy the load-error banner must render (substring-matched below so
// minor punctuation drift doesn't over-couple the test to the implementation).
const LOAD_ERROR_WHAT = "couldn't open this entry";
const LOAD_ERROR_SAFE_REASSURANCE = 'existing writing is safe';

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

function renderScreen(params?: { entryId?: number }, extraProps?: { autosaveDelayMs?: number }) {
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

describe('JournalEntryScreen load error', () => {
  it('shows a warm inline banner when loading an existing entry fails', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const { findByTestId } = renderScreen({ entryId: 7 });
    const banner = await findByTestId('journal-load-error');
    expect(banner.props.children).toContain(LOAD_ERROR_WHAT);
    expect(banner.props.children).toContain(LOAD_ERROR_SAFE_REASSURANCE);
  });

  it('does not show the banner and loads normally when the fetch succeeds', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, title: 'Rivers', message: 'An existing page.' }));
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => {
      expect(getByTestId('journal-title-input').props.value).toBe('Rivers');
    });
    expect(queryByTestId('journal-load-error')).toBeNull();
  });

  it('does not fire the load path or the banner for a fresh entry with no id', async () => {
    const { queryByTestId } = renderScreen();
    await waitFor(() => {
      expect(mockGet).not.toHaveBeenCalled();
    });
    expect(queryByTestId('journal-load-error')).toBeNull();
  });

  it('never overwrites the real entry when its load failed and the user types', async () => {
    // The core anti-overwrite guarantee: after a failed load the editor is blank
    // but still bound to the real entry id, so an autosave here would clobber the
    // stored entry. Typing then waiting past the debounce must NOT call update.
    jest.useFakeTimers();
    try {
      mockGet.mockRejectedValue(new Error('network down'));
      const { getByTestId, findByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await findByTestId('journal-load-error');
      fireEvent.changeText(getByTestId('journal-body-input'), 'A blank editor draft.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
