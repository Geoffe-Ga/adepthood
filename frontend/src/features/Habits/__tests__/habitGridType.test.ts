import { describe, it, expect } from '@jest/globals';

import { INTERACTIVE_TEXT_MIN } from '../../../design/tokens';
import { HABIT_GRID_FACES, HABIT_GRID_INTERACTIVE_ROLES, habitGridType } from '../habitGridType';

/** Widths spanning every breakpoint of the type ramp, including the narrowest phone. */
const SWEEP_WIDTHS = [320, 390, 600, 900, 1280];

describe('habitGridType (#2961)', () => {
  it('pins every role on a phone', () => {
    expect(habitGridType(390)).toEqual({
      name: 14,
      streak: 13,
      lockGlyph: 14,
      lockedName: 14,
      lockedSubtitle: 13,
      tooltip: 13,
      iconInline: 20,
      iconStacked: 34,
      paginationLabel: 14,
      paginationControl: 16,
    });
  });

  it('pins every role on a desktop', () => {
    expect(habitGridType(1280)).toEqual({
      name: 17,
      streak: 15,
      lockGlyph: 17,
      lockedName: 17,
      lockedSubtitle: 15,
      tooltip: 15,
      iconInline: 24,
      iconStacked: 40,
      paginationLabel: 17,
      paginationControl: 16,
    });
  });

  it('names the pager controls as the grid’s interactive text', () => {
    expect(HABIT_GRID_INTERACTIVE_ROLES).toEqual(['paginationControl']);
  });

  it.each(SWEEP_WIDTHS)('keeps interactive text at the floor at width %i', (width) => {
    const sizes = habitGridType(width);
    for (const role of HABIT_GRID_INTERACTIVE_ROLES) {
      expect(sizes[role]).toBeGreaterThanOrEqual(INTERACTIVE_TEXT_MIN);
    }
  });

  it('maps content roles to their faces', () => {
    expect(HABIT_GRID_FACES).toEqual({
      name: 'label',
      streak: 'caption',
      lockGlyph: 'label',
      lockedName: 'label',
      lockedSubtitle: 'caption',
      tooltip: 'caption',
      iconInline: 'heading',
      iconStacked: 'display',
      paginationLabel: 'label',
    });
  });
});
