/**
 * Tests for `useStageAdvance` — the React call site that wires
 * `stageService` advance primitives into `useOptimisticMutation`. The
 * hook closes BUG-FE-MAP-005 by giving callers an apply / commit /
 * rollback flow that reverts `currentStage` when the server reload
 * rejects the new value.
 */
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { Stage } from '../../../../api';
import { useStageStore } from '../../../../store/useStageStore';
import { useStageAdvance } from '../useStageAdvance';

const mockList = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<Stage[]>>;
jest.mock('../../../../api', () => ({
  stages: { list: (...args: [string?]) => mockList(...args) },
}));

function makeApiStage(stageNumber: number, overrides: Partial<Stage> = {}): Stage {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: '',
    stage_number: stageNumber,
    overview_url: '',
    category: 'Test',
    aspect: '',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: '',
    divine_gender_polarity: '',
    relationship_to_free_will: '',
    free_will_description: '',
    is_unlocked: stageNumber <= 2,
    progress: stageNumber === 1 ? 1 : 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  act(() => {
    useStageStore.getState().setStages([]);
    useStageStore.getState().setCurrentStage(2);
    useStageStore.getState().setLoading(false);
    useStageStore.getState().setError(null);
  });
});

describe('useStageAdvance', () => {
  it('apply -> commit advances the stage when the server reload confirms it', async () => {
    mockList.mockResolvedValueOnce([
      makeApiStage(1, { is_unlocked: true, progress: 1 }),
      makeApiStage(2, { is_unlocked: true, progress: 1 }),
      makeApiStage(3, { is_unlocked: true, progress: 0 }),
    ]);

    const { result } = renderHook(() => useStageAdvance());
    await act(async () => {
      await result.current.advanceStage(3);
    });

    expect(useStageStore.getState().currentStage).toBe(3);
    expect(result.current.pending).toBe(false);
  });

  it('rolls back currentStage when the server reload fails (BUG-FE-MAP-005)', async () => {
    mockList.mockRejectedValueOnce(new Error('still offline'));

    const { result } = renderHook(() => useStageAdvance());
    await act(async () => {
      await result.current.advanceStage(5);
    });

    // Optimistic 5 was reverted to the prev value (2).
    expect(useStageStore.getState().currentStage).toBe(2);
    // The error is recorded on the store so a subscribed UI can show
    // a retry affordance — exposed via `useStageStore.error`.
    expect(useStageStore.getState().error).toBe('still offline');
  });

  it('is a no-op when the requested stage equals currentStage', async () => {
    const { result } = renderHook(() => useStageAdvance());
    await act(async () => {
      await result.current.advanceStage(2);
    });

    expect(mockList).not.toHaveBeenCalled();
    expect(useStageStore.getState().currentStage).toBe(2);
  });
});
