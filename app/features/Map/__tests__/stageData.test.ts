/* eslint-env jest */
/* global describe, it, expect */
import { STAGES } from '../stageData';

describe('stageData', () => {
  it('orders stages from 10 at top to 1 at bottom', () => {
    expect(STAGES[0]!.stageNumber).toBe(10);
    expect(STAGES[STAGES.length - 1]!.stageNumber).toBe(1);
  });
});
