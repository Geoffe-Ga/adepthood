import { jest, beforeEach, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { MettaReturnState } from '@/api';
import type * as UserScope from '@/storage/userScope';

let mockOwner: number | null = 1;
let mockEpoch = 1;
let mockToken: string | null = 'account-1';
const mockState = jest.fn<(..._args: unknown[]) => Promise<MettaReturnState>>();
const mockDismiss = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockStart = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockRelease = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockLoad = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockSave = jest.fn<(..._args: unknown[]) => Promise<unknown>>();

jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: mockToken }) }));
jest.mock('@/utils/token', () => ({
  decodeJwtPayload: (token: string) =>
    token.startsWith('account-') ? { sub: token.slice('account-'.length) } : null,
}));
jest.mock('@/storage/userScope', () => ({
  ...jest.requireActual<typeof UserScope>('@/storage/userScope'),
  getActiveUser: () => mockOwner,
  getActiveUserGeneration: () => mockEpoch,
}));
// Controlled account transitions rerender the consumer; browser proof exercises the real subscription.
jest.mock('@/storage/useActiveUser', () => ({
  useActiveUser: () => mockOwner,
  useActiveUserGeneration: () => mockEpoch,
}));
jest.mock('@/storage/returnOfferStorage', () => ({
  loadReturnOfferDismissed: (...args: unknown[]) => mockLoad(...args),
  saveReturnOfferDismissed: (...args: unknown[]) => mockSave(...args),
}));
jest.mock('@/api', () => ({
  mettaReturn: {
    state: (...args: unknown[]) => mockState(...args),
    dismissOffer: (...args: unknown[]) => mockDismiss(...args),
    start: (...args: unknown[]) => mockStart(...args),
    release: (...args: unknown[]) => mockRelease(...args),
  },
}));
jest.mock('../contractionSignal', () => ({ useContractionSignalActive: () => true }));

const { useMettaReturn } = require('../useMettaReturn');

function state(episode = 'opaque-episode-A'): MettaReturnState {
  return {
    eligible: true,
    weeks: [],
    arc: null,
    offer_episode: episode,
    offer_dismissed: false,
    released_habits: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (_value: T) => void } {
  let resolve: (_value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockOwner = 1;
  mockEpoch = 1;
  mockToken = 'account-1';
  mockState.mockReset().mockResolvedValue(state());
  mockDismiss.mockReset().mockResolvedValue({ ...state(), offer_dismissed: true });
  mockStart.mockReset().mockResolvedValue(null);
  mockRelease.mockReset().mockResolvedValue([]);
  mockLoad.mockReset().mockResolvedValue(false);
  mockSave.mockReset().mockResolvedValue(undefined);
});

it('captures the observed episode, account and credential when declining', async () => {
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  await act(async () => result.current.dismissOffer());
  expect(mockDismiss).toHaveBeenCalledWith(
    { expected_offer_episode: 'opaque-episode-A' },
    'account-1',
  );
  expect(mockSave).toHaveBeenCalledWith({ userId: 1, episode: 'opaque-episode-A' }, true);
});

it('retries a durable same-episode choice without resurfacing the card', async () => {
  mockLoad.mockResolvedValue(true);
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(mockDismiss).toHaveBeenCalledTimes(1));
  expect(result.current.offerVisible).toBe(false);
  expect(mockLoad).toHaveBeenCalledWith({ userId: 1, episode: 'opaque-episode-A' });
  expect(mockDismiss).toHaveBeenCalledWith(
    { expected_offer_episode: 'opaque-episode-A' },
    'account-1',
  );
});

it('publishes a newer episode returned across the dismiss commit boundary', async () => {
  mockDismiss.mockResolvedValue(state('opaque-episode-B'));
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  await act(async () => result.current.dismissOffer());
  expect(result.current.offerVisible).toBe(true);
  expect(mockSave).not.toHaveBeenCalledWith({ userId: 1, episode: 'opaque-episode-B' }, true);
});

it('rejects a held first A read after A to B to A without an intermediate render', async () => {
  const first = deferred<MettaReturnState>();
  mockState.mockReturnValueOnce(first.promise).mockResolvedValue(state('current-A'));
  const { result, rerender } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
  mockOwner = 2;
  mockEpoch += 1;
  mockOwner = 1;
  mockEpoch += 1;
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  await act(async () => first.resolve({ ...state('obsolete-A'), offer_dismissed: true }));
  expect(result.current.offerVisible).toBe(true);
  expect(mockSave).not.toHaveBeenCalledWith({ userId: 1, episode: 'obsolete-A' }, true);
});

it('waits for a matching committed credential after the namespace changes', async () => {
  mockOwner = 2;
  const { result, rerender } = renderHook(() => useMettaReturn());
  await act(async () => Promise.resolve());
  expect(mockState).not.toHaveBeenCalled();
  expect(result.current.offerVisible).toBe(false);
  mockToken = 'account-2';
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-2'));
});

it('does not execute old account lifecycle callbacks under a replacement credential', async () => {
  const { result, rerender } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  const old = result.current;
  mockOwner = 2;
  mockEpoch += 1;
  mockToken = 'account-2';
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-2'));
  await act(async () => {
    await old.start();
    await old.release([9]);
  });
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRelease).not.toHaveBeenCalled();
});

it('passes the observed credential to same-account lifecycle requests', async () => {
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  await act(async () => {
    await result.current.start();
    await result.current.release([9]);
  });
  expect(mockStart).toHaveBeenCalledWith('account-1');
  expect(mockRelease).toHaveBeenCalledWith([9], 'account-1');
});

it('does not decline a newer episode through a retained previous-episode callback', async () => {
  mockDismiss.mockResolvedValue(state('opaque-episode-B'));
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  const declineA = result.current.dismissOffer;
  await act(async () => declineA());
  expect(result.current.offerVisible).toBe(true);
  await act(async () => declineA());
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  expect(result.current.offerVisible).toBe(true);
});

it('reads the fresh episode after an explicit stale-episode refusal without declining it', async () => {
  mockState.mockResolvedValueOnce(state()).mockResolvedValue(state('opaque-episode-B'));
  mockDismiss.mockRejectedValue({ status: 409, detail: 'return_offer_changed' });
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  await act(async () => result.current.dismissOffer());
  expect(mockState).toHaveBeenCalledTimes(2);
  expect(result.current.offerVisible).toBe(true);
  expect(mockDismiss).toHaveBeenCalledTimes(1);
});

it('does not hide the new account let-go moment through a retained skip callback', async () => {
  mockStart.mockResolvedValue({
    started_at: '2026-10-14T00:00:00Z',
    paused: false,
    week: 1,
    focus: 'self',
    complete: false,
  });
  const { result, rerender } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  const oldSkip = result.current.skipLetGo;
  mockOwner = 2;
  mockEpoch += 1;
  mockToken = 'account-2';
  mockState.mockResolvedValue(state('opaque-episode-B'));
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-2'));
  await act(async () => result.current.start());
  expect(result.current.letGoVisible).toBe(true);
  act(() => oldSkip());
  expect(result.current.letGoVisible).toBe(true);
});
