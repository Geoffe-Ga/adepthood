/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_DISPLAY } from '../mapLayout';
import {
  balanceLabelSuffix,
  drawerStageLabel,
  stageNodeLabel,
  THIN_FULLNESS,
} from '../stageLegend';
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

describe('drawerStageLabel', () => {
  it('joins the category and Aspect with a comma when an aspect is given', () => {
    expect(drawerStageLabel('Yes-And-Ness', 'Agency', { locked: false, current: false })).toBe(
      'Yes-And-Ness, Agency',
    );
  });

  it('omits the Aspect segment when aspect is empty', () => {
    expect(drawerStageLabel('Being', '', { locked: false, current: false })).toBe('Being');
  });

  it('omits the Aspect segment for a title stage with no arrow label, keeping the category', () => {
    expect(drawerStageLabel('Awareness', '', { locked: false, current: false })).toBe('Awareness');
  });

  it('appends a locked marker when locked is true', () => {
    expect(drawerStageLabel('Wisdom', 'Nondual', { locked: true, current: false })).toBe(
      'Wisdom, Nondual, locked',
    );
  });

  it('appends a current marker when current is true', () => {
    expect(drawerStageLabel('Understanding', 'Embodied', { locked: false, current: true })).toBe(
      'Understanding, Embodied, current',
    );
  });

  it('appends both markers, current before locked, when both are true', () => {
    expect(drawerStageLabel('Love', 'Self-Love', { locked: true, current: true })).toBe(
      'Love, Self-Love, current, locked',
    );
  });

  it('carries no state markers when neither locked nor current is true', () => {
    expect(drawerStageLabel('Wisdom', 'Systems', { locked: false, current: false })).toBe(
      'Wisdom, Systems',
    );
  });
});
