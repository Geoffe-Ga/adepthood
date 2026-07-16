/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { stageDisplayName, stageLabel } from '../stageDisplayName';

describe('stageDisplayName', () => {
  it.each([
    [1, 'Beige'],
    [2, 'Purple'],
    [4, 'Blue'],
    [10, 'Clear Light'],
  ])('resolves stage %i to %s', (stage, name) => {
    expect(stageDisplayName(stage)).toBe(name);
  });

  it('falls back to "Stage {n}" for a stage below the known range', () => {
    expect(stageDisplayName(0)).toBe('Stage 0');
  });

  it('falls back to "Stage {n}" for a stage above the known range', () => {
    expect(stageDisplayName(99)).toBe('Stage 99');
  });
});

describe('stageLabel', () => {
  it('combines the stage name with its number', () => {
    expect(stageLabel(2)).toBe('Purple (stage 2)');
  });

  it('combines a different stage name with its number', () => {
    expect(stageLabel(4)).toBe('Blue (stage 4)');
  });

  it('falls back to the numeric name for an out-of-range stage', () => {
    expect(stageLabel(99)).toBe('Stage 99 (stage 99)');
  });
});
