import { describe, expect, it } from '@jest/globals';

import {
  arcSummary,
  birthMarkers,
  carryovers,
  cycleCaption,
  cycleLabels,
  cycleRows,
  energyColumns,
  energySummary,
  ribbonBlocks,
  rhythmCaption,
  rhythmEnd,
  rhythmPoints,
  rhythmSwatches,
  rhythmTicks,
  rhythmVisible,
  RHYTHM_MIN_DAYS,
  youAreHere,
} from '../progressPresentation';

import { STAGE_COLORS } from '@/design/tokens';
import { progressOverviewFixture } from '@/features/Map/testSupport/progressOverviewFixture';

describe('the arc', () => {
  it('draws ten labelled stage blocks sized by weeks', () => {
    const blocks = ribbonBlocks(progressOverviewFixture());
    expect(blocks).toHaveLength(10);
    expect(blocks[0]).toEqual({ label: 'Beige · Aspect 1', weeks: 3, color: STAGE_COLORS.Beige });
    expect(blocks.reduce((sum, block) => sum + block.weeks, 0)).toBe(36);
  });

  it('marks births on their weeks and lists carryovers as brought with you', () => {
    const overview = progressOverviewFixture();
    expect(birthMarkers(overview)).toEqual([
      { week: 1, label: 'Morning pages began' },
      { week: 10, label: 'Evening walk began' },
    ]);
    expect(carryovers(overview)).toEqual(['Water']);
  });

  it('names where you are, or nothing without an anchor', () => {
    expect(youAreHere(progressOverviewFixture())).toBe('Week 23 · Yellow');
    const unknown = progressOverviewFixture();
    unknown.arc.current_week = null;
    expect(youAreHere(unknown)).toBeNull();
    expect(arcSummary(progressOverviewFixture())).toBe(
      'The 36-week arc in ten stages. You are in week 23 · yellow. 2 habits began along it.',
    );
    expect(arcSummary(unknown)).toBe('The 36-week arc in ten stages. 2 habits began along it.');
  });
});

describe('the rhythm', () => {
  it('stays words until four weeks of days', () => {
    const young = progressOverviewFixture();
    young.rhythm.days = young.rhythm.days.slice(0, RHYTHM_MIN_DAYS - 1);
    expect(rhythmVisible(young)).toBe(false);
    young.rhythm.days = progressOverviewFixture().rhythm.days.slice(0, RHYTHM_MIN_DAYS);
    expect(rhythmVisible(young)).toBe(true);
  });

  it('plots percentages with month ticks, stage swatches and a labelled end', () => {
    const overview = progressOverviewFixture();
    overview.arc.stages[6]!.opens_on = '2026-10-05';
    const points = rhythmPoints(overview);
    expect(points[0]).toEqual({ label: '29 Aug', value: 40, stateLabel: '2 of 3 that day' });
    expect(rhythmTicks(overview).map((tick) => tick.label)).toEqual(['Aug', 'Sept', 'Oct']);
    expect(rhythmSwatches(overview)).toEqual([
      { index: 37, label: 'Yellow', color: STAGE_COLORS.Yellow },
    ]);
    expect(rhythmEnd(overview)).toMatch(/^Now \d+% over the last 14 days$/);
    expect(
      rhythmEnd(progressOverviewFixture({ rhythm: { ...overview.rhythm, days: [] } })),
    ).toBeNull();
  });

  it('prefers the served caption and otherwise words the three facts without a phase name', () => {
    expect(rhythmCaption(progressOverviewFixture({ observations: ['Served caption.'] }))).toBe(
      'Served caption.',
    );
    expect(rhythmCaption(progressOverviewFixture({ observations: [] }))).toBeNull();
    expect(rhythmCaption(progressOverviewFixture())).toBe(
      'Your fullest fortnight was late June. You rested from 3 August to 24 August. You have been rising since 14 September.',
    );
    const quiet = progressOverviewFixture();
    quiet.rhythm = {
      ...quiet.rhythm,
      fullest_fortnight_ending: '2026-06-05',
      longest_rest: null,
      rising_since: null,
    };
    expect(rhythmCaption(quiet)).toBe('Your fullest fortnight was early June.');
    quiet.rhythm.fullest_fortnight_ending = '2026-06-15';
    expect(rhythmCaption(quiet)).toBe('Your fullest fortnight was mid June.');
    quiet.rhythm.fullest_fortnight_ending = null;
    expect(rhythmCaption(quiet)).toBeNull();
  });
});

describe('cycles and energy', () => {
  it('pairs each stage previous cycle with this one, without ranking', () => {
    const overview = progressOverviewFixture();
    expect(cycleRows(overview)).toEqual([
      { label: 'Beige', from: 0.4, to: 0.7 },
      { label: 'Purple', from: 0.8, to: 0.6 },
    ]);
    expect(cycleLabels(overview)).toEqual({ from: 'Cycle 1', to: 'Cycle 2' });
    expect(cycleCaption(overview)).toContain('Either direction is part of the shape.');
    overview.cycles = [
      { stage_number: 3, rates: [] },
      { stage_number: 4, rates: [{ cycle: 2, rate: 0.5, scheduled_days: 2, met_days: 1 }] },
    ];
    expect(cycleRows(overview)).toEqual([{ label: 'Blue', from: null, to: 0.5 }]);
  });

  it('splits each week of net energy above and below zero', () => {
    const overview = progressOverviewFixture();
    const columns = energyColumns(overview);
    expect(columns[0]).toEqual({ label: 'Week of 10 Aug', segments: [4, 0] });
    expect(columns[2]).toEqual({ label: 'Week of 24 Aug', segments: [0, -2] });
    expect(energySummary(overview)).toBe(
      'Net energy per week for 12 weeks, sum(return - cost) over completions. The latest week is 6.',
    );
  });
});
