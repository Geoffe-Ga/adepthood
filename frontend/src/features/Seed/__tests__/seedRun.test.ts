/* eslint-env jest */
/* global describe, test, expect */
import {
  EMPTY_SEED_RUN,
  isRetryableSeedStatus,
  seedRunReducer,
  seedRunTally,
  selectNextQueued,
  type SeedItemStatus,
  type SeedRunState,
} from '../seedRun';

function withThreeQueued(): SeedRunState {
  return seedRunReducer(EMPTY_SEED_RUN, {
    type: 'add',
    entries: [
      { id: 'a', name: 'first.md', status: 'queued' },
      { id: 'b', name: 'second.md', status: 'queued' },
      { id: 'c', name: 'third.md', status: 'queued' },
    ],
  });
}

describe('adding documents to a run', () => {
  test('keeps them in selection order', () => {
    expect(withThreeQueued().order).toEqual(['a', 'b', 'c']);
  });

  test('admits a document that is already settled, so its reason is visible', () => {
    const state = seedRunReducer(EMPTY_SEED_RUN, {
      type: 'add',
      entries: [{ id: 'x', name: 'installer.exe', status: 'unsupported_format' }],
    });

    expect(state.items.x?.status).toBe('unsupported_format');
    expect(selectNextQueued(state)).toBeNull();
  });

  test('appends a second pick after the first', () => {
    const state = seedRunReducer(withThreeQueued(), {
      type: 'add',
      entries: [{ id: 'd', name: 'fourth.md', status: 'queued' }],
    });

    expect(state.order).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('the sequential invariant', () => {
  test('offers the first queued document', () => {
    expect(selectNextQueued(withThreeQueued())?.id).toBe('a');
  });

  test('offers nothing while one document is uploading', () => {
    const state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });

    expect(state.items.a?.status).toBe('uploading');
    expect(selectNextQueued(state)).toBeNull();
  });

  test('offers the next only once the previous has settled', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });

    expect(selectNextQueued(state)?.id).toBe('b');
  });

  test('will not restart a document that has already settled', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'start', id: 'a' });

    expect(state.items.a?.status).toBe('ingested');
  });

  test('ignores actions naming a document the run does not hold', () => {
    const state = withThreeQueued();

    expect(seedRunReducer(state, { type: 'start', id: 'ghost' })).toBe(state);
    expect(seedRunReducer(state, { type: 'settle', id: 'ghost', status: 'failed' })).toBe(state);
  });
});

describe('one failure never abandons the rest', () => {
  test('a mid-list failure leaves the documents after it uploadable', () => {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'start', id: 'b' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'failed' });

    expect(selectNextQueued(state)?.id).toBe('c');
  });

  test('holds each document its own settled outcome', () => {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'capability_unsupported' });
    state = seedRunReducer(state, { type: 'settle', id: 'c', status: 'too_large' });

    expect(state.order.map((id) => state.items[id]?.status)).toEqual([
      'ingested',
      'capability_unsupported',
      'too_large',
    ]);
  });
});

describe('what the run reports', () => {
  test('has nothing to say about an empty run', () => {
    expect(seedRunTally(EMPTY_SEED_RUN)).toEqual({
      total: 0,
      landed: 0,
      waiting: 0,
      refused: 0,
      unconfirmed: 0,
    });
  });

  test('counts every unsent document as still waiting', () => {
    expect(seedRunTally(withThreeQueued())).toEqual({
      total: 3,
      landed: 0,
      waiting: 3,
      refused: 0,
      unconfirmed: 0,
    });
  });

  test('tallies what landed, what is waiting, and what did not land', () => {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'vault_unavailable' });

    expect(seedRunTally(state)).toEqual({
      total: 3,
      landed: 1,
      waiting: 1,
      refused: 1,
      unconfirmed: 0,
    });
  });

  test('counts a document kept by the corpus as landed, exactly as a vault one', () => {
    // Two destinations, one question: how much of what I chose is in. An
    // account with no vault reaches `in_corpus` and never `ingested`, so a
    // tally that only counted the vault's word would report zero for every
    // document such an account ever imported.
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'in_corpus' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'in_corpus' });
    state = seedRunReducer(state, { type: 'settle', id: 'c', status: 'consent_required' });

    expect(seedRunTally(state)).toEqual({
      total: 3,
      landed: 2,
      waiting: 0,
      refused: 1,
      unconfirmed: 0,
    });
  });

  test('counts an upload nobody could confirm apart from one that did not go', () => {
    // #3239. A degraded vault answer and a lost reply may both have been kept,
    // so neither is counted with the documents that definitely did not go.
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'degraded' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'unconfirmed' });
    state = seedRunReducer(state, { type: 'settle', id: 'c', status: 'offline' });

    expect(seedRunTally(state)).toEqual({
      total: 3,
      landed: 0,
      waiting: 0,
      refused: 1,
      unconfirmed: 2,
    });
  });

  test('clears back to an empty run', () => {
    expect(seedRunReducer(withThreeQueued(), { type: 'clear' })).toEqual(EMPTY_SEED_RUN);
  });
});

describe('cancelling a run that is still going', () => {
  test('settles every document still waiting as one that never went', () => {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'start', id: 'b' });

    const cancelled = seedRunReducer(state, { type: 'cancel' });

    expect(cancelled.items.a?.status).toBe('ingested');
    expect(cancelled.items.c?.status).toBe('cancelled');
  });

  test('leaves the document already in flight alone, because it has gone', () => {
    // The request is with the server. Calling it cancelled here would be the
    // screen saying one thing while the corpus holds another.
    let state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'cancel' });

    expect(state.items.a?.status).toBe('uploading');
  });

  test('offers the loop nothing further to send', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'cancel' });

    expect(selectNextQueued(state)).toBeNull();
  });

  test('counts a cancelled document among what did not go over', () => {
    const cancelled = seedRunReducer(withThreeQueued(), { type: 'cancel' });

    expect(seedRunTally(cancelled)).toEqual({
      total: 3,
      landed: 0,
      waiting: 0,
      refused: 3,
      unconfirmed: 0,
    });
  });
});

describe('a document held for a moment (#3556)', () => {
  test('a queued document can wait its pace, and holds the run while it does', () => {
    const state = seedRunReducer(withThreeQueued(), { type: 'wait', id: 'a' });

    expect(state.items.a?.status).toBe('waiting');
    expect(selectNextQueued(state)).toBeNull();
  });

  test('a document refused with a 429 waits instead of settling', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });
    state = seedRunReducer(state, { type: 'wait', id: 'a' });

    expect(state.items.a?.status).toBe('waiting');
    expect(seedRunTally(state)).toMatchObject({ waiting: 3, refused: 0 });
  });

  test('a waiting document goes over again once its wait is up', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'wait', id: 'a' });
    state = seedRunReducer(state, { type: 'start', id: 'a' });

    expect(state.items.a?.status).toBe('uploading');
  });

  test('a settled document never waits', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'settle', id: 'a', status: 'failed' });
    state = seedRunReducer(state, { type: 'wait', id: 'a' });

    expect(state.items.a?.status).toBe('failed');
  });

  test('stopping the run cancels a waiting document, since nothing of it is in flight', () => {
    let state = seedRunReducer(withThreeQueued(), { type: 'wait', id: 'a' });
    state = seedRunReducer(state, { type: 'cancel' });

    expect(state.items.a?.status).toBe('cancelled');
  });
});

describe('sending the ones that did not go again (#3556)', () => {
  function settledRun(): SeedRunState {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'failed' });
    return seedRunReducer(state, { type: 'settle', id: 'c', status: 'rate_limited' });
  }

  test('requeues only the documents that can be sent again', () => {
    const state = seedRunReducer(settledRun(), { type: 'requeue', ids: ['a', 'b', 'c'] });

    expect(state.order.map((id) => state.items[id]?.status)).toEqual([
      'ingested',
      'queued',
      'queued',
    ]);
  });

  test('never requeues a document still on its way', () => {
    const state = seedRunReducer(withThreeQueued(), { type: 'start', id: 'a' });

    expect(seedRunReducer(state, { type: 'requeue', ids: ['a'] }).items.a?.status).toBe(
      'uploading',
    );
  });

  test('ignores an id the run does not hold', () => {
    const state = settledRun();

    expect(seedRunReducer(state, { type: 'requeue', ids: ['zz'] })).toEqual(state);
  });

  test.each<SeedItemStatus>([
    'failed',
    'rate_limited',
    'offline',
    'unconfirmed',
    'degraded',
    'vault_unavailable',
  ])('%s can be sent again', (status) => {
    expect(isRetryableSeedStatus(status)).toBe(true);
  });

  test.each<SeedItemStatus>([
    'ingested',
    'in_corpus',
    'queued',
    'uploading',
    'waiting',
    'too_large',
    'managed_too_large',
    'unsupported_format',
    'consent_required',
    'tier_refused',
    'cancelled',
  ])('%s is not sent again by a retry', (status) => {
    expect(isRetryableSeedStatus(status)).toBe(false);
  });
});
