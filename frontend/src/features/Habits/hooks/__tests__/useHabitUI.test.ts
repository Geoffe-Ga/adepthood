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

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useHabitUI — energy scaffolding CTA', () => {
  it('shows the CTA when nothing has been archived', async () => {
    mockLoad.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useHabitUI());
    expect(result.current.showEnergyCTA).toBe(true);
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());
    expect(result.current.showEnergyCTA).toBe(true);
  });

  it('hides the CTA on mount when it was archived in a previous session', async () => {
    mockLoad.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useHabitUI());
    await waitFor(() => expect(result.current.showEnergyCTA).toBe(false));
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
});
