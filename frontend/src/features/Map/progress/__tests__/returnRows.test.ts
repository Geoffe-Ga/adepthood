import { describe, expect, it } from '@jest/globals';

import { arcRows, returnRows } from '../progressPresentation';

import { chart } from '@/design/tokens';
import {
  passesFixture,
  progressOverviewFixture,
  returnArcsFixture,
} from '@/features/Map/testSupport/progressOverviewFixture';
import { RETURN_WEEK_TITLES } from '@/features/Return/returnCopy';

type Arcs = ReturnType<typeof returnArcsFixture>;

/** `'absent'`: an older server that sends no `return_arcs` at all. */
const overviewWith = (arcs: Arcs | 'absent' = returnArcsFixture(), passes = passesFixture()) => {
  const overview = progressOverviewFixture();
  overview.arc.passes = passes;
  if (arcs !== 'absent') overview.arc.return_arcs = arcs;
  return overview;
};

/** One arc alone, in `state`, reached to `week`. */
const lone = (overrides: Partial<Arcs[number]>) => {
  const [arc] = returnArcsFixture().slice(2);
  return returnRows(overviewWith([{ ...arc!, ...overrides }]))[0]!;
};

const ARC_WEEKS = 36;
const RETURN_WEEKS = 5;

describe('each Metta Return arc as its own ribbon segment (#3746)', () => {
  it('has no rows for an older server, an empty list or the habits ring off', () => {
    expect(returnRows(overviewWith('absent'))).toEqual([]);
    expect(returnRows(overviewWith([]))).toEqual([]);
  });

  it('leaves the pass rows exactly as they were when there are no arcs', () => {
    const rows = arcRows(overviewWith([]));
    expect(rows.map((row) => row.kind)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(arcRows(overviewWith('absent'))).toEqual(rows);
  });

  it('interleaves each arc in time order, after the pass it began inside', () => {
    expect(arcRows(overviewWith()).map((row) => row.row.key)).toEqual([
      'pass-1',
      'return-1',
      'pass-2',
      'return-2',
      'pass-4',
      'return-3',
      'pass-5',
    ]);
  });

  it('puts an arc begun before every pass on top, and one begun the same day after it', () => {
    const early = { ...returnArcsFixture()[0]!, started_on: '2024-12-01' };
    const same = { ...returnArcsFixture()[2]!, started_on: '2026-06-01' };
    expect(arcRows(overviewWith([early, same])).map((row) => row.row.key)).toEqual([
      'return-1',
      'pass-1',
      'pass-2',
      'pass-4',
      'return-2',
      'pass-5',
    ]);
  });

  it('draws five week blocks in the Return colour, named with the Return’s own weeks', () => {
    const [row] = returnRows(overviewWith());
    expect(row!.blocks).toHaveLength(RETURN_WEEKS);
    expect(row!.blocks.map((block) => block.weeks)).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(row!.blocks.map((block) => block.color))).toEqual(new Set([chart.returnArc]));
    expect(row!.blocks.map((block) => block.label)).toEqual(
      RETURN_WEEK_TITLES.map((title, index) => `Week ${index + 1} · ${title}`),
    );
  });

  it('measures every row against the pass rows’ weeks, so a Return week is a pass week wide', () => {
    for (const row of returnRows(overviewWith())) expect(row.scaleWeeks).toBe(ARC_WEEKS);
  });

  it('draws an arc set down early as far as it reached, then the unfilled track', () => {
    const [left] = returnRows(overviewWith());
    expect(left!.label).toBe('Metta Return · began 10 Feb · left at week 3');
    expect(left!.drawnWeeks).toBe(3);
    expect(left!.currentWeek).toBeUndefined();
    expect(left!.weekNotes).toEqual(['lived', 'lived', 'left here', 'not begun', 'not begun']);
    expect(left!.summary).toBe(
      'Metta Return, began 10 February 2025. Left on 24 February 2025 in week 3 of 5: A face you barely know.',
    );
  });

  it('draws a completed arc across all five weeks, ending 35 days on when never left', () => {
    const complete = returnRows(overviewWith())[1]!;
    expect(complete.label).toBe('Metta Return · began 7 Jul · completed');
    expect(complete.drawnWeeks).toBe(RETURN_WEEKS);
    expect(complete.currentWeek).toBeUndefined();
    expect(complete.weekNotes).toEqual(Array(RETURN_WEEKS).fill('lived'));
    expect(complete.summary).toBe(
      'Metta Return, began 7 July 2025. Completed all 5 weeks, ending 11 August 2025.',
    );
  });

  it('ends a completed arc on the day it was set down, when it was', () => {
    const row = lone({ state: 'left', completed: true, reached_week: 5, ended_on: '2026-09-20' });
    expect(row.label).toBe('Metta Return · began 3 Aug · completed');
    expect(row.drawnWeeks).toBe(RETURN_WEEKS);
    expect(row.summary).toBe(
      'Metta Return, began 3 August 2026. Completed all 5 weeks, ending 20 September 2026.',
    );
  });

  it('draws the active arc through its current week, with the week line', () => {
    const active = returnRows(overviewWith())[2]!;
    expect(active.label).toBe('Metta Return · began 3 Aug · week 3 of 5');
    expect(active.drawnWeeks).toBe(3);
    expect(active.currentWeek).toBe(3);
    expect(active.weekNotes).toEqual(['lived', 'lived', 'this week', 'not begun', 'not begun']);
    expect(active.summary).toBe(
      'Metta Return, began 3 August 2026. In week 3 of 5: A face you barely know.',
    );
  });

  it('shows a paused arc as paused, with no week line', () => {
    const paused = lone({ state: 'paused', reached_week: 2 });
    expect(paused.label).toBe('Metta Return · began 3 Aug · paused');
    expect(paused.drawnWeeks).toBe(2);
    expect(paused.currentWeek).toBeUndefined();
    expect(paused.weekNotes).toEqual([
      'lived',
      'paused here',
      'not begun',
      'not begun',
      'not begun',
    ]);
    expect(paused.summary).toBe(
      'Metta Return, began 3 August 2026. Paused in week 2 of 5: Someone who has held you.',
    );
  });

  it('says a left arc’s week without a day when the server sends none', () => {
    const row = lone({ state: 'left', reached_week: 4, ended_on: null });
    expect(row.label).toBe('Metta Return · began 3 Aug · left at week 4');
    expect(row.summary).toBe(
      'Metta Return, began 3 August 2026. Left in week 4 of 5: Meeting a hard heart with softness.',
    );
  });

  it('names a week past the known five by its number alone', () => {
    const row = lone({ weeks_total: 6, reached_week: 6 });
    expect(row.blocks.at(-1)!.label).toBe('Week 6');
    expect(row.summary).toBe('Metta Return, began 3 August 2026. In week 6 of 6.');
  });

  it('numbers the rows oldest first, after the single ribbon when no pass is recorded', () => {
    const rows = arcRows(overviewWith(returnArcsFixture(), []));
    expect(rows.map((row) => row.row.key)).toEqual(['return-1', 'return-2', 'return-3']);
  });
});
