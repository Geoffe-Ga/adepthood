/* eslint-env jest */
// Direct unit tests for the stage-display helpers extracted from
// StageSelector so the drawer's stage grouping can reuse the same
// color/lock/completion rules without duplicating them.
import { describe, it, expect } from '@jest/globals';

import type { Stage } from '../../../api';
import { colors, resolveStageColor, STAGE_ORDER } from '../../../design/tokens';
import {
  getStageColor,
  isCompleted,
  isUnlocked,
  STAGE_COMPLETED_GLYPH,
  STAGE_LOCKED_GLYPH,
  stageStatusGlyph,
  totalStageCount,
} from '../stageDisplay';

const makeStage = (overrides: Partial<Stage> = {}): Stage => ({
  id: 1,
  title: 'Stage',
  subtitle: 'Subtitle',
  stage_number: 1,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: true,
  progress: 0,
  ...overrides,
});

describe('totalStageCount', () => {
  it('returns 0 for an empty stage list', () => {
    expect(totalStageCount([])).toBe(0);
  });

  it('returns the max stage_number across the list, regardless of order', () => {
    const stages = [
      makeStage({ stage_number: 2 }),
      makeStage({ stage_number: 5 }),
      makeStage({ stage_number: 1 }),
    ];
    expect(totalStageCount(stages)).toBe(5);
  });
});

describe('getStageColor', () => {
  it("uses the stage's own API spiral_dynamics_color when present", () => {
    const stage = makeStage({ stage_number: 3, spiral_dynamics_color: 'Red' });
    const stageById = new Map([[3, stage]]);
    expect(getStageColor(3, stageById)).toBe(resolveStageColor('Red'));
  });

  it('falls back to the STAGE_ORDER position when the stage is missing from the map', () => {
    const stageById = new Map<number, Stage>();
    expect(getStageColor(2, stageById)).toBe(resolveStageColor(STAGE_ORDER[1]));
  });

  it('falls back to the neutral color for an unrecognized color name', () => {
    const stage = makeStage({ stage_number: 1, spiral_dynamics_color: 'Mauve' });
    const stageById = new Map([[1, stage]]);
    expect(getStageColor(1, stageById)).toBe(colors.neutral);
  });
});

describe('isUnlocked', () => {
  it('returns false when the stage is missing from the map', () => {
    expect(isUnlocked(1, new Map())).toBe(false);
  });

  it('reflects is_unlocked: true from the stage data', () => {
    const stage = makeStage({ stage_number: 4, is_unlocked: true });
    expect(isUnlocked(4, new Map([[4, stage]]))).toBe(true);
  });

  it('reflects is_unlocked: false from the stage data', () => {
    const stage = makeStage({ stage_number: 4, is_unlocked: false });
    expect(isUnlocked(4, new Map([[4, stage]]))).toBe(false);
  });
});

describe('isCompleted', () => {
  it('returns false when the stage is missing from the map', () => {
    expect(isCompleted(1, new Map())).toBe(false);
  });

  it('returns true at exactly progress 1.0 (boundary)', () => {
    const stage = makeStage({ stage_number: 1, progress: 1.0 });
    expect(isCompleted(1, new Map([[1, stage]]))).toBe(true);
  });

  it('returns false just under progress 1.0', () => {
    const stage = makeStage({ stage_number: 1, progress: 0.99 });
    expect(isCompleted(1, new Map([[1, stage]]))).toBe(false);
  });

  it('returns false at progress 0', () => {
    const stage = makeStage({ stage_number: 1, progress: 0 });
    expect(isCompleted(1, new Map([[1, stage]]))).toBe(false);
  });
});

describe('stageStatusGlyph', () => {
  it('returns the completed glyph for a completed stage', () => {
    expect(stageStatusGlyph(true, true)).toBe(STAGE_COMPLETED_GLYPH);
  });

  it('returns the lock glyph for a locked, incomplete stage', () => {
    expect(stageStatusGlyph(false, false)).toBe(STAGE_LOCKED_GLYPH);
  });

  it('returns null for an open (unlocked, incomplete) stage', () => {
    expect(stageStatusGlyph(true, false)).toBeNull();
  });

  it('prioritizes completed over locked when a stage is both', () => {
    expect(stageStatusGlyph(false, true)).toBe(STAGE_COMPLETED_GLYPH);
  });
});
