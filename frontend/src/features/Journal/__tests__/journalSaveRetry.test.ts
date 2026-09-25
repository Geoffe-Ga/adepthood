import { describe, expect, it } from '@jest/globals';

import {
  NO_PENDING_RETRY,
  deriveHintState,
  hasPendingRetry,
  isTierLooser,
  planRetry,
  recordFailure,
  recordSuccess,
  shouldRetryOnReconnect,
  type PendingRetry,
  type PublishedSaveState,
  type RetryLane,
} from '../journalSaveRetry';

const CHORD = { primary: 3, secondary: 5 };

function pending(overrides: Partial<PendingRetry>): PendingRetry {
  return { ...NO_PENDING_RETRY, ...overrides };
}

describe('recordFailure / recordSuccess touch only their own lane (#2930)', () => {
  it('records each lane independently, keeping the attempted tier and chord', () => {
    let next = recordFailure(NO_PENDING_RETRY, { lane: 'body' });
    next = recordFailure(next, { lane: 'classification', value: 'intimate' });
    next = recordFailure(next, { lane: 'chord', value: CHORD });
    next = recordFailure(next, { lane: 'finish' });
    expect(next).toEqual({ body: true, finish: true, classification: 'intimate', chord: CHORD });
  });

  it('lets a later failure overwrite the attempted value', () => {
    const first = recordFailure(NO_PENDING_RETRY, { lane: 'classification', value: 'intimate' });
    expect(recordFailure(first, { lane: 'classification', value: 'public' }).classification).toBe(
      'public',
    );
  });

  it.each<[RetryLane, Partial<PendingRetry>]>([
    ['body', { finish: true, classification: 'intimate', chord: CHORD }],
    ['finish', { body: true, classification: 'intimate', chord: CHORD }],
    ['classification', { body: true, finish: true, chord: CHORD }],
    ['chord', { body: true, finish: true, classification: 'intimate' }],
  ])('clearing %s leaves every other lane pending', (lane, remaining) => {
    const all = pending({ body: true, finish: true, classification: 'intimate', chord: CHORD });
    expect(recordSuccess(all, lane)).toEqual({ ...NO_PENDING_RETRY, ...remaining });
  });

  it('returns the same object when the lane was already clear (no re-render churn)', () => {
    expect(recordSuccess(NO_PENDING_RETRY, 'body')).toBe(NO_PENDING_RETRY);
    expect(recordSuccess(NO_PENDING_RETRY, 'chord')).toBe(NO_PENDING_RETRY);
  });

  it('reports whether anything is pending', () => {
    expect(hasPendingRetry(NO_PENDING_RETRY)).toBe(false);
    expect(hasPendingRetry(pending({ body: true }))).toBe(true);
    expect(hasPendingRetry(pending({ finish: true }))).toBe(true);
    expect(hasPendingRetry(pending({ classification: 'public' }))).toBe(true);
    expect(hasPendingRetry(pending({ chord: CHORD }))).toBe(true);
  });
});

describe('deriveHintState precedence (#2930)', () => {
  const somethingPending = pending({ chord: CHORD });

  it.each<[PublishedSaveState, string]>([
    ['typing', 'typing'],
    ['saving', 'saving'],
    ['weekTaken', 'weekTaken'],
    ['vaultWithdrawalPending', 'vaultWithdrawalPending'],
    ['saved', 'error'],
    ['idle', 'error'],
  ])('with a pending lane, published %s shows %s', (published, shown) => {
    expect(deriveHintState(published, somethingPending)).toBe(shown);
  });

  it.each<PublishedSaveState>([
    'idle',
    'typing',
    'saving',
    'saved',
    'weekTaken',
    'vaultWithdrawalPending',
  ])('with nothing pending, published %s shows itself', (published) => {
    expect(deriveHintState(published, NO_PENDING_RETRY)).toBe(published);
  });
});

describe('isTierLooser (#2930)', () => {
  it('orders public < personal < intimate and treats equal as not looser', () => {
    expect(isTierLooser('public', 'personal')).toBe(true);
    expect(isTierLooser('personal', 'intimate')).toBe(true);
    expect(isTierLooser('public', 'intimate')).toBe(true);
    expect(isTierLooser('personal', 'personal')).toBe(false);
    expect(isTierLooser('intimate', 'personal')).toBe(false);
    expect(isTierLooser('personal', 'public')).toBe(false);
  });
});

describe('planRetry (#2930)', () => {
  it('plans nothing when nothing is pending', () => {
    expect(planRetry(NO_PENDING_RETRY, 'tap', 'personal')).toEqual({ steps: [], dropped: [] });
  });

  it('on a tap, finish subsumes the body (it carries the full text)', () => {
    const plan = planRetry(pending({ body: true, finish: true }), 'tap', 'personal');
    expect(plan.steps).toEqual([{ lane: 'finish' }]);
  });

  it('on reconnect, never auto-finishes but still sends a pending body', () => {
    expect(planRetry(pending({ body: true, finish: true }), 'reconnect', 'personal').steps).toEqual(
      [{ lane: 'body' }],
    );
    expect(planRetry(pending({ finish: true }), 'reconnect', 'personal')).toEqual({
      steps: [],
      dropped: [],
    });
  });

  it('sends a pending body on either trigger', () => {
    expect(planRetry(pending({ body: true }), 'tap', 'personal').steps).toEqual([{ lane: 'body' }]);
    expect(planRetry(pending({ body: true }), 'reconnect', 'personal').steps).toEqual([
      { lane: 'body' },
    ]);
  });

  it.each(['tap', 'reconnect'] as const)(
    'on %s, drops a tier looser than the one displayed rather than sending it',
    (trigger) => {
      expect(planRetry(pending({ classification: 'public' }), trigger, 'personal')).toEqual({
        steps: [],
        dropped: ['classification'],
      });
    },
  );

  it('keeps an equal or stricter tier', () => {
    expect(planRetry(pending({ classification: 'intimate' }), 'reconnect', 'personal')).toEqual({
      steps: [{ lane: 'classification', value: 'intimate' }],
      dropped: [],
    });
    expect(planRetry(pending({ classification: 'personal' }), 'tap', 'personal').steps).toEqual([
      { lane: 'classification', value: 'personal' },
    ]);
  });

  it('orders body, then tier, then chord', () => {
    const plan = planRetry(
      pending({ body: true, classification: 'intimate', chord: CHORD }),
      'tap',
      'personal',
    );
    expect(plan.steps).toEqual([
      { lane: 'body' },
      { lane: 'classification', value: 'intimate' },
      { lane: 'chord', value: CHORD },
    ]);
  });
});

describe('shouldRetryOnReconnect (#2930)', () => {
  const ready = {
    wasOnline: false,
    isOnline: true,
    hint: 'error' as const,
    writeInFlight: false,
    dispatching: false,
  };

  it('fires on an offline → online edge while the hint is error and nothing runs', () => {
    expect(shouldRetryOnReconnect(ready)).toBe(true);
  });

  it('does not fire without a false → true edge', () => {
    expect(shouldRetryOnReconnect({ ...ready, wasOnline: true })).toBe(false);
    expect(shouldRetryOnReconnect({ ...ready, isOnline: false })).toBe(false);
  });

  it('does not fire unless the hint is error', () => {
    expect(shouldRetryOnReconnect({ ...ready, hint: 'saved' })).toBe(false);
    expect(shouldRetryOnReconnect({ ...ready, hint: 'saving' })).toBe(false);
  });

  it('does not fire while a write is in flight', () => {
    expect(shouldRetryOnReconnect({ ...ready, writeInFlight: true })).toBe(false);
  });

  it('does not fire while a retry is already dispatching', () => {
    expect(shouldRetryOnReconnect({ ...ready, dispatching: true })).toBe(false);
  });
});
