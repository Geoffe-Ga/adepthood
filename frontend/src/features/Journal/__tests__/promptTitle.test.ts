/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { promptTitleForWeek } from '../promptTitle';

/**
 * The ten APTITUDE positions and the program weeks each one spans, written out
 * by hand so this pins the schedule rather than restating whatever the module
 * computes. Eight stages run three weeks and the two integration stages run
 * six, which is how ten stages fill thirty-six weeks.
 */
const BAND_SPANS: ReadonlyArray<readonly [string, number, number]> = [
  ['Beige', 1, 3],
  ['Purple', 4, 6],
  ['Red', 7, 9],
  ['Blue', 10, 12],
  ['Orange', 13, 15],
  ['Green', 16, 18],
  ['Yellow', 19, 21],
  ['Teal', 22, 24],
  ['Ultraviolet', 25, 30],
  ['Clear Light', 31, 36],
];

const LAST_PROGRAM_WEEK = 36;
const LAST_WEEK_TITLE = 'Clear Light week 6 Prompt #1';
const FIRST_WEEK_TITLE = 'Beige week 1 Prompt #1';

/** Names an earlier table invented to pad a uniform tiling out to 36 weeks. */
const INVENTED_STAGES = ['Turquoise', 'Coral', 'Indigo'];

const everyTitle = (): string[] =>
  Array.from({ length: LAST_PROGRAM_WEEK }, (_, index) => promptTitleForWeek(index + 1));

describe('promptTitleForWeek', () => {
  it.each(BAND_SPANS)('%s opens on program week %i', (band, firstWeek) => {
    expect(promptTitleForWeek(firstWeek)).toBe(`${band} week 1 Prompt #1`);
  });

  it.each(BAND_SPANS)('%s closes on program week %i', (band, firstWeek, lastWeek) => {
    const weekInBand = lastWeek - firstWeek + 1;
    expect(promptTitleForWeek(lastWeek)).toBe(`${band} week ${weekInBand} Prompt #1`);
  });

  it('reaches Clear Light, the tenth stage, in the program’s final weeks', () => {
    expect(promptTitleForWeek(LAST_PROGRAM_WEEK)).toBe(LAST_WEEK_TITLE);
  });

  it('names no stage the APTITUDE ontology does not have', () => {
    const titles = everyTitle().join('\n');
    for (const invented of INVENTED_STAGES) {
      expect(titles).not.toContain(invented);
    }
  });

  it('gives every program week a title', () => {
    expect(everyTitle().filter((title) => title.length > 0)).toHaveLength(LAST_PROGRAM_WEEK);
  });

  it('clamps a week past the end of the program instead of throwing', () => {
    expect(() => promptTitleForWeek(999)).not.toThrow();
    expect(promptTitleForWeek(999)).toBe(LAST_WEEK_TITLE);
  });

  it('clamps a week before the start of the program', () => {
    expect(promptTitleForWeek(0)).toBe(FIRST_WEEK_TITLE);
    expect(promptTitleForWeek(-5)).toBe(FIRST_WEEK_TITLE);
  });

  it('truncates a fractional week onto the week it falls in', () => {
    expect(promptTitleForWeek(8.9)).toBe('Red week 2 Prompt #1');
  });
});
