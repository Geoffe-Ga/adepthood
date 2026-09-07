/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { buildSelectionSurfaceCopy } from '../selectionSurfaceCopy';

const TOUCH_AND_HOLD = /touch and hold/i;
const NATIVE_INSTRUCTION = 'Touch and hold a passage, then drag to choose it.';
const NATIVE_EMPTY_HINT = 'Choose a passage first — touch and hold the text.';

describe('buildSelectionSurfaceCopy', () => {
  it('on web never tells a mouse-and-keyboard reader to touch and hold', () => {
    const copy = buildSelectionSurfaceCopy('web');
    expect(copy.instruction).not.toMatch(TOUCH_AND_HOLD);
    expect(copy.emptyHint).not.toMatch(TOUCH_AND_HOLD);
  });

  it('on web names every desktop way of choosing a passage', () => {
    const { instruction } = buildSelectionSurfaceCopy('web');
    expect(instruction).toMatch(/drag/i);
    expect(instruction).toMatch(/double-click/i);
    expect(instruction).toMatch(/shift/i);
  });

  it('on web the empty hint still asks for a passage and says how to select one', () => {
    const { emptyHint } = buildSelectionSurfaceCopy('web');
    expect(emptyHint).toMatch(/choose a passage first/i);
    expect(emptyHint).toMatch(/select/i);
  });

  it('on ios keeps the long-press wording byte for byte', () => {
    expect(buildSelectionSurfaceCopy('ios')).toEqual({
      instruction: NATIVE_INSTRUCTION,
      emptyHint: NATIVE_EMPTY_HINT,
    });
  });

  it('on android keeps the long-press wording byte for byte', () => {
    expect(buildSelectionSurfaceCopy('android')).toEqual({
      instruction: NATIVE_INSTRUCTION,
      emptyHint: NATIVE_EMPTY_HINT,
    });
  });
});
