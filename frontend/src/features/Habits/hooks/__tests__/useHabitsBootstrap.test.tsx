import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useBootstrapHabits } from '../useHabits';

const mockRegister = jest.fn<(signal?: AbortSignal) => Promise<string | undefined>>();
const mockReconcile = jest.fn<(signal?: AbortSignal) => Promise<void>>();
let mockResolveReconcile: () => void = () => {};

jest.mock('../useHabitNotifications', () => ({
  registerForPushNotificationsAsync: (signal?: AbortSignal) => mockRegister(signal),
  reconcileNotifications: (signal?: AbortSignal) => mockReconcile(signal),
}));

jest.mock('../../services/habitManager', () => ({
  habitManager: {
    loadHabits: jest.fn(() => Promise.resolve()),
  },
}));

beforeEach(() => {
  mockRegister.mockResolvedValue(undefined);
  mockReconcile.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        mockResolveReconcile = resolve;
      }),
  );
});

describe('useBootstrapHabits lifecycle', () => {
  it('aborts the in-flight notification work when the hook unmounts', async () => {
    const { unmount } = renderHook(() => useBootstrapHabits('UTC'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    const signal = mockReconcile.mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mockRegister.mock.calls[0]?.[0]).toBe(signal);

    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      mockResolveReconcile();
      await Promise.resolve();
    });
  });
});
