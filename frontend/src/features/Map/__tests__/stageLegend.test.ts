/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_DISPLAY } from '../mapLayout';
import { balanceLabelSuffix, stageNodeLabel, THIN_FULLNESS } from '../stageLegend';
import { FULLNESS_ALIVE_THRESHOLD } from '../wheelBalance';

const requireDisplay = (stageNumber: number) => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
  return display;
};

describe('balanceLabelSuffix', () => {
  it('reads full at exactly the alive threshold', () => {
    expect(balanceLabelSuffix(FULLNESS_ALIVE_THRESHOLD)).toBe('reads full');
  });

  it('reads full above the alive threshold', () => {
    expect(balanceLabelSuffix(FULLNESS_ALIVE_THRESHOLD + 0.1)).toBe('reads full');
  });

  it('reads thin just below the alive threshold', () => {
    expect(balanceLabelSuffix(FULLNESS_ALIVE_THRESHOLD - 0.01)).toBe('reads thin');
  });

  it('reads thin at zero fullness', () => {
    expect(balanceLabelSuffix(0)).toBe('reads thin');
  });
});

describe('stageNodeLabel', () => {
  it('joins persona, descriptor, and a reads-full suffix at the threshold', () => {
    const display = requireDisplay(3);
    expect(stageNodeLabel(display, FULLNESS_ALIVE_THRESHOLD)).toBe(
      `${display.persona} - ${display.descriptor} - reads full`,
    );
  });

  it('joins persona, descriptor, and a reads-thin suffix below the threshold', () => {
    const display = requireDisplay(1);
    expect(stageNodeLabel(display, 0)).toBe(
      `${display.persona} - ${display.descriptor} - reads thin`,
    );
  });
});

describe('THIN_FULLNESS', () => {
  it('is the absent-fullness fallback of zero', () => {
    expect(THIN_FULLNESS).toBe(0);
  });
});
