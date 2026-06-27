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

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
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

function renderScreen(params?: { entryId?: number }, extraProps: Record<string, unknown> = {}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} {...extraProps} />);
}

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
});

describe('JournalEntryScreen', () => {
  it('renders the title + body inputs and no chat UI', () => {
    const { getByTestId, queryByText } = renderScreen();
    expect(getByTestId('journal-title-input')).toBeTruthy();
    expect(getByTestId('journal-body-input')).toBeTruthy();
    // No chat affordances on the writing surface.
    expect(queryByText('Send')).toBeNull();
  });

  it('reserves a margin column and renders the renderMargin slot', () => {
    const renderMargin = jest.fn(() => null);
    const { getByTestId } = renderScreen(undefined, { renderMargin });
    expect(getByTestId('journal-margin-column')).toBeTruthy();
    expect(renderMargin).toHaveBeenCalled();
  });

  it('autosaves once after the debounce when the body changes', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 1500 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A new thought.');
      expect(mockCreate).not.toHaveBeenCalled(); // still within the debounce window
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith({ message: 'A new thought.' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('updates (not creates again) on the second save after the initial create', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First save.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);

      fireEvent.changeText(getByTestId('journal-body-input'), 'Second save.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1); // create not repeated
      expect(mockUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ message: 'Second save.' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not persist an empty draft', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 1500 });
      fireEvent.changeText(getByTestId('journal-body-input'), '   ');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('loads an existing entry by id', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, title: 'Rivers', message: 'An existing page.' }));
    const { getByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => {
      expect(getByTestId('journal-title-input').props.value).toBe('Rivers');
    });
    expect(mockGet).toHaveBeenCalledWith(7);
    expect(getByTestId('journal-body-input').props.value).toBe('An existing page.');
  });
});
