/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { STAGE_ORDER } from '../../design/tokens';
import { SPIRAL_DYNAMICS_COLORS } from '../../features/Practice/data/colorPalette';
import { STAGE_DURATIONS_DAYS, STAGES_PER_SECTION } from '../program';

import { readBackendSource } from '@/testing/backendSource';

/**
 * APTITUDE is one set of ten developmental positions, joined on colour, and
 * both stacks have to agree on which ten and how long each lasts. The backend
 * owns the canonical table (`domain/frequencies.py`, `domain/constants.py`);
 * every frontend list of stages is a mirror of it.
 *
 * A mirror is only honest while something fails when it drifts. A hand-copied
 * table with a "keep in sync" comment is how three stages the ontology has
 * never had — and a missing tenth — reached users' journal titles, so this
 * reads the Python and fails on the next divergence instead.
 *
 * The read goes through `@/testing/backendSource`, which is what makes backend
 * CI run this file on the change that would break it.
 */
const FREQUENCIES = ['src', 'domain', 'frequencies.py'];
const CONSTANTS = ['src', 'domain', 'constants.py'];

/** The `FREQUENCY_COLORS = MappingProxyType({...})` literal, up to its close. */
const FREQUENCY_COLORS_BLOCK = /FREQUENCY_COLORS[^=]*=\s*MappingProxyType\(\s*\{([\s\S]*?)\}/;
/** One `Frequency.F3: "Red",` entry inside that literal. */
const FREQUENCY_COLOR_ENTRY = /Frequency\.F(\d+):\s*"([^"]+)"/g;
/** The `STAGE_DURATIONS_DAYS: tuple[int, ...] = (21, ...)` literal. */
const STAGE_DURATIONS = /STAGE_DURATIONS_DAYS[^=]*=\s*\(([\d,\s]+)\)/;
/** The `STAGES_PER_SECTION = 3` assignment (issue #2866). */
const STAGES_PER_SECTION_LITERAL = /^STAGES_PER_SECTION\s*=\s*(\d+)\s*$/m;

function capture(pattern: RegExp, file: string[], what: string): string {
  const group = pattern.exec(readBackendSource(...file))?.[1];
  if (group === undefined) {
    throw new Error(`${what} not found in backend/${file.join('/')}`);
  }
  return group;
}

function backendStageColors(): string[] {
  const block = capture(FREQUENCY_COLORS_BLOCK, FREQUENCIES, 'the FREQUENCY_COLORS literal');
  return [...block.matchAll(FREQUENCY_COLOR_ENTRY)]
    .map(([, position = '', colour = '']) => ({ position: Number(position), colour }))
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.colour);
}

function backendStagesPerSection(): number {
  return Number(capture(STAGES_PER_SECTION_LITERAL, CONSTANTS, 'the STAGES_PER_SECTION literal'));
}

function backendStageDurationDays(): number[] {
  const literal = capture(STAGE_DURATIONS, CONSTANTS, 'the STAGE_DURATIONS_DAYS literal');
  return literal
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
}

describe('the frontend mirrors of the APTITUDE ten', () => {
  it('reads a ten-position colour table out of the backend', () => {
    // Guards the parse itself: a regex that silently matched nothing would
    // make every comparison below vacuously true.
    expect(backendStageColors()).toHaveLength(STAGE_ORDER.length);
    expect(backendStageDurationDays()).toHaveLength(STAGE_ORDER.length);
  });

  it('lists the same stages, in the same order, as the design tokens', () => {
    expect([...STAGE_ORDER]).toEqual(backendStageColors());
  });

  it('lists the same stages, in the same order, as the practice palette', () => {
    expect([...SPIRAL_DYNAMICS_COLORS]).toEqual(backendStageColors());
  });

  it('schedules each stage for the same number of days as the backend', () => {
    expect([...STAGE_DURATIONS_DAYS]).toEqual(backendStageDurationDays());
  });

  it('groups stages into sections the same way the backend does', () => {
    // Guards the parse before the comparison, the same way the colour table
    // above does: a regex that matched nothing would read NaN and compare
    // vacuously. The frontend derives each section's colour name from this
    // number (`reflectionTitle`) while the backend derives the section's week
    // span from it, so a divergence would name a section after the wrong turn
    // of the Wavelength rather than fail anywhere visible.
    expect(Number.isInteger(backendStagesPerSection())).toBe(true);
    expect(STAGES_PER_SECTION).toBe(backendStagesPerSection());
  });

  it('leaves the final stage outside every section, in both stacks', () => {
    expect(STAGE_ORDER.length % STAGES_PER_SECTION).not.toBe(0);
  });
});
