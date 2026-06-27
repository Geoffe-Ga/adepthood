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

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: jest.fn(),
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

describe('JournalEntryScreen', () => {
  it('renders the title + body inputs and no chat UI', () => {
    const { getByTestId, queryByText } = renderScreen();
    expect(getByTestId('journal-title-input')).toBeTruthy();
    expect(getByTestId('journal-body-input')).toBeTruthy();
    // No chat affordances on the writing surface.
    expect(queryByText('Send')).toBeNull();
  });

  it('shows no count indicator on a fresh entry with no notes', () => {
    const { queryByTestId } = renderScreen();
    expect(queryByTestId('journal-margin-count')).toBeNull();
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

  it('shows a distinct error hint when a save fails', async () => {
    mockCreate.mockRejectedValue(new Error('network'));
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A thought.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(getByTestId('journal-save-hint').props.children).toMatch(/save/i);
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

  function noteRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 50,
      journal_entry_id: 7,
      kind: 'theme',
      anchor_start: 2,
      anchor_end: 8,
      anchor_text: 'walked',
      note: 'You keep moving.',
      essay: null,
      essay_generated_at: null,
      status: 'active',
      created_at: '',
      updated_at: '',
      ...overrides,
    };
  }

  it('renders read-mode highlights + margin notes for a finished entry', async () => {
    mockGet.mockResolvedValue(
      entry({ id: 7, message: 'I walked by the river.', status: 'finished' }),
    );
    mockList.mockResolvedValue({ items: [noteRow()] });
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    expect(await findByTestId('margin-note-50')).toBeTruthy();
    expect(queryByTestId('journal-body-read')).not.toBeNull();
    expect(queryByTestId('highlight-50')).not.toBeNull();
    // Read mode replaces the editable body.
    expect(queryByTestId('journal-body-input')).toBeNull();
  });

  it('loads an existing draft by id (editable)', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, title: 'Rivers', message: 'An existing page.' }));
    const { getByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => {
      expect(getByTestId('journal-title-input').props.value).toBe('Rivers');
    });
    expect(mockGet).toHaveBeenCalledWith(7);
    expect(getByTestId('journal-body-input').props.value).toBe('An existing page.');
  });

  describe('edit gate (finished entries)', () => {
    async function renderFinished() {
      mockGet.mockResolvedValue(entry({ id: 7, message: 'I walked.', status: 'finished' }));
      mockList.mockResolvedValue({ items: [] });
      const view = renderScreen({ entryId: 7 });
      await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
      return view;
    }

    it('opens the confirm dialog when editing a finished entry', async () => {
      const { getByTestId, queryByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      expect(queryByTestId('edit-confirm-dialog')).not.toBeNull();
      // Still locked — body not editable yet.
      expect(queryByTestId('journal-body-input')).toBeNull();
    });

    it('Edit unlocks the editable body', async () => {
      const { getByTestId, findByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-edit'));
      expect(await findByTestId('journal-body-input')).toBeTruthy();
    });

    it('Start new navigates to a blank JournalEntry', async () => {
      const { getByTestId, navigation } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-start-new'));
      expect(navigation.push).toHaveBeenCalledWith('JournalEntry');
    });

    it('Cancel keeps the entry locked', async () => {
      const { getByTestId, queryByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-cancel'));
      expect(queryByTestId('journal-body-input')).toBeNull();
      expect(queryByTestId('edit-confirm-dialog')).toBeNull();
    });

    it('re-fetches marginalia after the first save following an edit', async () => {
      jest.useFakeTimers();
      try {
        mockGet.mockResolvedValue(entry({ id: 7, message: 'I walked.', status: 'finished' }));
        mockList.mockResolvedValue({ items: [] });
        const { getByTestId, findByTestId } = renderScreen(
          { entryId: 7 },
          { autosaveDelayMs: 100 },
        );
        await act(async () => {
          await Promise.resolve();
        });
        fireEvent.press(getByTestId('journal-edit-button'));
        fireEvent.press(getByTestId('edit-confirm-edit'));
        const input = await findByTestId('journal-body-input');
        mockList.mockClear();
        fireEvent.changeText(input, 'I strolled instead.');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(100);
        });
        expect(mockUpdate).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ message: 'I strolled instead.' }),
        );
        expect(mockList).toHaveBeenCalledWith(7); // re-read after the edit-save
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('marks a draft finished via the Finish control', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A finished thought.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      mockUpdate.mockClear();
      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockUpdate).toHaveBeenCalledWith(42, { status: 'finished' });
      // Returns to read mode.
      expect(await findByTestId('journal-edit-button')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
