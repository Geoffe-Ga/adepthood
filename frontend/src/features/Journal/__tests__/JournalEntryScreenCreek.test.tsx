/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage, ResonanceResponse } from '@/api';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;

jest.mock('@/api', () => ({
  journal: {
    get: (...args: unknown[]) => (mockGet as unknown as (...values: unknown[]) => unknown)(...args),
    create: jest.fn(),
    update: jest.fn(),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...args: unknown[]) =>
      (mockList as unknown as (...values: unknown[]) => unknown)(...args),
    generate: (...args: unknown[]) =>
      (mockGenerate as unknown as (...values: unknown[]) => unknown)(...args),
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

function entry(): JournalMessage {
  return {
    id: 7,
    message: "The river returned in this morning's pages.",
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform',
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'finished',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

function payload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 50,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function renderScreen() {
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(
    <Screen
      route={{ key: 'k', name: 'JournalEntry', params: { entryId: 7 } }}
      navigation={{ navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() }}
      autosaveDelayMs={100}
    />,
  );
}

async function runPass(response: ResonanceResponse) {
  mockGet.mockResolvedValue(entry());
  mockGenerate.mockResolvedValue(response);
  const view = renderScreen();
  await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
  fireEvent.press(view.getByTestId('get-resonance-button'));
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledWith(7));
  return view;
}

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
  mockGenerate.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

describe('JournalEntryScreen — related Creek pages', () => {
  it('renders the display-only Creek band as a screen-level sibling after resonance', async () => {
    const view = await runPass(
      payload({
        related_praxis: [
          {
            title: 'Morning pages',
            praxis_type: 'practice',
            status: 'released',
            excerpt: 'Three quiet pages before the day begins.',
          },
        ],
        related_eddies: [
          {
            title: 'Returning to water',
            description: 'Images of rivers and rain gather around this thread.',
            fragment_count: 12,
            formed: '2026-03-04',
          },
        ],
      }),
    );

    const band = await view.findByTestId('from-your-creek');
    expect(within(view.getByTestId('journal-page')).queryByTestId('from-your-creek')).toBeNull();
    expect(
      within(view.getByTestId('journal-margin-column')).queryByTestId('from-your-creek'),
    ).toBeNull();
    expect(band).toBeTruthy();

    fireEvent.press(view.getByTestId('from-your-creek-toggle'));
    expect(view.getByText('Morning pages')).toBeTruthy();
    expect(view.getByText('Returning to water')).toBeTruthy();
    expect(view.queryByRole('checkbox')).toBeNull();
  });

  it.each([
    ['explicitly empty', payload({ related_praxis: [], related_eddies: [] })],
    ['legacy absent', payload()],
  ])('renders no Creek band when related pages are %s', async (_label, response) => {
    const view = await runPass(response);

    expect(view.queryByTestId('from-your-creek')).toBeNull();
  });
});
