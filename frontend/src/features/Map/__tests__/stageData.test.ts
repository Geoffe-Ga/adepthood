/* eslint-env jest */
/* global describe, it, expect */
import { isLeftReturning, STAGE_COUNT } from '../stageData';

describe('stageData', () => {
  it('winds even (Divine-Feminine) stages left and odd stages right', () => {
    // The spiral's meaning, read directly by the arrow glyph so the Map is
    // legible with no background PNG (#766).
    for (let stage = 1; stage <= STAGE_COUNT; stage++) {
      expect(isLeftReturning(stage)).toBe(stage % 2 === 0);
    }
  });
});
