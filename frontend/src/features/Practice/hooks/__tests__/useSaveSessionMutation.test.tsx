/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeSessionCreate, PracticeSessionResponse } from '@/api';

const mockCreate = jest.fn() as jest.MockedFunction<
  (_payload: PracticeSessionCreate) => Promise<PracticeSessionResponse>
>;

jest.mock('@/api', () => ({
  practiceSessions: {
    create: (...args: unknown[]) =>
      (mockCreate as unknown as (..._a: unknown[]) => Promise<PracticeSessionResponse>)(...args),
  },
}));

// The saved session is handed to the linked-habit check-off; the hook that
// owns that seam is stood in for here, so this test sees only the hand-off.
const mockCheckOff = jest.fn<(_payload: PracticeSessionCreate) => void>();

jest.mock('../usePracticeHabitCheckOff', () => ({
  usePracticeHabitCheckOff: () => mockCheckOff,
}));

const { useSaveSessionMutation } = require('../useSaveSessionMutation');

const PAYLOAD: PracticeSessionCreate = {
  user_practice_id: 7,
  started_at: '2026-09-08T14:40:00.000Z',
  ended_at: '2026-09-08T15:00:00.000Z',
  completed: true,
};

const SAVED: PracticeSessionResponse = {
  id: 100,
  user_practice_id: 7,
  duration_minutes: 20,
  timestamp: '2026-09-08T15:00:00.000Z',
  reflection: null,
  mode: 'meditation_timer',
  mode_metadata: null,
  completed: true,
  insight: null,
};

/**
 * A rejection shaped like the client's `ApiError`: `useOptimisticMutation`
 * rewraps a non-`Error` and drops `status`/`detail` with it, so a mock that
 * threw a plain object would never reach `formatApiError`'s status branch.
 */
function apiError(status: number, detail: string): Error {
  return Object.assign(new Error(`Request failed with status ${status}: ${detail}`), {
    name: 'ApiError',
    status,
    detail,
  });
}

interface Spies {
  apply: jest.Mock;
  rollback: jest.Mock;
  commit: jest.Mock;
  setSaveError: jest.Mock;
}

function spies(): Spies {
  return {
    apply: jest.fn(),
    rollback: jest.fn(),
    commit: jest.fn(),
    setSaveError: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useSaveSessionMutation', () => {
  it('applies optimistically, posts the payload once, and commits on success', async () => {
    mockCreate.mockResolvedValueOnce(SAVED);
    const s = spies();
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    let saved: PracticeSessionResponse | undefined;
    await act(async () => {
      saved = await result.current.mutate(PAYLOAD);
    });

    expect(saved).toEqual(SAVED);
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(PAYLOAD);
    expect(s.commit).toHaveBeenCalledTimes(1);
    expect(s.rollback).not.toHaveBeenCalled();
    // The banner from a previous attempt is cleared as the new one starts.
    expect(s.setSaveError).toHaveBeenCalledWith(null);
  });

  it('rolls back and names the stage refusal on a 403 stage_locked', async () => {
    mockCreate.mockRejectedValueOnce(apiError(403, 'stage_locked'));
    const s = spies();
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    await act(async () => {
      await expect(result.current.mutate(PAYLOAD)).rejects.toThrow();
    });

    expect(s.rollback).toHaveBeenCalledTimes(1);
    expect(s.commit).not.toHaveBeenCalled();
    expect(s.setSaveError).toHaveBeenLastCalledWith(
      expect.stringContaining("You haven't unlocked this stage yet"),
    );
  });

  it('prefers the caller status override over the generic fallback on a 422', async () => {
    mockCreate.mockRejectedValueOnce(
      apiError(422, 'Value error, started_at is too far in the past'),
    );
    const s = spies();
    const { result } = renderHook(() =>
      useSaveSessionMutation({
        ...s,
        errorOptions: { fallback: 'GENERIC', statusOverrides: { 422: 'WINDOW' } },
      }),
    );

    await act(async () => {
      await expect(result.current.mutate(PAYLOAD)).rejects.toThrow();
    });

    expect(s.setSaveError).toHaveBeenLastCalledWith('WINDOW');
  });

  it('falls back to the caller copy for an unrecognised failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('boom'));
    const s = spies();
    const { result } = renderHook(() =>
      useSaveSessionMutation({ ...s, errorOptions: { fallback: 'GENERIC' } }),
    );

    await act(async () => {
      await expect(result.current.mutate(PAYLOAD)).rejects.toThrow();
    });

    expect(s.setSaveError).toHaveBeenLastCalledWith('GENERIC');
  });

  it('hands the saved payload to the linked-habit check-off once the row is committed', async () => {
    mockCreate.mockResolvedValueOnce(SAVED);
    const s = spies();
    s.commit.mockImplementation(() => {
      expect(mockCheckOff).not.toHaveBeenCalled();
    });
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    await act(async () => {
      await result.current.mutate(PAYLOAD);
    });

    expect(mockCheckOff).toHaveBeenCalledTimes(1);
    expect(mockCheckOff).toHaveBeenCalledWith(PAYLOAD);
  });

  it('hands nothing to the check-off when the save fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('boom'));
    const s = spies();
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    await act(async () => {
      await expect(result.current.mutate(PAYLOAD)).rejects.toThrow();
    });

    expect(mockCheckOff).not.toHaveBeenCalled();
  });

  it('a check-off that throws never fails the save', async () => {
    mockCreate.mockResolvedValueOnce(SAVED);
    mockCheckOff.mockImplementationOnce(() => {
      throw new Error('check-off exploded');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = spies();
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    let saved: PracticeSessionResponse | undefined;
    await act(async () => {
      saved = await result.current.mutate(PAYLOAD);
    });

    expect(saved).toEqual(SAVED);
    expect(s.rollback).not.toHaveBeenCalled();
    expect(s.setSaveError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it('reports pending while the request is in flight', async () => {
    let release: (_value: PracticeSessionResponse) => void = () => {};
    mockCreate.mockReturnValueOnce(
      new Promise<PracticeSessionResponse>((resolve) => {
        release = resolve;
      }),
    );
    const s = spies();
    const { result } = renderHook(() => useSaveSessionMutation({ ...s, errorOptions: {} }));

    expect(result.current.pending).toBe(false);
    let inFlight: Promise<PracticeSessionResponse> | undefined;
    act(() => {
      inFlight = result.current.mutate(PAYLOAD);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    await act(async () => {
      release(SAVED);
      await inFlight;
    });
    expect(result.current.pending).toBe(false);
  });
});
