/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { buildSelectionSurfaceCopy } from '../selectionSurfaceCopy';

const TOUCH_AND_HOLD = /touch and hold/i;
const NATIVE_INSTRUCTION = 'Touch and hold a passage, then drag to choose it.';

describe('buildSelectionSurfaceCopy', () => {
  it('on web never tells a mouse-and-keyboard reader to touch and hold', () => {
    expect(buildSelectionSurfaceCopy('web').instruction).not.toMatch(TOUCH_AND_HOLD);
  });

  it('on web names every desktop way of choosing a passage', () => {
    const { instruction } = buildSelectionSurfaceCopy('web');
    expect(instruction).toMatch(/drag/i);
    expect(instruction).toMatch(/double-click/i);
    expect(instruction).toMatch(/shift/i);
  });

  it('on ios keeps the long-press wording byte for byte', () => {
    expect(buildSelectionSurfaceCopy('ios')).toEqual({ instruction: NATIVE_INSTRUCTION });
  });

  it('on android keeps the long-press wording byte for byte', () => {
    expect(buildSelectionSurfaceCopy('android')).toEqual({ instruction: NATIVE_INSTRUCTION });
  });
});
