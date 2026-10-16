/* eslint-env jest */
/**
 * #3374: the mounted Return surface (real ``useMettaReturn`` + real
 * ``ReturnLetGoCard``) keeps the post-start let-go choice open, selection
 * intact, across a same-account token renewal, and still closes it on a
 * genuine session teardown.
 */
import { jest, beforeEach, it, expect } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ApiHabitWithGoals, MettaReturnState, ReturnArc } from '@/api';
import type * as UserScope from '@/storage/userScope';

let mockOwner: number | null = 1;
let mockEpoch = 1;
let mockToken: string | null = 'account-1';
const mockState = jest.fn<(..._args: unknown[]) => Promise<MettaReturnState>>();
const mockStart = jest.fn<(..._args: unknown[]) => Promise<ReturnArc>>();
const mockRelease = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockListAll = jest.fn<() => Promise<ApiHabitWithGoals[]>>();

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: mockToken,
    authStatus: mockToken === null ? 'anonymous' : 'authenticated',
  }),
}));
jest.mock('@/utils/token', () => ({
  decodeJwtPayload: (token: string) =>
    token.startsWith('account-') ? { sub: token.slice('account-'.length).split(':')[0] } : null,
}));
jest.mock('@/storage/userScope', () => ({
  ...jest.requireActual<typeof UserScope>('@/storage/userScope'),
  getActiveUser: () => mockOwner,
  getActiveUserGeneration: () => mockEpoch,
  // The session-lineage fence (#3452) asks the account scope through this predicate.
  isAccountScopeCurrent: (owner: number | null, generation: number) =>
    !jest.requireActual<typeof UserScope>('@/storage/userScope').isActiveUserTransitioning() &&
    owner === mockOwner &&
    generation === mockEpoch,
}));
jest.mock('@/storage/useActiveUser', () => ({
  useActiveUser: () => mockOwner,
  useActiveUserGeneration: () => mockEpoch,
}));
jest.mock('@/storage/returnOfferStorage', () => ({
  loadReturnOfferDismissed: async () => false,
  saveReturnOfferDismissed: async () => undefined,
}));
jest.mock('@/api', () => ({
  mettaReturn: {
    state: (...args: unknown[]) => mockState(...args),
    start: (...args: unknown[]) => mockStart(...args),
    release: (...args: unknown[]) => mockRelease(...args),
  },
  habits: { listAll: () => mockListAll() },
}));
jest.mock('../contractionSignal', () => ({ useContractionSignalActive: () => true }));

const ReturnStack = require('../ReturnStack').default;

const ARC: ReturnArc = {
  started_at: '2026-10-14T00:00:00Z',
  paused: false,
  week: 1,
  focus: 'self',
  complete: false,
};

const OFFER: MettaReturnState = {
  eligible: true,
  weeks: [],
  arc: null,
  offer_episode: 'episode-A',
  offer_dismissed: false,
  released_habits: [],
};

function habit(id: number, name: string): ApiHabitWithGoals {
  return {
    id,
    name,
    icon: '📓',
    start_date: '2026-01-01',
    energy_cost: 1,
    energy_return: 2,
    milestone_notifications: false,
    stage: 'aptitude',
    streak: 3,
    revealed: true,
    goals: [],
  };
}

beforeEach(() => {
  mockOwner = 1;
  mockEpoch = 1;
  mockToken = 'account-1';
  mockState.mockReset().mockResolvedValue(OFFER);
  mockStart.mockReset().mockResolvedValue(ARC);
  mockRelease.mockReset().mockResolvedValue([]);
  mockListAll.mockReset().mockResolvedValue([habit(1, 'Morning pages'), habit(2, 'Evening walk')]);
});

async function renderMidChoice() {
  const view = render(<ReturnStack />);
  await waitFor(() => expect(view.getByTestId('return-offer-accept')).toBeTruthy());
  mockState.mockResolvedValue({ ...OFFER, arc: ARC });
  await act(async () => fireEvent.press(view.getByTestId('return-offer-accept')));
  await waitFor(() => expect(view.getByTestId('return-letgo-habit-2')).toBeTruthy());
  fireEvent.press(view.getByTestId('return-letgo-habit-2'));
  return view;
}

it('keeps the let-go card and its in-progress selection across a same-account renewal', async () => {
  const view = await renderMidChoice();
  mockToken = 'account-1:renewed';
  view.rerender(<ReturnStack />);
  await act(async () => Promise.resolve());
  // A renewal keeps the session lineage (#3452): the observed state stands, unreread.
  expect(mockState).not.toHaveBeenCalledWith('account-1:renewed');
  expect(view.getByTestId('return-letgo-card')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByTestId('return-letgo-release')));
  expect(mockRelease).toHaveBeenCalledWith([2], 'account-1:renewed');
  await waitFor(() => expect(view.getByTestId('return-arc-card')).toBeTruthy());
  expect(view.queryByTestId('return-letgo-card')).toBeNull();
});

it('lets the person keep them all after a same-account renewal', async () => {
  const view = await renderMidChoice();
  mockToken = 'account-1:renewed';
  view.rerender(<ReturnStack />);
  await act(async () => Promise.resolve());
  // A renewal keeps the session lineage (#3452): the observed state stands, unreread.
  expect(mockState).not.toHaveBeenCalledWith('account-1:renewed');
  fireEvent.press(view.getByTestId('return-letgo-skip'));
  expect(view.getByTestId('return-arc-card')).toBeTruthy();
  expect(mockRelease).not.toHaveBeenCalled();
});

it('closes the let-go card on a genuine session teardown', async () => {
  const view = await renderMidChoice();
  mockToken = null;
  mockOwner = null;
  mockEpoch += 1;
  view.rerender(<ReturnStack />);
  expect(view.queryByTestId('return-letgo-card')).toBeNull();
  mockToken = 'account-1:next-session';
  mockOwner = 1;
  mockEpoch += 1;
  view.rerender(<ReturnStack />);
  await waitFor(() => expect(view.getByTestId('return-arc-card')).toBeTruthy());
  expect(view.queryByTestId('return-letgo-card')).toBeNull();
});
