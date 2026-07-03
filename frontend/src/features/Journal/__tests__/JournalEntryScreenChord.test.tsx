/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

/**
 * Verifies the Aspect-chord PATCH-error wiring in ``JournalEntryScreen``: a
 * chord change on an existing entry is PATCHed immediately, and — mirroring the
 * privacy-tier control — a rejected PATCH surfaces the save-error hint and
 * reverts the optimistic chord selection to the persisted value, unless a later
 * change has superseded it.
 */
import type { JournalMessage } from '@/api';

// ---------------------------------------------------------------------------
// API mock — mirrors JournalEntryScreenPrivacy.test.tsx
// ---------------------------------------------------------------------------

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<unknown>>;
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

const JournalEntryScreen = require('../JournalEntryScreen').default;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

type EntryOverrides = Partial<JournalMessage> & {
  primary_aspect?: number | null;
  secondary_aspect?: number | null;
};

function entry(overrides: EntryOverrides = {}): JournalMessage {
  return {
    id: 7,
    message: 'A page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function renderScreen(params?: { entryId?: number }, extraProps: Record<string, unknown> = {}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} {...extraProps} />);
}

const ERROR_HINT = "Couldn't save — keep writing, we'll retry";

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
// Chord change — PATCH failure surfaces the error and reverts the selection
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — chord change PATCH failure', () => {
  it('surfaces the save-error hint and reverts the optimistic chord when the PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      // Untagged on load — the revert target is the persisted (empty) chord, so a
      // failed tag correctly falls back to "no chord", matching the ref's truth.
      mockGet.mockResolvedValue(entry({ id: 7, primary_aspect: null, secondary_aspect: null }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('aspect-chord-trigger'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-5'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(getByTestId('journal-save-hint').props.children).toBe(ERROR_HINT);
      // Reverted to the persisted (untagged) chord: the just-picked chip is cleared.
      expect(
        within(getByTestId('journal-page')).getByTestId('aspect-primary-5').props.accessibilityState
          .selected,
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reverts to the loaded (tagged) chord, not the empty default, when the PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      // Loaded with a primary Aspect — a failed re-tag must fall back to the
      // persisted chord (primary 3), not the empty default the ref started at.
      mockGet.mockResolvedValue(entry({ id: 7, primary_aspect: 3, secondary_aspect: null }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('aspect-chord-trigger'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-5'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(getByTestId('journal-save-hint').props.children).toBe(ERROR_HINT);
      const after = within(getByTestId('journal-page'));
      // Reverted to the persisted chord (primary 3), not the empty default.
      expect(after.getByTestId('aspect-primary-3').props.accessibilityState.selected).toBe(true);
      expect(after.getByTestId('aspect-primary-5').props.accessibilityState.selected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the new chord selected with no error hint when the PATCH succeeds', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, primary_aspect: null, secondary_aspect: null }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('aspect-chord-trigger'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-5'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUpdate).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ primary_aspect: 5, secondary_aspect: null }),
      );
      const after = within(getByTestId('journal-page'));
      expect(after.getByTestId('aspect-primary-5').props.accessibilityState.selected).toBe(true);
      expect(getByTestId('journal-save-hint').props.children).not.toBe(ERROR_HINT);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not revert a superseding chord change when the earlier PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, primary_aspect: null, secondary_aspect: null }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      // First PATCH (primary 5) rejects; the superseding one (primary 8) resolves.
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('aspect-chord-trigger'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-5'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-8'));

      await act(async () => {
        await Promise.resolve();
      });

      const after = within(getByTestId('journal-page'));
      expect(after.getByTestId('aspect-primary-8').props.accessibilityState.selected).toBe(true);
      expect(after.getByTestId('aspect-primary-5').props.accessibilityState.selected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Chord chosen before the entry exists — rides the first create, no PATCH yet
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — chord chosen before the first save', () => {
  it('creates with the chosen aspect chord when set before the first save', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('aspect-chord-trigger'));
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('aspect-primary-5'));

      fireEvent.changeText(getByTestId('journal-body-input'), 'An Aspect-tagged reflection.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ primary_aspect: 5, secondary_aspect: null }),
      );
      // No PATCH: the chord rode the create — there is no existing entry to update yet.
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
