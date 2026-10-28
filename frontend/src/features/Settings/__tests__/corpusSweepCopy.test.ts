/* eslint-env jest */
/* global describe, test, expect */
import {
  CORPUS_SWEEP_COPY_ENTRIES,
  CORPUS_SWEEP_PASS_ENTRY_LIMIT,
  corpusSweepActionLabel,
  corpusSweepOutcomeLine,
  corpusSweepPendingLine,
  corpusSweepRowDescription,
} from '../corpusSweepCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { readBackendSource } from '@/testing/backendSource';

/**
 * What the sort-the-rest screen may say (#3499), held to what the sweep does.
 *
 * Sorting is free (#3495), so the copy carries no money language at all -- not
 * a zero, not a credit, not a price. The pass bound it quotes is read back out
 * of the backend that enforces it, so the button cannot promise forty while
 * the server sorts some other number.
 */

const BACKFILL_MODULE = ['src', 'services', 'corpus_backfill.py'];
const CEILING_CONSTANT = /^BACKFILL_ENTRY_CEILING:\s*Final\[int]\s*=\s*(\d+)$/m;

/** Every sample of a templated line, alongside the fixed ones. */
function everyLine(): string[] {
  return [
    ...CORPUS_SWEEP_COPY_ENTRIES,
    corpusSweepRowDescription(1),
    corpusSweepRowDescription(412),
    corpusSweepPendingLine(1),
    corpusSweepPendingLine(412),
    corpusSweepActionLabel(3),
    corpusSweepActionLabel(412),
    corpusSweepOutcomeLine({ entries_pending: 0, entries_sorted: 0, entries_remaining: 0 }),
    corpusSweepOutcomeLine({ entries_pending: 0, entries_sorted: 1, entries_remaining: 0 }),
    corpusSweepOutcomeLine({ entries_pending: 9, entries_sorted: 40, entries_remaining: 9 }),
    corpusSweepOutcomeLine({ entries_pending: 9, entries_sorted: 0, entries_remaining: 9 }),
  ];
}

describe('the sort-the-rest copy, against the backend', () => {
  test('quotes the pass bound the sweep actually enforces', () => {
    const match = CEILING_CONSTANT.exec(readBackendSource(...BACKFILL_MODULE));

    expect(Number(match?.[1])).toBe(CORPUS_SWEEP_PASS_ENTRY_LIMIT);
  });
});

describe('the sort-the-rest copy', () => {
  test('carries no price and no money language, because sorting is free', () => {
    for (const line of everyLine()) {
      expect(line).not.toMatch(/credit|token|price|cost|charge|pay|\$/i);
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

  test('offers the next bounded pass, never more than one pass sorts', () => {
    expect(corpusSweepActionLabel(412)).toBe(`Sort the next ${CORPUS_SWEEP_PASS_ENTRY_LIMIT}`);
    expect(corpusSweepActionLabel(3)).toBe('Sort the next 3');
  });

  test('a pass that sorted nothing with a remainder does not read as success', () => {
    const line = corpusSweepOutcomeLine({
      entries_pending: 12,
      entries_sorted: 0,
      entries_remaining: 12,
    });

    expect(line).toMatch(/^Nothing was sorted/);
    expect(line).toMatch(/12/);
    expect(line).not.toMatch(/done|all set|finished|sorted now/i);
  });

  test('a pass that left a remainder says how much is still waiting', () => {
    const line = corpusSweepOutcomeLine({
      entries_pending: 372,
      entries_sorted: 40,
      entries_remaining: 372,
    });

    expect(line).toMatch(/Sorted 40/);
    expect(line).toMatch(/372/);
  });

  test('a pass that cleared the backlog says nothing is left', () => {
    const line = corpusSweepOutcomeLine({
      entries_pending: 0,
      entries_sorted: 1,
      entries_remaining: 0,
    });

    expect(line).toMatch(/Sorted 1 entry/);
    expect(line).toMatch(/Nothing is left unsorted/);
  });
});
