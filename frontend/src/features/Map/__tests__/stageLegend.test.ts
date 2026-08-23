/* eslint-env jest */
/* global describe, it, expect */
import { STAGE_DISPLAY } from '../mapLayout';
import {
  balanceLabelSuffix,
  drawerStageLabel,
  stageCenterCellLabel,
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

const OPEN = { locked: false, current: false };

describe('stageNodeLabel', () => {
  it('joins persona, descriptor, and a reads-full suffix at the threshold', () => {
    const display = requireDisplay(3);
    expect(stageNodeLabel(display, FULLNESS_ALIVE_THRESHOLD, OPEN)).toBe(
      `${display.persona} - ${display.descriptor} - reads full`,
    );
  });

  it('joins persona, descriptor, and a reads-thin suffix below the threshold', () => {
    const display = requireDisplay(1);
    expect(stageNodeLabel(display, 0, OPEN)).toBe(
      `${display.persona} - ${display.descriptor} - reads thin`,
    );
  });

  it('appends a locked marker so the padlock is not sight-only', () => {
    const display = requireDisplay(7);
    expect(stageNodeLabel(display, 0, { locked: true, current: false })).toBe(
      `${display.persona} - ${display.descriptor} - reads thin, locked`,
    );
  });

  it('appends a current marker for the stage the person is in', () => {
    const display = requireDisplay(2);
    expect(stageNodeLabel(display, 0, { locked: false, current: true })).toBe(
      `${display.persona} - ${display.descriptor} - reads thin, current`,
    );
  });

  it('appends both markers, current before locked, matching the drawer row', () => {
    const display = requireDisplay(4);
    expect(stageNodeLabel(display, 0, { locked: true, current: true })).toBe(
      `${display.persona} - ${display.descriptor} - reads thin, current, locked`,
    );
  });
});

describe('stageCenterCellLabel', () => {
  it('joins the title and subtitle when the stage is open and not current', () => {
    expect(stageCenterCellLabel('Beige', 'Survival', OPEN)).toBe('Beige - Survival');
  });

  it('appends a locked marker so the centre padlock is not sight-only', () => {
    expect(stageCenterCellLabel('Turquoise', 'Holism', { locked: true, current: false })).toBe(
      'Turquoise - Holism, locked',
    );
  });

  it('appends a current marker for the stage the person is in', () => {
    expect(stageCenterCellLabel('Purple', 'Kinship', { locked: false, current: true })).toBe(
      'Purple - Kinship, current',
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
    expect(drawerStageLabel('Wisdom', 'True Self', { locked: true, current: false })).toBe(
      'Wisdom, True Self, locked',
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
