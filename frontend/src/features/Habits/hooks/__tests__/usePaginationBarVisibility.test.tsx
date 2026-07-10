// Pins the load-once, fail-open-visible, and toggle-persists-inverse contract
// of the pagination-bar visibility hook, with its storage module mocked so the
// tests never touch AsyncStorage.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

jest.mock('../../../../storage/paginationVisibilityStorage', () => ({
  loadPaginationBarHidden: jest.fn(() => Promise.resolve(false)),
  savePaginationBarHidden: jest.fn(() => Promise.resolve(undefined)),
}));

import {
  loadPaginationBarHidden,
  savePaginationBarHidden,
} from '../../../../storage/paginationVisibilityStorage';
import { usePaginationBarVisibility } from '../usePaginationBarVisibility';

const mockLoad = loadPaginationBarHidden as jest.MockedFunction<typeof loadPaginationBarHidden>;
const mockSave = savePaginationBarHidden as jest.MockedFunction<typeof savePaginationBarHidden>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('usePaginationBarVisibility', () => {
  it('defaults to visible before the persisted flag resolves', () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePaginationBarVisibility());
    expect(result.current.barVisible).toBe(true);
  });

  it('hides the bar once a persisted hidden flag resolves true', async () => {
    mockLoad.mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePaginationBarVisibility());
    await waitFor(() => expect(result.current.barVisible).toBe(false));
  });

  it('stays visible once a persisted hidden flag resolves false', async () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePaginationBarVisibility());
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    expect(result.current.barVisible).toBe(true);
  });

  it('toggling hides the bar and persists the matching hidden flag', async () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePaginationBarVisibility());
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.toggleBarVisible();
    });

    expect(result.current.barVisible).toBe(false);
    expect(mockSave).toHaveBeenCalledWith(true);
  });

  it('toggling twice shows the bar again and persists hidden=false', async () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePaginationBarVisibility());
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.toggleBarVisible();
    });
    act(() => {
      result.current.toggleBarVisible();
    });

    expect(result.current.barVisible).toBe(true);
    expect(mockSave).toHaveBeenLastCalledWith(false);
  });

  it('loads the persisted flag exactly once per mount', async () => {
    mockLoad.mockResolvedValueOnce(false);
    renderHook(() => usePaginationBarVisibility());
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
  });
});
