import { describe, expect, it } from '@jest/globals';

import type { Stage } from '../../api';
import { deriveCurrentStage, STAGE_COUNT } from '../stageProgression';

/** Build a minimal fake API Stage response; only progress varies per case. */
function makeStage(stageNumber: number, progress: number): Stage {
  return {
    id: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    stage_number: stageNumber,
    overview_url: '',
    category: 'Test',
    aspect: 'Aspect',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: 'Growing',
    divine_gender_polarity: 'Polarity',
    relationship_to_free_will: 'Free Will',
    free_will_description: 'Desc',
    is_unlocked: true,
    progress,
  };
}

describe('deriveCurrentStage', () => {
  it('returns 1 for an empty stage list', () => {
    expect(deriveCurrentStage([])).toBe(1);
  });

  it('returns 1 when no stage is complete', () => {
    const stages = [makeStage(1, 0.5), makeStage(2, 0.2)];
    expect(deriveCurrentStage(stages)).toBe(1);
  });

  it('returns completed + 1 when some stages are complete', () => {
    const stages = [
      makeStage(1, 1),
      makeStage(2, 1),
      makeStage(3, 1),
      makeStage(4, 0.4),
      makeStage(5, 0),
    ];
    expect(deriveCurrentStage(stages)).toBe(4);
  });

  it('counts a stage with progress exactly 1 as complete', () => {
    const stages = [makeStage(1, 1), makeStage(2, 0.9)];
    expect(deriveCurrentStage(stages)).toBe(2);
  });

  it('counts a stage with progress above 1 as complete', () => {
    const stages = [makeStage(1, 1.5), makeStage(2, 0)];
    expect(deriveCurrentStage(stages)).toBe(2);
  });

  it('clamps to STAGE_COUNT when every stage is complete', () => {
    const stages = Array.from({ length: 10 }, (_unused, index) => makeStage(index + 1, 1));
    expect(deriveCurrentStage(stages)).toBe(STAGE_COUNT);
  });

  it('returns STAGE_COUNT when just one stage below the cap is complete', () => {
    const stages = Array.from({ length: 10 }, (_unused, index) =>
      makeStage(index + 1, index < 9 ? 1 : 0),
    );
    expect(deriveCurrentStage(stages)).toBe(STAGE_COUNT);
  });
});
