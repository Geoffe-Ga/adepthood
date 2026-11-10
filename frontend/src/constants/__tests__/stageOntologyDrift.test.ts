/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { STAGE_ORDER } from '../../design/tokens';
import { SPIRAL_DYNAMICS_COLORS } from '../../features/Practice/data/colorPalette';
import {
  PROGRAM_START_BACKDATE_WINDOW_DAYS,
  STAGE_DURATIONS_DAYS,
  STAGES_PER_SECTION,
} from '../program';

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
/** The generated artifact the `coursestage` rows are seeded from. */
const CORRESPONDENCE_ARTIFACT = ['src', 'curriculum', 'stage_correspondence.json'];

/** The `FREQUENCY_COLORS = MappingProxyType({...})` literal, up to its close. */
const FREQUENCY_COLORS_BLOCK = /FREQUENCY_COLORS[^=]*=\s*MappingProxyType\(\s*\{([\s\S]*?)\}/;
/** One `Frequency.F3: "Red",` entry inside that literal. */
const FREQUENCY_COLOR_ENTRY = /Frequency\.F(\d+):\s*"([^"]+)"/g;
/** The `STAGE_DURATIONS_DAYS: tuple[int, ...] = (21, ...)` literal. */
const STAGE_DURATIONS = /STAGE_DURATIONS_DAYS[^=]*=\s*\(([\d,\s]+)\)/;
/** The `STAGES_PER_SECTION = 3` assignment (issue #2866). */
const STAGES_PER_SECTION_LITERAL = /^STAGES_PER_SECTION\s*=\s*(\d+)\s*$/m;
/**
 * The `PROGRAM_START_BACKDATE_WINDOW_DAYS = ...` assignment (#3097, #3708). The
 * right-hand side must be one bare word -- an integer literal or a name -- so an
 * expression such as `TOTAL_PROGRAM_DAYS * 2` fails the match rather than being
 * half-read.
 */
const BACKDATE_WINDOW_ASSIGNMENT = /^PROGRAM_START_BACKDATE_WINDOW_DAYS\s*=\s*(\w+)\s*$/m;
/** The one alias the window may name: the whole program, in days. */
const TOTAL_PROGRAM_DAYS_ALIAS = 'TOTAL_PROGRAM_DAYS';
/** The alias is trusted only while it is defined as the sum of the stage durations. */
const TOTAL_PROGRAM_DAYS_AS_SUM = /^TOTAL_PROGRAM_DAYS\s*=\s*sum\(STAGE_DURATIONS_DAYS\)\s*$/m;
const INTEGER_LITERAL = /^\d+$/;

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

/** One stage's colour as `stage_correspondence.json` declares it. */
interface ArtifactStage {
  stage_number: number;
  spiral_dynamics_color: string;
}

/** The artifact's colour names in stage-number order. */
function artifactStageColors(): string[] {
  const { stages } = JSON.parse(readBackendSource(...CORRESPONDENCE_ARTIFACT)) as {
    stages: ArtifactStage[];
  };
  return [...stages]
    .sort((left, right) => left.stage_number - right.stage_number)
    .map((stage) => stage.spiral_dynamics_color);
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

/**
 * The backend's backdate window in days. Accepts an integer literal, or the
 * `TOTAL_PROGRAM_DAYS` alias -- resolved through the parsed stage-duration
 * tuple, and only while that alias is still `sum(STAGE_DURATIONS_DAYS)`. Any
 * other shape throws, so a change the parse does not understand fails loudly
 * instead of comparing against a guess.
 */
function backendBackdateWindowDays(): number {
  const rhs = capture(
    BACKDATE_WINDOW_ASSIGNMENT,
    CONSTANTS,
    'the PROGRAM_START_BACKDATE_WINDOW_DAYS assignment',
  );
  if (INTEGER_LITERAL.test(rhs)) return Number(rhs);
  if (rhs !== TOTAL_PROGRAM_DAYS_ALIAS) {
    throw new Error(`PROGRAM_START_BACKDATE_WINDOW_DAYS = ${rhs} is not a shape this pin reads`);
  }
  if (!TOTAL_PROGRAM_DAYS_AS_SUM.test(readBackendSource(...CONSTANTS))) {
    throw new Error('TOTAL_PROGRAM_DAYS is no longer sum(STAGE_DURATIONS_DAYS)');
  }
  return backendStageDurationDays().reduce((total, days) => total + days, 0);
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

  it('pins the offline colour fallback to the stage-correspondence artifact (#2666)', () => {
    // STAGE_ORDER is the one static stage -> colour-name list the frontend
    // keeps, read only when no served row is in hand. The artifact seeds the
    // `coursestage` rows `GET /stages` serves, so pinning the fallback to it
    // means the offline answer can never disagree with the served one.
    expect(artifactStageColors()).toHaveLength(STAGE_ORDER.length);
    expect([...STAGE_ORDER]).toEqual(artifactStageColors());
  });

  it('keeps the practice palette on the one fallback list rather than a copy of it', () => {
    expect(SPIRAL_DYNAMICS_COLORS).toBe(STAGE_ORDER);
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

  it('bounds the start-date backdate window the same way the backend does', () => {
    // Each stack used to pin this only to its own TOTAL_PROGRAM_DAYS, so a
    // change on one side alone passed both suites while the offline picker
    // floor and the server's refusal disagreed (#3708). The integer guard runs
    // first: a parse that read nothing would otherwise compare NaN vacuously.
    const backend = backendBackdateWindowDays();
    expect(Number.isInteger(backend)).toBe(true);
    expect(backend).toBeGreaterThan(0);
    expect(PROGRAM_START_BACKDATE_WINDOW_DAYS).toBe(backend);
  });

  it('leaves the final stage outside every section, in both stacks', () => {
    expect(STAGE_ORDER.length % STAGES_PER_SECTION).not.toBe(0);
  });
});
