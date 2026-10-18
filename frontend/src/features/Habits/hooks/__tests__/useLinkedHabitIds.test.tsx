import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockList = jest.fn<() => Promise<{ id: number; habit_id?: number | null }[]>>();
const mockUiFlagsGet = jest.fn<() => Promise<{ writing_session_habit_id: number | null }>>();
let mockToken = 'token-a';

jest.mock('../../../../api', () => ({
  __esModule: true,
  userPractices: { list: () => mockList() },
  uiFlags: { get: () => mockUiFlagsGet() },
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: mockToken, userTimezone: 'UTC' }),
}));

import { useWritingHabitLinkStore } from '../../../../store/useWritingHabitLinkStore';
import { useLinkedHabitIds } from '../useLinkedHabitIds';

describe('useLinkedHabitIds', () => {
  beforeEach(() => {
    mockToken = 'token-a';
    mockList.mockReset();
    mockUiFlagsGet.mockReset();
    useWritingHabitLinkStore.getState().reset();
  });

  it('unions the writing link with every practice habit_id, skipping unlinked practices', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: 7 });
    mockList.mockResolvedValue([
      { id: 1, habit_id: 11 },
      { id: 2, habit_id: null },
      { id: 3 },
      { id: 4, habit_id: 7 },
    ]);
    const { result } = renderHook(() => useLinkedHabitIds());
    await waitFor(() => expect([...result.current].sort((a, b) => a - b)).toEqual([7, 11]));
  });

  it('is empty when nothing is linked, and when the practice read fails', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    mockList.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLinkedHabitIds());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.size).toBe(0);
  });

  it('keeps the same Set across re-renders while the links are unchanged', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    mockList.mockResolvedValue([{ id: 1, habit_id: 5 }]);
    const { result, rerender } = renderHook(() => useLinkedHabitIds());
    await waitFor(() => expect(result.current.has(5)).toBe(true));
    const first = result.current;
    rerender({});
    expect(result.current).toBe(first);
  });

  it('follows a writing link chosen after mount', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    mockList.mockResolvedValue([]);
    const { result } = renderHook(() => useLinkedHabitIds());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      useWritingHabitLinkStore.setState({ habitId: 9, hydrated: true });
    });
    expect(result.current.has(9)).toBe(true);
  });

  it('drops a practice answer that lands after unmount', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    let resolveList: (rows: { id: number; habit_id: number }[]) => void = () => {};
    mockList.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useLinkedHabitIds());
    unmount();
    await act(async () => {
      resolveList([{ id: 1, habit_id: 3 }]);
      await Promise.resolve();
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('exposes no prior-account practice links while the next account read is pending', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    let resolveNext: (rows: { id: number; habit_id: number }[]) => void = () => {};
    mockList.mockResolvedValueOnce([{ id: 1, habit_id: 5 }]).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );
    const { result, rerender } = renderHook(() => useLinkedHabitIds());
    await waitFor(() => expect([...result.current]).toEqual([5]));

    mockToken = 'token-b';
    rerender({});

    expect(result.current.size).toBe(0);
    await act(async () => {
      resolveNext([{ id: 2, habit_id: 9 }]);
    });
    expect([...result.current]).toEqual([9]);
  });

  it('does not let a deferred prior-account answer overwrite the current account', async () => {
    mockUiFlagsGet.mockResolvedValue({ writing_session_habit_id: null });
    let resolvePrior: (rows: { id: number; habit_id: number }[]) => void = () => {};
    mockList
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePrior = resolve;
        }),
      )
      .mockResolvedValueOnce([{ id: 2, habit_id: 9 }]);
    const { result, rerender } = renderHook(() => useLinkedHabitIds());

    mockToken = 'token-b';
    rerender({});
    await waitFor(() => expect([...result.current]).toEqual([9]));
    await act(async () => {
      resolvePrior([{ id: 1, habit_id: 5 }]);
    });

    expect([...result.current]).toEqual([9]);
  });
});
