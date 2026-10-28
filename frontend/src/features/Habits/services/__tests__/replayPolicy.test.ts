import { describe, expect, it } from '@jest/globals';

import { ApiError, ApiTimeoutError, ApiValidationError } from '../../../../api';
import type { ReplayHeadState } from '../../../../storage/checkInReplayState';
import type { PendingCheckIn } from '../../../../storage/habitStorage';
import {
  MAX_CHECK_IN_REPLAY_ATTEMPTS,
  MIN_POISON_AGE_MS,
  checkInIdentity,
  classifyReplayFailure,
  hasExhaustedRetries,
  nextHeadState,
} from '../replayPolicy';

const NOW = Date.parse('2025-06-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const entry = (overrides: Partial<PendingCheckIn> = {}): PendingCheckIn => ({
  goal_id: 7,
  did_complete: true,
  timestamp: '2025-04-01T09:00:00.000Z',
  ...overrides,
});

const stateAt = (attempts: number, ageMs: number): ReplayHeadState => ({
  identity: checkInIdentity(entry()),
  attempts,
  first_rejected_at: iso(NOW - ageMs),
  last_status: 500,
});

describe('the replay give-up thresholds', () => {
  it('bound the give-up to five counted rejections over at least a week', () => {
    expect(MAX_CHECK_IN_REPLAY_ATTEMPTS).toBe(5);
    expect(MIN_POISON_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('classifyReplayFailure', () => {
  it.each([400, 403, 404, 409, 422])('reads a %i as a permanent rejection', (status) => {
    expect(classifyReplayFailure(new ApiError(status, 'x'))).toEqual({
      kind: 'permanent',
      status,
    });
  });

  it('reads a malformed response body as permanent, carrying its own status', () => {
    expect(classifyReplayFailure(new ApiValidationError('/goal_completions/', 201, []))).toEqual({
      kind: 'permanent',
      status: 201,
    });
  });

  it.each([401, 408, 429, 502, 503, 504])('never counts a %i', (status) => {
    expect(classifyReplayFailure(new ApiError(status, 'x'))).toEqual({ kind: 'uncounted' });
  });

  it.each([
    ['a fetch TypeError', new TypeError('Failed to fetch')],
    ['a client timeout', new ApiTimeoutError('/goal_completions/', 1000)],
    ['an offline fast-fail', new ApiError(0, 'network_error')],
    ['a status below the HTTP range', new ApiError(99, 'x')],
    ['something that is not an error at all', 'boom'],
  ])('never counts %s', (_label, err) => {
    expect(classifyReplayFailure(err)).toEqual({ kind: 'uncounted' });
  });

  it.each([100, 418, 451, 500, 507])('counts an unclassified %i', (status) => {
    expect(classifyReplayFailure(new ApiError(status, 'x'))).toEqual({ kind: 'counted', status });
  });
});

describe('hasExhaustedRetries', () => {
  it('holds an entry one rejection short of the cap, however old', () => {
    expect(
      hasExhaustedRetries(stateAt(MAX_CHECK_IN_REPLAY_ATTEMPTS - 1, MIN_POISON_AGE_MS), NOW),
    ).toBe(false);
  });

  it('holds an entry at the cap that is a moment younger than the floor', () => {
    expect(
      hasExhaustedRetries(stateAt(MAX_CHECK_IN_REPLAY_ATTEMPTS, MIN_POISON_AGE_MS - 1), NOW),
    ).toBe(false);
  });

  it('gives up exactly at the cap and the floor', () => {
    expect(hasExhaustedRetries(stateAt(MAX_CHECK_IN_REPLAY_ATTEMPTS, MIN_POISON_AGE_MS), NOW)).toBe(
      true,
    );
  });

  it('never gives up on a record whose first-failure stamp does not parse', () => {
    const corrupt = { ...stateAt(MAX_CHECK_IN_REPLAY_ATTEMPTS * 2, 0), first_rejected_at: 'later' };
    expect(hasExhaustedRetries(corrupt, NOW)).toBe(false);
  });
});

describe('nextHeadState', () => {
  it('opens a record on the first counted rejection, stamped now', () => {
    expect(nextHeadState(null, entry(), 451, NOW)).toEqual({
      identity: checkInIdentity(entry()),
      attempts: 1,
      first_rejected_at: iso(NOW),
      last_status: 451,
    });
  });

  it('adds one and keeps the first stamp when the record names this entry', () => {
    const prev = stateAt(2, MIN_POISON_AGE_MS);
    expect(nextHeadState(prev, entry(), 507, NOW)).toEqual({
      ...prev,
      attempts: 3,
      last_status: 507,
    });
  });

  it('restarts when the record names some other entry', () => {
    const prev = { ...stateAt(MAX_CHECK_IN_REPLAY_ATTEMPTS, MIN_POISON_AGE_MS), identity: 'other' };
    expect(nextHeadState(prev, entry(), 500, NOW)).toMatchObject({
      attempts: 1,
      first_rejected_at: iso(NOW),
    });
  });
});

describe('checkInIdentity', () => {
  it('is the operation id when the entry carries one', () => {
    expect(checkInIdentity(entry({ operation_id: 'op-1' }))).toBe('op-1');
  });

  it('tells apart legacy entries that differ in any field they carry', () => {
    const base = checkInIdentity(entry());
    expect(checkInIdentity(entry({ goal_id: 8 }))).not.toBe(base);
    expect(checkInIdentity(entry({ timestamp: '2025-04-02T09:00:00.000Z' }))).not.toBe(base);
    expect(checkInIdentity(entry({ completed_on: '2025-03-31' }))).not.toBe(base);
    expect(checkInIdentity(entry({ did_complete: false }))).not.toBe(base);
    expect(checkInIdentity(entry({ completed_units: 2 }))).not.toBe(base);
    expect(checkInIdentity(entry())).toBe(base);
  });
});
