/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage } from '@/api';

/**
 * The photograph-capture handoff: JournalEntryScreen opened with
 * ``{ entryId, justSaved: true }`` after JournalPhotographScreen finishes a
 * page. A finished, personal entry loaded this way must read as "Saved" and
 * offer resonance immediately, without the usual idle-after-typing wait.
 */
const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(),
  },
  prompts: {
    respond: jest.fn(),
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

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'A finished page about the river.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'finished',
    classification: 'personal',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function renderScreen(params: { entryId: number; justSaved?: boolean }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

describe('JournalEntryScreen — justSaved (photograph capture handoff)', () => {
  it('shows the "Saved" hint once a finished personal entry loads with justSaved', async () => {
    mockGet.mockResolvedValue(entry());
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7, justSaved: true });
    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());
    expect(getByTestId('journal-save-hint').props.children).toBe('Saved');
  });

  it('shows the resonance button visible and enabled for the same load', async () => {
    mockGet.mockResolvedValue(entry());
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7, justSaved: true });
    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());
    const btn = getByTestId('get-resonance-button');
    expect(btn.props.accessibilityState.disabled).toBe(false);
  });

  it('does not force the "Saved" hint when justSaved is absent (control)', async () => {
    mockGet.mockResolvedValue(entry());
    const { getByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => expect(queryByTestId('journal-edit-button')).not.toBeNull());
    expect(getByTestId('journal-save-hint').props.children).not.toBe('Saved');
  });
});
