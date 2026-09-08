import { describe, expect, it } from '@jest/globals';

import {
  MAX_BACKDATE_WINDOW_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_SESSION_DURATION_MS,
} from '../../constants';
import {
  SESSION_WINDOW_COPY,
  manualSessionPayload,
  sessionWindowViolations,
} from '../sessionWindow';

const NOW = new Date('2026-09-08T15:00:00.000Z');
const MS_PER_MINUTE = 60_000;
const TWENTY_MINUTES = 20 * MS_PER_MINUTE;

/** A window ending `endedOffsetMs` from `NOW` and lasting `spanMs`. */
function windowAt(endedOffsetMs: number, spanMs: number): [Date, Date] {
  const ended = new Date(NOW.getTime() + endedOffsetMs);
  return [new Date(ended.getTime() - spanMs), ended];
}

describe('sessionWindowViolations', () => {
  it('accepts a plain 20-minute sitting that ended just now', () => {
    const [started, ended] = windowAt(0, TWENTY_MINUTES);
    expect(sessionWindowViolations(started, ended, NOW)).toEqual([]);
  });

  it('rejects a window that ends before it starts', () => {
    const ended = new Date(NOW.getTime() - TWENTY_MINUTES);
    expect(sessionWindowViolations(NOW, ended, NOW)).toEqual(['ended_before_started']);
  });

  it('accepts an end exactly at the clock-skew allowance and rejects one millisecond later', () => {
    const [atLimitStart, atLimitEnd] = windowAt(MAX_FUTURE_SKEW_MS, TWENTY_MINUTES);
    expect(sessionWindowViolations(atLimitStart, atLimitEnd, NOW)).toEqual([]);

    const [overStart, overEnd] = windowAt(MAX_FUTURE_SKEW_MS + 1, TWENTY_MINUTES);
    expect(sessionWindowViolations(overStart, overEnd, NOW)).toEqual(['ended_in_future']);
  });

  it('accepts a start exactly at the backdate cap and rejects one millisecond older', () => {
    const atLimitStart = new Date(NOW.getTime() - MAX_BACKDATE_WINDOW_MS);
    const atLimitEnd = new Date(atLimitStart.getTime() + TWENTY_MINUTES);
    expect(sessionWindowViolations(atLimitStart, atLimitEnd, NOW)).toEqual([]);

    const overStart = new Date(atLimitStart.getTime() - 1);
    const overEnd = new Date(overStart.getTime() + TWENTY_MINUTES);
    expect(sessionWindowViolations(overStart, overEnd, NOW)).toEqual(['started_too_old']);
  });

  it('accepts a span exactly at the duration cap and rejects one millisecond longer', () => {
    const [atLimitStart, atLimitEnd] = windowAt(0, MAX_SESSION_DURATION_MS);
    expect(sessionWindowViolations(atLimitStart, atLimitEnd, NOW)).toEqual([]);

    const [overStart, overEnd] = windowAt(0, MAX_SESSION_DURATION_MS + 1);
    expect(sessionWindowViolations(overStart, overEnd, NOW)).toEqual(['too_long']);
  });

  it('reports violations in the order the server checks them', () => {
    // A 9-hour sitting that started 25 hours ago breaks both the backdate cap
    // and the duration cap; the backend checks backdate first.
    const started = new Date(NOW.getTime() - (MAX_BACKDATE_WINDOW_MS + MS_PER_MINUTE));
    const ended = new Date(started.getTime() + MAX_SESSION_DURATION_MS + 1);
    expect(sessionWindowViolations(started, ended, NOW)).toEqual(['started_too_old', 'too_long']);
  });

  it('has user-facing copy for every violation it can return', () => {
    expect(Object.keys(SESSION_WINDOW_COPY).sort()).toEqual([
      'ended_before_started',
      'ended_in_future',
      'started_too_old',
      'too_long',
    ]);
    Object.values(SESSION_WINDOW_COPY).forEach((copy) => {
      expect(copy.length).toBeGreaterThan(0);
    });
  });
});

describe('manualSessionPayload', () => {
  const endedAt = new Date('2026-09-08T15:00:00.000Z');

  it('spans exactly the chosen minutes and marks the sitting complete', () => {
    const payload = manualSessionPayload({
      userPracticeId: 7,
      endedAt,
      durationMinutes: 20,
    });

    expect(payload.user_practice_id).toBe(7);
    expect(payload.ended_at).toBe('2026-09-08T15:00:00.000Z');
    expect(Date.parse(payload.ended_at) - Date.parse(payload.started_at)).toBe(TWENTY_MINUTES);
    expect(payload.completed).toBe(true);
  });

  it('never sends a duration or mode metadata — the server derives both', () => {
    const payload = manualSessionPayload({
      userPracticeId: 7,
      endedAt,
      durationMinutes: 20,
    });

    expect('duration_minutes' in payload).toBe(false);
    expect('mode_metadata' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual([
      'completed',
      'ended_at',
      'started_at',
      'user_practice_id',
    ]);
  });
});
