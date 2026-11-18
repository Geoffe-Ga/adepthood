import { describe, expect, it } from '@jest/globals';

import { passRows } from '../progressPresentation';

import {
  passesFixture,
  progressOverviewFixture,
} from '@/features/Map/testSupport/progressOverviewFixture';

const withPasses = (passes = passesFixture()) => {
  const overview = progressOverviewFixture();
  overview.arc.passes = passes;
  return overview;
};

const ARC_WEEKS = 36;

describe('one ribbon per pass (#3727)', () => {
  it('has no rows for an older server or with the habits ring off, so the single ribbon stays', () => {
    expect(passRows(progressOverviewFixture())).toEqual([]);
    expect(passRows(withPasses([]))).toEqual([]);
  });

  it('keeps the passes oldest first, one row each', () => {
    expect(passRows(withPasses()).map((row) => row.key)).toEqual([
      'pass-1',
      'pass-2',
      'pass-4',
      'pass-5',
    ]);
  });

  it('draws an ended partial pass only as far as it reached, the rest an unfilled track', () => {
    const [partial] = passRows(withPasses());
    expect(partial!.label).toBe('Pass 1 · began 5 Jan · reached stage 7, week 21');
    expect(partial!.drawnWeeks).toBe(21);
    expect(partial!.currentWeek).toBeUndefined();
    expect(partial!.blocks).toHaveLength(10);
  });

  it('draws a completed pass across all 36 weeks', () => {
    const completed = passRows(withPasses())[1]!;
    expect(completed.label).toBe('Pass 2 · began 1 Jun · completed');
    expect(completed.drawnWeeks).toBe(ARC_WEEKS);
    expect(completed.currentWeek).toBeUndefined();
  });

  it('draws the live pass in full with its current week, ending the day before a held pass', () => {
    const live = passRows(withPasses())[2]!;
    expect(live.label).toBe('Pass 4 · began 1 Jun · in progress — week 8, until 30 Aug');
    expect(live.drawnWeeks).toBe(ARC_WEEKS);
    expect(live.currentWeek).toBe(8);
    const alone = passesFixture().slice(0, 3);
    expect(passRows(withPasses(alone))[2]!.label).toBe(
      'Pass 4 · began 1 Jun · in progress — week 8',
    );
  });

  it('draws a pending pass as the empty track only, saying when it begins', () => {
    const pending = passRows(withPasses())[3]!;
    expect(pending.label).toBe('Pass 5 · begins 31 Aug');
    expect(pending.drawnWeeks).toBe(0);
    expect(pending.currentWeek).toBeUndefined();
    expect(pending.markers).toEqual([]);
    expect(pending.summary).toBe('Pass 5 begins 31 August 2026, in 12 days.');
  });

  it('numbers each marker by its program number on its own week, hollow when locked again', () => {
    const live = passRows(withPasses())[2]!;
    expect(live.markers).toEqual([
      {
        week: 1,
        number: 1,
        hollow: false,
        label: 'Habit 1 · Morning pages',
        unlocked: '1 Jun',
      },
      {
        week: 1,
        number: 2,
        hollow: false,
        label: 'Habit 2 · Evening walk',
        unlocked: '1 Jun',
      },
      {
        week: 8,
        number: 5,
        hollow: true,
        label: 'Habit 5 · Meditation',
        unlocked: '20 Jul',
        note: 'locked now',
      },
    ]);
    const ended = passRows(withPasses())[0]!;
    expect(ended.markers[2]!.note).toBe('locked by the pass’s end');
  });

  it('says each pass as one sentence for screen readers', () => {
    const [partial, , live] = passRows(withPasses());
    expect(partial!.summary).toBe(
      'Pass 1, began 5 January 2025. Reached stage 7, week 21 of 36. ' +
        'Habits unlocked: habit 1, Morning pages, week 1; habit 2, Evening walk, week 4; ' +
        'habit 3, Meditation, week 8, locked by the pass’s end.',
    );
    expect(live!.summary).toMatch(/^Pass 4, began 1 June 2026\. In progress, week 8 of 36\./);
    const bare = passesFixture()[1]!;
    bare.markers = [];
    expect(passRows(withPasses([bare]))[0]!.summary).toBe(
      'Began 1 June 2025. Completed all 36 weeks. No habits unlocked.',
    );
  });

  it('does not number a lone pass: a first-time reader sees today’s ribbon plus numbers', () => {
    const live = passesFixture()[2]!;
    const [only] = passRows(withPasses([live]));
    expect(only!.label).toBe('Week 8 · Red');
    expect(only!.summary).toMatch(/^Began 1 June 2026\. In progress, week 8 of 36\./);
    const ended = passesFixture()[0]!;
    expect(passRows(withPasses([ended]))[0]!.label).toBe('Began 5 Jan · reached stage 7, week 21');
    const pending = passesFixture()[3]!;
    expect(passRows(withPasses([pending]))[0]!.label).toBe('Begins 31 Aug');
  });

  it('says a pending pass that starts tomorrow in the singular', () => {
    const pending = { ...passesFixture()[3]!, days_until_start: 1 };
    expect(passRows(withPasses([pending]))[0]!.summary).toBe('Begins 31 August 2026, in 1 day.');
  });
});
