/**
 * Tests for `useHabitUI` — focused on the Energy Scaffolding CTA lifecycle.
 * Regression coverage: an archived CTA must stay archived across logins
 * (it used to reappear because the flag lived only in component state).
 */
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

jest.mock('../../../../storage/energyScaffoldingStorage', () => ({
  loadEnergyScaffoldingArchived: jest.fn(() => Promise.resolve(false)),
  saveEnergyScaffoldingArchived: jest.fn(() => Promise.resolve(undefined)),
}));

// useHabitUI is server-first, falling back to the local cache above only when
// the GET rejects.
jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: {
    get: jest.fn(),
    update: jest.fn(),
  },
}));

import {
  loadEnergyScaffoldingArchived,
  saveEnergyScaffoldingArchived,
} from '../../../../storage/energyScaffoldingStorage';
import { useHabitUI } from '../useHabitUI';

const mockLoad = loadEnergyScaffoldingArchived as jest.MockedFunction<
  typeof loadEnergyScaffoldingArchived
>;
const mockSave = saveEnergyScaffoldingArchived as jest.MockedFunction<
  typeof saveEnergyScaffoldingArchived
>;

interface MockUiFlagsState {
  has_seen_welcome: boolean;
  energy_scaffolding_archived: boolean;
}

const mockUiFlags = (jest.requireMock('@/api') as { uiFlags: unknown }).uiFlags as {
  get: jest.Mock<(_token?: string) => Promise<MockUiFlagsState>>;
  update: jest.Mock<
    (_partial: Partial<MockUiFlagsState>, _token?: string) => Promise<MockUiFlagsState>
  >;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Default: no server hydration source, so the hook falls back to the local
  // cache exactly as before this issue landed. Individual tests below override
  // with a resolved value to exercise the server-first path.
  mockUiFlags.get.mockRejectedValue(new Error('no server hydration configured'));
  mockUiFlags.update.mockResolvedValue({
    has_seen_welcome: true,
    energy_scaffolding_archived: true,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useHabitUI — energy scaffolding CTA', () => {
  it('starts hidden and reveals the CTA once the load confirms it is not archived', async () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useHabitUI());
    // Hidden before the async read resolves — no flash for archived users.
    expect(result.current.showEnergyCTA).toBe(false);
    await waitFor(() => expect(result.current.showEnergyCTA).toBe(true));
  });

  it('keeps the CTA hidden when it was archived in a previous session', async () => {
    mockLoad.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useHabitUI());
    expect(result.current.showEnergyCTA).toBe(false);
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());
    expect(result.current.showEnergyCTA).toBe(false);
  });

  it('persists the archived flag when the CTA is archived', async () => {
    const { result } = renderHook(() => useHabitUI());
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());

    act(() => {
      result.current.archiveEnergyCTA();
    });

    expect(result.current.showEnergyCTA).toBe(false);
    expect(result.current.showArchiveMessage).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(true);
  });

  it('dismisses the archive message after the toast delay', async () => {
    const { result } = renderHook(() => useHabitUI());
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());

    act(() => {
      result.current.archiveEnergyCTA();
    });
    expect(result.current.showArchiveMessage).toBe(true);

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(result.current.showArchiveMessage).toBe(false);
  });

  describe('server-first hydration', () => {
    it('server wins over a wiped local cache: archived server flag hides the CTA', async () => {
      mockLoad.mockResolvedValueOnce(false);
      mockUiFlags.get.mockResolvedValueOnce({
        has_seen_welcome: false,
        energy_scaffolding_archived: true,
      });
      const { result } = renderHook(() => useHabitUI('server-tok'));
      await waitFor(() => expect(mockUiFlags.get).toHaveBeenCalledWith('server-tok'));
      await waitFor(() => expect(result.current.showEnergyCTA).toBe(false));
    });

    it('reveals the CTA for a first-time user when both server and local report unarchived', async () => {
      mockLoad.mockResolvedValueOnce(false);
      mockUiFlags.get.mockResolvedValueOnce({
        has_seen_welcome: false,
        energy_scaffolding_archived: false,
      });
      const { result } = renderHook(() => useHabitUI('server-tok'));
      await waitFor(() => expect(mockUiFlags.get).toHaveBeenCalledWith('server-tok'));
      await waitFor(() => expect(result.current.showEnergyCTA).toBe(true));
    });

    it('re-seeds the local cache with the server-resolved value after hydration', async () => {
      mockUiFlags.get.mockResolvedValueOnce({
        has_seen_welcome: false,
        energy_scaffolding_archived: true,
      });
      renderHook(() => useHabitUI('server-tok'));
      await waitFor(() => expect(mockSave).toHaveBeenCalledWith(true));
    });

    it('falls back to the local cache when the server GET rejects', async () => {
      mockUiFlags.get.mockRejectedValueOnce(new Error('network unreachable'));
      mockLoad.mockResolvedValueOnce(true);
      const { result } = renderHook(() => useHabitUI('server-tok'));
      // Pins that the server path was actually attempted (with the token) before
      // the fallback ran, not that the hook skipped straight to local storage.
      await waitFor(() => expect(mockUiFlags.get).toHaveBeenCalledWith('server-tok'));
      await waitFor(() => expect(result.current.showEnergyCTA).toBe(false));
    });
  });

  describe('archive PATCHes the server, best-effort', () => {
    it('archiveEnergyCTA syncs the server flag with the token after hydration', async () => {
      mockUiFlags.get.mockResolvedValueOnce({
        has_seen_welcome: false,
        energy_scaffolding_archived: false,
      });
      const { result } = renderHook(() => useHabitUI('server-tok'));
      await waitFor(() => expect(result.current.showEnergyCTA).toBe(true));

      act(() => {
        result.current.archiveEnergyCTA();
      });

      expect(result.current.showEnergyCTA).toBe(false);
      expect(result.current.showArchiveMessage).toBe(true);
      expect(mockSave).toHaveBeenCalledWith(true);
      expect(mockUiFlags.update).toHaveBeenCalledWith(
        { energy_scaffolding_archived: true },
        'server-tok',
      );
    });

    it('stays hidden and warns when the PATCH rejects', async () => {
      mockUiFlags.get.mockResolvedValueOnce({
        has_seen_welcome: false,
        energy_scaffolding_archived: false,
      });
      mockUiFlags.update.mockRejectedValueOnce(new Error('server unreachable'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { result } = renderHook(() => useHabitUI('server-tok'));
      await waitFor(() => expect(result.current.showEnergyCTA).toBe(true));

      act(() => {
        result.current.archiveEnergyCTA();
      });
      expect(result.current.showEnergyCTA).toBe(false);

      await waitFor(() => expect(warnSpy).toHaveBeenCalled());
      warnSpy.mockRestore();
    });
  });
});
