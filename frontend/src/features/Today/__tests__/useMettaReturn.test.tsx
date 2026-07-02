/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { MettaReturnState, ReturnArc, ReturnWeek } from '@/api';

const mockState = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<MettaReturnState>>;
const mockStart = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<ReturnArc>>;
const mockPause = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<ReturnArc>>;
const mockResume = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<ReturnArc>>;
const mockLeave = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<ReturnArc>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    mettaReturn: {
      state: (...a: unknown[]) => (mockState as unknown as (...x: unknown[]) => unknown)(...a),
      start: (...a: unknown[]) => (mockStart as unknown as (...x: unknown[]) => unknown)(...a),
      pause: (...a: unknown[]) => (mockPause as unknown as (...x: unknown[]) => unknown)(...a),
      resume: (...a: unknown[]) => (mockResume as unknown as (...x: unknown[]) => unknown)(...a),
      leave: (...a: unknown[]) => (mockLeave as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const mockIsContractionSignalActive = jest.fn() as jest.MockedFunction<() => boolean>;
jest.mock('../contractionSignal', () => ({
  isContractionSignalActive: () => mockIsContractionSignalActive(),
}));

const mockSaveDismissed = jest.fn() as jest.MockedFunction<() => Promise<void>>;
const mockLoadDismissed = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
jest.mock('@/storage/returnOfferStorage', () => ({
  saveReturnOfferDismissed: (...a: unknown[]) =>
    (mockSaveDismissed as unknown as (...x: unknown[]) => unknown)(...a),
  loadReturnOfferDismissed: (...a: unknown[]) =>
    (mockLoadDismissed as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { useMettaReturn } = require('../useMettaReturn');

function week(overrides: Partial<ReturnWeek> = {}): ReturnWeek {
  return {
    week_number: 1,
    focus: 'self',
    title: 'Toward yourself',
    framing: 'Begin where you already are.',
    ...overrides,
  };
}

function fiveWeeks(): ReturnWeek[] {
  return [1, 2, 3, 4, 5].map((n) => week({ week_number: n }));
}

function arc(overrides: Partial<ReturnArc> = {}): ReturnArc {
  return {
    started_at: '2026-06-24T00:00:00Z',
    paused: false,
    week: 1,
    focus: 'self',
    ...overrides,
  };
}

function stateResult(overrides: Partial<MettaReturnState> = {}): MettaReturnState {
  return { eligible: true, weeks: fiveWeeks(), arc: null, ...overrides };
}

beforeEach(() => {
  mockState.mockReset();
  mockStart.mockReset();
  mockPause.mockReset();
  mockResume.mockReset();
  mockLeave.mockReset();
  mockIsContractionSignalActive.mockReset();
  mockSaveDismissed.mockReset();
  mockLoadDismissed.mockReset();

  mockState.mockResolvedValue(stateResult());
  mockStart.mockResolvedValue(arc());
  mockPause.mockResolvedValue(arc({ paused: true }));
  mockResume.mockResolvedValue(arc({ paused: false }));
  mockLeave.mockResolvedValue(arc());
  mockIsContractionSignalActive.mockReturnValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
  mockLoadDismissed.mockResolvedValue(false);
});

describe('useMettaReturn', () => {
  it('loads state on mount and exposes eligible/weeks/arc', async () => {
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
    expect(result.current.eligible).toBe(true);
    expect(result.current.weeks).toHaveLength(5);
    expect(result.current.arc).toBeNull();
  });

  it('offerVisible is false when the contraction signal is inactive, even if eligible', async () => {
    mockIsContractionSignalActive.mockReturnValue(false);
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
    expect(result.current.offerVisible).toBe(false);
  });

  it('offerVisible is true when eligible, no arc, and the contraction signal is active', async () => {
    mockIsContractionSignalActive.mockReturnValue(true);
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(result.current.offerVisible).toBe(true));
  });

  it('offerVisible is false when an arc already exists, even with an active signal', async () => {
    mockIsContractionSignalActive.mockReturnValue(true);
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: arc() }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
    expect(result.current.offerVisible).toBe(false);
    expect(result.current.arc).not.toBeNull();
  });

  it('dismissOffer hides the offer and persists the dismissal', async () => {
    mockIsContractionSignalActive.mockReturnValue(true);
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(result.current.offerVisible).toBe(true));

    await act(async () => {
      result.current.dismissOffer();
    });

    expect(result.current.offerVisible).toBe(false);
    expect(mockSaveDismissed).toHaveBeenCalledTimes(1);
  });

  it('a persisted dismissal keeps the offer hidden on reload', async () => {
    mockIsContractionSignalActive.mockReturnValue(true);
    mockLoadDismissed.mockResolvedValue(true);
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
    expect(result.current.offerVisible).toBe(false);
  });

  it('start calls the API and updates arc to week 1, self', async () => {
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: null }));
    mockStart.mockResolvedValue(arc({ week: 1, focus: 'self' }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.start();
    });

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result.current.arc?.week).toBe(1);
    expect(result.current.arc?.focus).toBe('self');
  });

  it('pause calls the API and updates arc.paused optimistically, reverting on error', async () => {
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: arc({ paused: false }) }));
    mockPause.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(result.current.arc).not.toBeNull());

    await act(async () => {
      await expect(result.current.pause()).rejects.toThrow('network error');
    });

    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(result.current.arc?.paused).toBe(false);
  });

  it('resume calls the API and updates arc.paused', async () => {
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: arc({ paused: true }) }));
    mockResume.mockResolvedValue(arc({ paused: false }));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(result.current.arc).not.toBeNull());

    await act(async () => {
      await result.current.resume();
    });

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(result.current.arc?.paused).toBe(false);
  });

  it('leave calls the API and clears the local arc', async () => {
    mockState.mockResolvedValue(stateResult({ eligible: true, arc: arc() }));
    mockLeave.mockResolvedValue(arc());
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(result.current.arc).not.toBeNull());

    await act(async () => {
      await result.current.leave();
    });

    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(result.current.arc).toBeNull();
  });

  it('silently swallows a state-load failure (no crash, defaults stay empty)', async () => {
    mockState.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useMettaReturn());
    await waitFor(() => expect(mockState).toHaveBeenCalledTimes(1));
    expect(result.current.eligible).toBe(false);
    expect(result.current.weeks).toEqual([]);
    expect(result.current.arc).toBeNull();
  });

  it('unmount guard: a late state resolution does not set state after unmount', async () => {
    let resolveState: (_value: MettaReturnState) => void = () => {};
    mockState.mockReturnValue(
      new Promise<MettaReturnState>((resolve) => {
        resolveState = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useMettaReturn());
    unmount();

    await act(async () => {
      resolveState(stateResult({ eligible: true, arc: null }));
      await Promise.resolve();
    });

    // The hook must never flip eligible on a dead instance after unmount.
    expect(result.current.eligible).toBe(false);
  });
});
