/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  MAX_BACKDATE_HOURS,
  MAX_BACKDATE_WINDOW_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_SESSION_DURATION_MS,
  MAX_SESSION_HOURS,
  MAX_STAGE,
  MIN_STAGE,
  stageRange,
} from '../constants';

describe('stageRange', () => {
  it('returns the inclusive integer range MIN_STAGE..MAX_STAGE', () => {
    expect(stageRange()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('starts at MIN_STAGE and ends at MAX_STAGE', () => {
    const range = stageRange();
    expect(range[0]).toBe(MIN_STAGE);
    expect(range[range.length - 1]).toBe(MAX_STAGE);
  });

  it('has exactly MAX_STAGE - MIN_STAGE + 1 entries', () => {
    expect(stageRange()).toHaveLength(MAX_STAGE - MIN_STAGE + 1);
  });

  it('is every integer, strictly ascending by 1', () => {
    const range = stageRange();
    range.forEach((value, index) => {
      expect(Number.isInteger(value)).toBe(true);
      const previous = range[index - 1];
      if (previous !== undefined) {
        expect(value - previous).toBe(1);
      }
    });
  });
});

describe('the manual-log session window', () => {
  // Pinned to `backend/src/schemas/practice.py:47-49` (MAX_FUTURE_SKEW,
  // MAX_BACKDATE_WINDOW, MAX_SESSION_DURATION). `sessionWindowDrift.test.ts`
  // reads those literals out of the Python and fails when they move; these
  // cases pin what the copy and the derived millisecond values are built from.
  it('mirrors the backend clock-skew, backdate, and duration caps', () => {
    expect(MAX_FUTURE_SKEW_SECONDS).toBe(60);
    expect(MAX_BACKDATE_HOURS).toBe(24);
    expect(MAX_SESSION_HOURS).toBe(8);
  });

  it('derives the millisecond bounds the client guards on from those caps', () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(60 * 1000);
    expect(MAX_BACKDATE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_SESSION_DURATION_MS).toBe(8 * 60 * 60 * 1000);
  });
});
