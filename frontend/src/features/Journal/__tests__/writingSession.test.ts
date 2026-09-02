/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { DEFAULT_WRITING_MINUTES, toWritingSessionResult } from '../writingSession';

import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

describe('toWritingSessionResult', () => {
  it('reports a stop at 19:59 of a twenty-minute session as twenty elapsed minutes that did not reach the full duration', () => {
    const elapsedMs = 19 * MS_PER_MINUTE + 59_000;

    expect(toWritingSessionResult({ plannedMinutes: DEFAULT_WRITING_MINUTES, elapsedMs })).toEqual({
      plannedMinutes: 20,
      elapsedMs,
      elapsedMinutes: 20,
      reachedFullDuration: false,
    });
  });

  it('reports a session run to the full twenty minutes as having reached it', () => {
    const elapsedMs = 20 * MS_PER_MINUTE;

    expect(toWritingSessionResult({ plannedMinutes: DEFAULT_WRITING_MINUTES, elapsedMs })).toEqual({
      plannedMinutes: 20,
      elapsedMs,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    });
  });
});
