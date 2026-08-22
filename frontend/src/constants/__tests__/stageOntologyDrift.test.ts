/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect } from '@jest/globals';

import { STAGE_ORDER } from '../../design/tokens';
import { SPIRAL_DYNAMICS_COLORS } from '../../features/Practice/data/colorPalette';
import { STAGE_DURATIONS_DAYS } from '../program';

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
 */
const BACKEND_SRC = path.resolve(__dirname, '..', '..', '..', '..', 'backend', 'src');
const FREQUENCIES = path.join(BACKEND_SRC, 'domain', 'frequencies.py');
const CONSTANTS = path.join(BACKEND_SRC, 'domain', 'constants.py');

/** The `FREQUENCY_COLORS = MappingProxyType({...})` literal, up to its close. */
const FREQUENCY_COLORS_BLOCK = /FREQUENCY_COLORS[^=]*=\s*MappingProxyType\(\s*\{([\s\S]*?)\}/;
/** One `Frequency.F3: "Red",` entry inside that literal. */
const FREQUENCY_COLOR_ENTRY = /Frequency\.F(\d+):\s*"([^"]+)"/g;
/** The `STAGE_DURATIONS_DAYS: tuple[int, ...] = (21, ...)` literal. */
const STAGE_DURATIONS = /STAGE_DURATIONS_DAYS[^=]*=\s*\(([\d,\s]+)\)/;

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function capture(pattern: RegExp, file: string, what: string): string {
  const group = pattern.exec(read(file))?.[1];
  if (group === undefined) {
    throw new Error(`${what} not found in ${file}`);
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
});
