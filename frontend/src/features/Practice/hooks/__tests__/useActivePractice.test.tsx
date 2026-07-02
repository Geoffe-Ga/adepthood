/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { PracticeItem, UserPractice } from '@/api';

const mockListAll = jest.fn() as jest.MockedFunction<(_stage: number) => Promise<PracticeItem[]>>;
const mockUserPracticesList = jest.fn() as jest.MockedFunction<() => Promise<UserPractice[]>>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (_payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    listAll: (...args: unknown[]) =>
      (mockListAll as unknown as (...a: unknown[]) => Promise<PracticeItem[]>)(...args),
  },
  userPractices: {
    list: (...args: unknown[]) =>
      (mockUserPracticesList as unknown as (...a: unknown[]) => Promise<UserPractice[]>)(...args),
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

const { useActivePractice } = require('../useActivePractice');

const stagePractice: PracticeItem = {
  id: 17,
  stage_number: 5,
  name: 'Concentration on the breath',
  description: 'A breath practice',
  instructions: 'Breathe.',
  default_duration_minutes: 10,
  approved: true,
};

const activeRow: UserPractice = {
  id: 42,
  practice_id: 17,
  stage_number: 5,
  start_date: '2026-01-01',
  end_date: null,
};

describe('useActivePractice', () => {
  beforeEach(() => {
    mockListAll.mockReset();
    mockUserPracticesList.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('resolves the active row for the stage and derives effectiveName/effectiveConfig', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([activeRow]);

    const { result } = renderHook(() => useActivePractice(5));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeUserPractice).toEqual(activeRow);
    expect(result.current.practice).toEqual(stagePractice);
    expect(result.current.effectiveName).toBe('Concentration on the breath');
    expect(result.current.effectiveConfig).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns null effectiveConfig/effectiveName when there is no active row', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeUserPractice).toBeNull();
    expect(result.current.practice).toBeNull();
    expect(result.current.effectiveName).toBeNull();
    expect(result.current.effectiveConfig).toBeNull();
  });

  it('ignores a user-practice row for a different stage', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([{ ...activeRow, stage_number: 9 }]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeUserPractice).toBeNull();
  });

  it('ignores a closed row (non-null end_date) for the stage', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([{ ...activeRow, end_date: '2026-02-01' }]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeUserPractice).toBeNull();
  });

  it('prefers server-resolved effective_name/effective_config over local fallbacks', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([
      {
        ...activeRow,
        custom_name: 'My custom name',
        effective_name: 'Server name',
        mode_config_override: { mode: 'count_up' },
        effective_config: { mode: 'meditation_timer', duration_minutes: 15 },
      },
    ]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.effectiveName).toBe('Server name');
    expect(result.current.effectiveConfig).toEqual({
      mode: 'meditation_timer',
      duration_minutes: 15,
    });
  });

  it('falls back to custom_name then mode_config_override when no server-resolved fields', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([
      {
        ...activeRow,
        custom_name: 'My custom name',
        mode_config_override: { mode: 'count_up' },
      },
    ]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.effectiveName).toBe('My custom name');
    expect(result.current.effectiveConfig).toEqual({ mode: 'count_up' });
  });

  it('falls back to the catalog practice.name and mode_config as the last resort', async () => {
    mockListAll.mockResolvedValue([
      { ...stagePractice, mode_config: { mode: 'tarot', deck: 'major_arcana' } },
    ]);
    mockUserPracticesList.mockResolvedValue([activeRow]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.effectiveName).toBe('Concentration on the breath');
    expect(result.current.effectiveConfig).toEqual({ mode: 'tarot', deck: 'major_arcana' });
  });

  it('surfaces a load failure via formatApiError and keeps isLoading false', async () => {
    mockListAll.mockRejectedValue(new Error('network down'));
    mockUserPracticesList.mockResolvedValue([]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toEqual(expect.any(String));
    expect(result.current.error).not.toBeNull();
  });

  it('a silent refresh keeps isLoading unchanged while it revalidates', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([activeRow]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let resolveList: ((value: UserPractice[]) => void) | undefined;
    mockUserPracticesList.mockReturnValueOnce(
      new Promise<UserPractice[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    act(() => {
      void result.current.refresh({ silent: true });
    });

    // isLoading must not flip true during a silent refresh.
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolveList?.([activeRow]);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('selectPractice creates a user-practice row and sets it active', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([]);
    mockUserPracticesCreate.mockResolvedValue(activeRow);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.selectPractice(17);
    });

    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 17, stage_number: 5 });
    expect(result.current.activeUserPractice).toEqual(activeRow);
    expect(result.current.error).toBeNull();
  });

  it('selectPractice surfaces a failure via formatApiError', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([]);
    mockUserPracticesCreate.mockRejectedValue(new Error('rejected'));

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.selectPractice(17);
    });

    expect(result.current.error).toEqual(expect.any(String));
    expect(result.current.error).not.toBeNull();
  });

  it('selectPractice guards against a second concurrent call while one is in flight', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([]);
    let resolveCreate: ((value: UserPractice) => void) | undefined;
    mockUserPracticesCreate.mockReturnValueOnce(
      new Promise<UserPractice>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let firstDone = false;
    let secondDone = false;
    act(() => {
      void result.current.selectPractice(17).then(() => {
        firstDone = true;
      });
      void result.current.selectPractice(17).then(() => {
        secondDone = true;
      });
    });

    await act(async () => {
      resolveCreate?.(activeRow);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUserPracticesCreate).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
  });

  it('updateActivePractice replaces the in-memory active row without a refetch', async () => {
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockResolvedValue([activeRow]);

    const { result } = renderHook(() => useActivePractice(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const updated: UserPractice = { ...activeRow, custom_name: 'Renamed' };
    act(() => {
      result.current.updateActivePractice(updated);
    });

    expect(result.current.activeUserPractice).toEqual(updated);
    expect(mockListAll).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale refresh resolution after unmount', async () => {
    let resolveList: ((value: UserPractice[]) => void) | undefined;
    mockListAll.mockResolvedValue([stagePractice]);
    mockUserPracticesList.mockReturnValueOnce(
      new Promise<UserPractice[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useActivePractice(5));
    unmount();
    await act(async () => {
      resolveList?.([activeRow]);
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.activeUserPractice).toBeNull();
  });
});
