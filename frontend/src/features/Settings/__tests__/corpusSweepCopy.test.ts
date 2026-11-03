/* eslint-env jest */
/* global describe, test, expect */
import {
  CORPUS_SORT_FAILED,
  CORPUS_SORT_STOP_LINES,
  CORPUS_SWEEP_COPY_ENTRIES,
  CORPUS_SWEEP_NOTHING_PENDING,
  corpusSortOutcomeLine,
  corpusSortProgressLine,
  corpusSweepActionLabel,
  corpusSweepPendingLine,
  corpusSweepRowDescription,
} from '../corpusSweepCopy';

import type { CorpusSortRun } from '@/api';
import { SORT_RUN_LANES, SORT_RUN_STATES, SORT_STOP_REASONS } from '@/api/schemas';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { readBackendSource } from '@/testing/backendSource';

/**
 * What the sort-the-rest screen may say (#3499), held to what a sort does.
 *
 * Sorting is free (#3495), so the copy carries no money language at all -- not
 * a zero, not a credit, not a price. One press sorts everything in the
 * background, so the copy speaks of a sort that is going and then of how it
 * ended. The run's vocabulary is read back out of the backend model that
 * writes it, so the screen cannot meet a stop reason it has no line for, nor
 * keep a line for a reason the server no longer sends.
 */

const RUN_MODEL = ['src', 'models', 'corpus_sort_run.py'];

/** The string values of one ``enum.StrEnum`` class in a Python module, in order. */
function pythonEnumValues(source: string, className: string): string[] {
  const start = source.indexOf(`class ${className}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  const body = rest.slice(0, end === -1 ? undefined : end).join('\n');
  return [...body.matchAll(/^ {4}[A-Z_]+ = "([a-z_]+)"$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** A run with sensible defaults, any field overridden. */
function run(overrides: Partial<CorpusSortRun> = {}): CorpusSortRun {
  return {
    id: 1,
    lane: 'app_provider',
    state: 'completed',
    stop_reason: null,
    entries_total: 9,
    entries_offered: 9,
    entries_sorted: 9,
    started_at: '2026-11-03T10:00:00Z',
    finished_at: '2026-11-03T10:01:00Z',
    ...overrides,
  };
}

/** Every sample of a templated line, alongside the fixed ones. */
function everyLine(): string[] {
  return [
    ...CORPUS_SWEEP_COPY_ENTRIES,
    corpusSweepRowDescription(1),
    corpusSweepRowDescription(412),
    corpusSweepPendingLine(1),
    corpusSweepPendingLine(412),
    corpusSweepActionLabel(1),
    corpusSweepActionLabel(412),
    corpusSortProgressLine(run({ state: 'running', entries_offered: 0, finished_at: null })),
    corpusSortProgressLine(run({ state: 'running', entries_offered: 3, finished_at: null })),
    corpusSortProgressLine(
      run({ state: 'running', entries_total: 0, entries_offered: 0, finished_at: null }),
    ),
    corpusSortOutcomeLine(run({ entries_sorted: 0, entries_offered: 0, entries_total: 0 }), 0),
    corpusSortOutcomeLine(run({ entries_sorted: 1 }), 0),
    corpusSortOutcomeLine(run({ entries_sorted: 40 }), 9),
    corpusSortOutcomeLine(run({ entries_sorted: 0 }), 9),
    corpusSortOutcomeLine(run({ state: 'failed', entries_sorted: 2 }), 7),
    ...SORT_STOP_REASONS.map((reason) =>
      corpusSortOutcomeLine(run({ state: 'stopped', stop_reason: reason, entries_sorted: 3 }), 6),
    ),
  ];
}

describe('the sort-the-rest copy, against the backend', () => {
  const source = readBackendSource(...RUN_MODEL);

  test('knows exactly the stop reasons a run can carry, and has a line for each', () => {
    const reasons = pythonEnumValues(source, 'SortStopReason');

    expect(reasons).toEqual([...SORT_STOP_REASONS]);
    expect(Object.keys(CORPUS_SORT_STOP_LINES).sort()).toEqual([...reasons].sort());
  });

  test('knows exactly the states and lanes a run can be in', () => {
    expect(pythonEnumValues(source, 'SortRunState')).toEqual([...SORT_RUN_STATES]);
    expect(pythonEnumValues(source, 'SortLane')).toEqual([...SORT_RUN_LANES]);
  });
});

describe('the sort-the-rest copy', () => {
  test('carries no price and no money language, because sorting is free', () => {
    for (const line of everyLine()) {
      expect(line).not.toMatch(/credit|token|price|cost|charge|pay|\$/i);
    }
  });

  test('never shows a bare zero', () => {
    for (const line of everyLine()) {
      expect(line).not.toMatch(/\b0\b/);
    }
  });

  test('never ranks, shames, or pressures', () => {
    for (const line of everyLine()) {
      expect(ranksOrShames(line)).toBe(false);
    }
  });

  test('counts one entry in the singular and many in the plural', () => {
    expect(corpusSweepRowDescription(1)).toBe('1 entry still unsorted');
    expect(corpusSweepRowDescription(412)).toBe('412 entries still unsorted');
    expect(corpusSweepPendingLine(1)).toBe("1 of your entries hasn't been sorted yet.");
    expect(corpusSweepPendingLine(412)).toBe("412 of your entries haven't been sorted yet.");
  });

  test('offers one press for everything waiting, with no per-press bound', () => {
    expect(corpusSweepActionLabel(412)).toBe('Sort all 412 entries');
    expect(corpusSweepActionLabel(1)).toBe('Sort 1 entry');
  });

  test('a running sort says how far it has got, and names its size before it starts', () => {
    expect(
      corpusSortProgressLine(run({ state: 'running', entries_offered: 12, finished_at: null })),
    ).toBe('Sorting in the background: 12 of 12 looked at so far.');
    expect(
      corpusSortProgressLine(
        run({ state: 'running', entries_total: 412, entries_offered: 40, finished_at: null }),
      ),
    ).toBe('Sorting in the background: 40 of 412 looked at so far.');
    expect(
      corpusSortProgressLine(
        run({ state: 'running', entries_total: 412, entries_offered: 0, finished_at: null }),
      ),
    ).toBe('Sorting 412 entries in the background.');
  });

  test('a sort that sorted nothing with a remainder does not read as success', () => {
    const line = corpusSortOutcomeLine(run({ entries_sorted: 0 }), 12);

    expect(line).toMatch(/^Nothing was sorted/);
    expect(line).toMatch(/12/);
    expect(line).not.toMatch(/done|all set|finished|sorted now/i);
  });

  test('a sort that left a remainder says how much is still waiting', () => {
    expect(corpusSortOutcomeLine(run({ entries_sorted: 40 }), 372)).toBe(
      'Sorted 40 entries. 372 entries still unsorted.',
    );
  });

  test('a sort that cleared the backlog says nothing is left', () => {
    expect(corpusSortOutcomeLine(run({ entries_sorted: 1 }), 0)).toBe(
      'Sorted 1 entry. Nothing is left unsorted.',
    );
    expect(corpusSortOutcomeLine(run({ entries_sorted: 0, entries_total: 0 }), 0)).toBe(
      CORPUS_SWEEP_NOTHING_PENDING,
    );
  });

  test('a stopped sort leads with why, then what it sorted first and what is left', () => {
    const line = corpusSortOutcomeLine(
      run({ state: 'stopped', stop_reason: 'vault_unavailable', entries_sorted: 5 }),
      9,
    );

    expect(line).toBe(
      `${CORPUS_SORT_STOP_LINES.vault_unavailable} It sorted 5 entries first. ` +
        '9 entries still unsorted.',
    );
  });

  test('a sort that failed says so, and that what it sorted is kept', () => {
    expect(corpusSortOutcomeLine(run({ state: 'failed', entries_sorted: 2 }), 7)).toBe(
      `${CORPUS_SORT_FAILED} 7 entries still unsorted.`,
    );
  });
});
