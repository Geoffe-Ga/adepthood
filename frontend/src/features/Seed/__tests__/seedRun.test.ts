/* eslint-env jest */
/* global describe, test, expect */
import {
  EMPTY_SEED_RUN,
  seedRunReducer,
  seedRunTally,
  selectNextQueued,
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
    expect(seedRunTally(EMPTY_SEED_RUN)).toEqual({ total: 0, ingested: 0, waiting: 0, refused: 0 });
  });

  test('counts every unsent document as still waiting', () => {
    expect(seedRunTally(withThreeQueued())).toEqual({
      total: 3,
      ingested: 0,
      waiting: 3,
      refused: 0,
    });
  });

  test('tallies what landed, what is waiting, and what did not land', () => {
    let state = withThreeQueued();
    state = seedRunReducer(state, { type: 'settle', id: 'a', status: 'ingested' });
    state = seedRunReducer(state, { type: 'settle', id: 'b', status: 'vault_unavailable' });

    expect(seedRunTally(state)).toEqual({ total: 3, ingested: 1, waiting: 1, refused: 1 });
  });

  test('clears back to an empty run', () => {
    expect(seedRunReducer(withThreeQueued(), { type: 'clear' })).toEqual(EMPTY_SEED_RUN);
  });
});
