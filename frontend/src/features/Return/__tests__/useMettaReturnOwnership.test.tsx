import { jest, beforeEach, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { MettaReturnState, ReturnArc } from '@/api';
import type * as SessionToken from '@/api/sessionToken';
import type * as UserScope from '@/storage/userScope';

let mockOwner: number | null = 1;
let mockEpoch = 1;
let mockAuthSession = 1;
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
    // ``account-<id>`` or a renewed ``account-<id>:<renewal>`` for the same subject.
    token.startsWith('account-') ? { sub: token.slice('account-'.length).split(':')[0] } : null,
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
jest.mock('@/api/sessionToken', () => ({
  ...jest.requireActual<typeof SessionToken>('@/api/sessionToken'),
  captureAuthScope: () => ({
    owner: mockOwner,
    generation: mockEpoch,
    session: mockAuthSession,
  }),
  getAuthSession: () => mockAuthSession,
  isAuthScopeCurrent: (scope: { owner: number | null; generation: number; session: number }) =>
    scope.owner === mockOwner &&
    scope.generation === mockEpoch &&
    scope.session === mockAuthSession,
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
  mockAuthSession = 1;
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

it('lands one held Return offer action across a proactive same-account renewal', async () => {
  const held = deferred<MettaReturnState>();
  const renewalRead = deferred<MettaReturnState>();
  mockDismiss.mockReturnValueOnce(held.promise);
  const { result, rerender } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  let decline!: Promise<void>;
  act(() => {
    decline = result.current.dismissOffer();
  });
  await waitFor(() => expect(mockDismiss).toHaveBeenCalledTimes(1));

  mockState.mockReturnValueOnce(renewalRead.promise);
  mockToken = 'account-1:renewed';
  rerender({});
  await act(async () => {
    held.resolve(state('opaque-episode-B'));
    await decline;
  });

  expect(mockDismiss).toHaveBeenCalledTimes(1);
  expect(result.current.offerVisible).toBe(true);
  expect(mockSave).not.toHaveBeenCalledWith({ userId: 1, episode: 'opaque-episode-B' }, true);
});

it.each<[string, () => void]>([
  [
    'the same owner starts a new auth session',
    () => {
      mockAuthSession += 1;
    },
  ],
  [
    'the owner signs out',
    () => {
      mockOwner = null;
      mockToken = null;
      mockEpoch += 1;
      mockAuthSession += 1;
    },
  ],
  [
    'the account switches',
    () => {
      mockOwner = 2;
      mockToken = 'account-2';
      mockEpoch += 1;
      mockAuthSession += 1;
    },
  ],
  [
    'the account switches A → B → A without an intermediate render',
    () => {
      mockOwner = 2;
      mockToken = 'account-2';
      mockEpoch += 1;
      mockAuthSession += 1;
      mockOwner = 1;
      mockToken = 'account-1';
      mockEpoch += 1;
      mockAuthSession += 1;
    },
  ],
])('drops a held Return action when %s', async (_label, interrupt) => {
  const held = deferred<MettaReturnState>();
  mockDismiss.mockReturnValueOnce(held.promise);
  const { result } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  let decline!: Promise<void>;
  act(() => {
    decline = result.current.dismissOffer();
  });
  await waitFor(() => expect(mockDismiss).toHaveBeenCalledTimes(1));

  interrupt();
  await act(async () => {
    held.resolve(state('opaque-episode-B'));
    await decline;
  });

  expect(result.current.offerVisible).toBe(false);
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

const ARC: ReturnArc = {
  started_at: '2026-10-14T00:00:00Z',
  paused: false,
  week: 1,
  focus: 'self',
  complete: false,
};

async function renderStartedReturn() {
  mockStart.mockResolvedValue(ARC);
  const rendered = renderHook(() => useMettaReturn());
  await waitFor(() => expect(rendered.result.current.offerVisible).toBe(true));
  mockState.mockResolvedValue({ ...state(), arc: ARC });
  await act(async () => rendered.result.current.start());
  expect(rendered.result.current.letGoVisible).toBe(true);
  return rendered;
}

it('keeps the let-go moment open across a same-account token renewal', async () => {
  const { result, rerender } = await renderStartedReturn();
  mockToken = 'account-1:renewed';
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-1:renewed'));
  expect(result.current.arc).toEqual(ARC);
  expect(result.current.letGoVisible).toBe(true);
  await act(async () => result.current.release([9]));
  expect(mockRelease).toHaveBeenCalledWith([9], 'account-1:renewed');
  expect(result.current.letGoVisible).toBe(false);
});

it('still lets the person skip the let-go moment after a same-account renewal', async () => {
  const { result, rerender } = await renderStartedReturn();
  mockToken = 'account-1:renewed';
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-1:renewed'));
  expect(result.current.letGoVisible).toBe(true);
  act(() => result.current.skipLetGo());
  expect(result.current.letGoVisible).toBe(false);
  expect(mockRelease).not.toHaveBeenCalled();
});

it('closes the let-go moment when the session is torn down, even for a returning account', async () => {
  const { result, rerender } = await renderStartedReturn();
  mockToken = null;
  mockOwner = null;
  mockEpoch += 1;
  rerender({});
  expect(result.current.letGoVisible).toBe(false);
  mockToken = 'account-1:next-session';
  mockOwner = 1;
  mockEpoch += 1;
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledWith('account-1:next-session'));
  await waitFor(() => expect(result.current.arc).toEqual(ARC));
  expect(result.current.letGoVisible).toBe(false);
});

it('closes the let-go moment across A to B to A without an intermediate render', async () => {
  const { result, rerender } = await renderStartedReturn();
  const oldRelease = result.current.release;
  mockOwner = 2;
  mockEpoch += 1;
  mockOwner = 1;
  mockEpoch += 1;
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledTimes(2));
  expect(result.current.letGoVisible).toBe(false);
  await act(async () => oldRelease([9]));
  expect(mockRelease).not.toHaveBeenCalled();
});

it('reads nothing for the outgoing account while its cleanup runs, then reads after commit (#3368)', async () => {
  const scope = jest.requireActual<typeof UserScope>('@/storage/userScope');
  const { result, rerender } = renderHook(() => useMettaReturn());
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
  expect(mockState).toHaveBeenCalledTimes(1);
  try {
    // The logout wipe: the token and owner are still A's, only the generation moved.
    scope.beginActiveUserTransition();
    mockEpoch += 1;
    rerender({});
    await act(async () => Promise.resolve());
    expect(mockState).toHaveBeenCalledTimes(1);
    expect(result.current.offerVisible).toBe(false);
  } finally {
    // Same-owner commit (the cleanup ends back on A): one final read, no more.
    scope.setActiveUser(scope.getActiveUser());
  }
  mockEpoch += 1;
  rerender({});
  await waitFor(() => expect(mockState).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.offerVisible).toBe(true));
});
