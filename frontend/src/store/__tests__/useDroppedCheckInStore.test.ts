/**
 * The dropped-check-in store is the seam between the replay quarantine and the
 * banner that tells the user a check-in was lost. It is deliberately separate
 * from ``useHabitStore.error``, whose Retry affordance cannot recover a
 * permanently rejected entry and which ``loadHabits`` clears on every pass.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import { resetAllStores } from '../registry';
import { useDroppedCheckInStore } from '../useDroppedCheckInStore';

import type { DroppedCheckIn } from '@/storage/habitStorage';

function dropped(goalId: number): DroppedCheckIn {
  return {
    goal_id: goalId,
    did_complete: true,
    timestamp: '2025-04-01T00:00:00Z',
    status: 404,
    dropped_at: '2025-04-02T09:00:00Z',
  };
}

const goalIds = (): number[] => useDroppedCheckInStore.getState().entries.map((e) => e.goal_id);

beforeEach(() => {
  act(() => {
    useDroppedCheckInStore.getState().reset();
  });
});

describe('useDroppedCheckInStore', () => {
  it('starts with no quarantined entries', () => {
    expect(useDroppedCheckInStore.getState().entries).toEqual([]);
    expect(useDroppedCheckInStore.getState().entries).toHaveLength(0);
  });

  it('setEntries replaces the list rather than appending to it', () => {
    act(() => {
      useDroppedCheckInStore.getState().setEntries([dropped(11), dropped(22)]);
    });
    expect(useDroppedCheckInStore.getState().entries).toHaveLength(2);
    expect(goalIds()).toEqual([11, 22]);

    act(() => {
      useDroppedCheckInStore.getState().setEntries([dropped(33)]);
    });

    expect(useDroppedCheckInStore.getState().entries).toHaveLength(1);
    expect(goalIds()).toEqual([33]);
    expect(goalIds()).not.toContain(11);
    expect(goalIds()).not.toContain(22);
  });

  it('reset empties a populated list', () => {
    act(() => {
      useDroppedCheckInStore.getState().setEntries([dropped(11), dropped(22)]);
    });
    expect(useDroppedCheckInStore.getState().entries).toHaveLength(2);

    act(() => {
      useDroppedCheckInStore.getState().reset();
    });

    expect(useDroppedCheckInStore.getState().entries).toHaveLength(0);
  });

  it('registers its reset with the shared registry so logout wipes it', () => {
    act(() => {
      useDroppedCheckInStore.getState().setEntries([dropped(11), dropped(22)]);
    });
    expect(useDroppedCheckInStore.getState().entries).toHaveLength(2);

    act(() => {
      resetAllStores();
    });

    expect(useDroppedCheckInStore.getState().entries).toHaveLength(0);
  });
});
