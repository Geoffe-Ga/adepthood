/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { useBeginAgainGuard as UseBeginAgainGuard } from '../useBeginAgainGuard';

type RealUseState = (_initial: unknown) => [unknown, (_next: unknown) => void];

// When armed, record every state dispatch so the unmount-guard test can assert
// that no dispatch reaches the hook after teardown — the one signal React 18
// leaves observable (a post-unmount setState is otherwise a silent no-op).
let mockUnmountTrackingArmed = false;
const mockPostUnmountDispatches: unknown[] = [];

function mockWrapUseState(realUseState: unknown): (_initial: unknown) => [unknown, unknown] {
  const useStateFn = realUseState as RealUseState;
  return (initial) => {
    const [value, setValue] = useStateFn(initial);
    const trackedSetValue = (next: unknown): void => {
      if (mockUnmountTrackingArmed) mockPostUnmountDispatches.push(next);
      setValue(next);
    };
    return [value, trackedSetValue];
  };
}

jest.mock('react', () => {
  const actual = jest.requireActual('react') as Record<string, unknown>;
  return { ...actual, useState: mockWrapUseState(actual.useState) };
});

const mockBeginAgain = jest.fn() as jest.MockedFunction<
  (_token?: string, _tz?: string | null) => Promise<void>
>;

// The account zone the begin-again adopts the new cycle's day in (#3702).
const mockAuth = { userTimezone: 'Europe/Paris', userTimezoneReady: true };
jest.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../../services/stageService', () => ({
  stageService: {
    beginAgain: (...a: unknown[]) =>
      (mockBeginAgain as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

const { useBeginAgainGuard } = require('../useBeginAgainGuard') as {
  useBeginAgainGuard: typeof UseBeginAgainGuard;
};

let resolveBeginAgain: () => void = () => {};

beforeEach(() => {
  mockBeginAgain.mockReset();
  resolveBeginAgain = () => {};
  mockBeginAgain.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveBeginAgain = resolve;
      }),
  );
  mockUnmountTrackingArmed = false;
  mockPostUnmountDispatches.length = 0;
  mockAuth.userTimezone = 'Europe/Paris';
  mockAuth.userTimezoneReady = true;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useBeginAgainGuard', () => {
  it('flips beginning true while in flight and back to false once resolved while mounted', async () => {
    const { result } = renderHook(() => useBeginAgainGuard());
    expect(result.current.beginning).toBe(false);

    act(() => {
      result.current.handleBeginAgain();
    });
    expect(result.current.beginning).toBe(true);
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });
    expect(result.current.beginning).toBe(false);
  });

  it('sends exactly one beginAgain request for a same-tick double press', async () => {
    const { result } = renderHook(() => useBeginAgainGuard());

    act(() => {
      result.current.handleBeginAgain();
      result.current.handleBeginAgain();
    });
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });
  });

  it('skips the state update when the promise settles after unmount', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useBeginAgainGuard());

    act(() => {
      result.current.handleBeginAgain();
    });
    expect(mockBeginAgain).toHaveBeenCalledTimes(1);

    unmount();
    mockUnmountTrackingArmed = true;

    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });

    expect(mockPostUnmountDispatches).toHaveLength(0);
    const lifecycleWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      /unmounted|not wrapped in act/i.test(String(call[0])),
    );
    expect(lifecycleWarnings).toHaveLength(0);
  });

  it("hands begin-again the account's zone once it is known (#3702)", async () => {
    const { result } = renderHook(() => useBeginAgainGuard());

    act(() => {
      result.current.handleBeginAgain();
    });

    expect(mockBeginAgain).toHaveBeenCalledWith(undefined, 'Europe/Paris');
    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });
  });

  it('hands begin-again no zone while the account zone is still provisional (#3702)', async () => {
    // The provisional "UTC" default is not the person's zone; adopting a day
    // counted in it could name the wrong date, so the day waits for a reconcile.
    mockAuth.userTimezone = 'UTC';
    mockAuth.userTimezoneReady = false;
    const { result } = renderHook(() => useBeginAgainGuard());

    act(() => {
      result.current.handleBeginAgain();
    });

    expect(mockBeginAgain).toHaveBeenCalledWith(undefined, null);
    await act(async () => {
      resolveBeginAgain();
      await Promise.resolve();
    });
  });
});
