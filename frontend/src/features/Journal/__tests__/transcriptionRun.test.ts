/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  TRANSCRIBE_CONCURRENCY,
  transcriptionRunReducer,
  inFlightCount,
  selectStartable,
  isRunComplete,
  progressLabel,
  mergeBlocks,
  hasTerminalError,
} from '../transcriptionRun';
import type { TranscriptionBlock, TranscriptionRunState } from '../transcriptionRun';

import type { TranscriptionErrorKind } from '@/api';

// The driver hook owns image lookups and the actual transcribePage calls; this
// state only ever holds per-page status/text/edit/error, keyed by stable id.
const emptyState: TranscriptionRunState = { order: [], blocks: {}, orphans: [] };

function idsToPages(ids: readonly string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

// Read a block that the test has just asserted into existence, narrowing away the
// keyed record's `undefined` so property assertions stay strict-typed.
function blockAt(state: TranscriptionRunState, id: string): TranscriptionBlock {
  const block = state.blocks[id];
  if (!block) throw new Error('expected a block for the given id');
  return block;
}

// Seeding a fresh run is `pagesSynced` from the empty state: every page enters pending.
function initState(ids: readonly string[]): TranscriptionRunState {
  return transcriptionRunReducer(emptyState, { type: 'pagesSynced', orderedIds: ids });
}

describe('TRANSCRIBE_CONCURRENCY', () => {
  it('is exactly two', () => {
    expect(TRANSCRIBE_CONCURRENCY).toBe(2);
  });
});

describe('transcriptionRunReducer — pagesSynced seeds a fresh run', () => {
  it('seeds every page as pending, with empty text, no edit, and no error', () => {
    const state = initState(['p1', 'p2']);
    expect(state.order).toEqual(['p1', 'p2']);
    expect(state.blocks.p1).toEqual(
      expect.objectContaining({
        id: 'p1',
        status: 'pending',
        text: '',
        edited: false,
        error: null,
      }),
    );
    expect(state.blocks.p2).toEqual(
      expect.objectContaining({
        id: 'p2',
        status: 'pending',
        text: '',
        edited: false,
        error: null,
      }),
    );
  });
});

describe('selectStartable — concurrency bound', () => {
  it('never offers more than TRANSCRIBE_CONCURRENCY startable ids at once', () => {
    const state = initState(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(selectStartable(state)).toEqual(['p1', 'p2']);
  });

  it('offers nothing once both slots are in flight', () => {
    let state = initState(['p1', 'p2', 'p3', 'p4', 'p5']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    expect(selectStartable(state)).toEqual([]);
  });

  it('frees exactly one slot when one in-flight page resolves', () => {
    let state = initState(['p1', 'p2', 'p3', 'p4', 'p5']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    expect(selectStartable(state)).toEqual(['p3']);
  });

  it('frees exactly one slot when one in-flight page fails', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'network',
    });
    expect(selectStartable(state)).toEqual(['p3']);
  });
});

describe('transcriptionRunReducer — out-of-order completion', () => {
  it('lands each result under its own id regardless of resolution order', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p3', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p3', attempt: 1, text: 'C' });

    expect(blockAt(state, 'p1').text).toBe('A');
    expect(blockAt(state, 'p2').text).toBe('B');
    expect(blockAt(state, 'p3').text).toBe('C');
    expect(mergeBlocks(state, idsToPages(['p1', 'p2', 'p3']))).toBe('A\n\nB\n\nC');
  });
});

describe('transcriptionRunReducer — pagesSynced drops a removed page', () => {
  it('drops a page no longer in the session, so a stray resolve for it lands nowhere', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2'] });
    expect(state.blocks.p1).toBeUndefined();
    expect(state.order).toEqual(['p2']);

    const afterGhostResolve = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'ghost text',
    });
    // The page is gone for good — no block, no text, no place in the order. The
    // reply does settle the slot the removed read was still holding, which is
    // what the concurrency-bound suite below pins.
    expect(afterGhostResolve.blocks.p1).toBeUndefined();
    expect(afterGhostResolve.order).toEqual(['p2']);
    expect(mergeBlocks(afterGhostResolve, idsToPages(['p2']))).toBe('');
  });

  it('lets the run complete without the removed page', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2'] });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    expect(isRunComplete(state, idsToPages(['p2']))).toBe(true);
  });
});

describe('transcriptionRunReducer — stale-attempt drop', () => {
  it('ignores a resolve whose attempt token no longer matches the block', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    const stale = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 99,
      text: 'wrong attempt',
    });
    expect(blockAt(stale, 'p1').status).toBe('inFlight');
    expect(blockAt(stale, 'p1').text).toBe('');
  });

  it('ignores a reject whose attempt token no longer matches the block', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    const stale = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 0,
      error: 'network',
    });
    expect(blockAt(stale, 'p1').status).toBe('inFlight');
    expect(blockAt(stale, 'p1').error).toBeNull();
  });
});

describe('transcriptionRunReducer — structural double-charge guard', () => {
  it('treats start on a done block as a no-op, so a done page can never be re-charged automatically', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'done text',
    });
    const settled = state;
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 2 });
    expect(state).toEqual(settled);
    expect(selectStartable(state)).toEqual([]);
  });

  it('is a no-op for retry when the block is pending or in flight', () => {
    let state = initState(['p1']);
    const pending = state;
    expect(transcriptionRunReducer(state, { type: 'retry', id: 'p1' })).toEqual(pending);

    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    const inFlight = state;
    expect(transcriptionRunReducer(state, { type: 'retry', id: 'p1' })).toEqual(inFlight);
  });

  it('moves a failed block back to pending only through an explicit retry', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'timeout',
    });
    expect(blockAt(state, 'p1').status).toBe('failed');
    expect(blockAt(state, 'p1').error).toBe('timeout');

    state = transcriptionRunReducer(state, { type: 'retry', id: 'p1' });
    expect(blockAt(state, 'p1').status).toBe('pending');
    expect(blockAt(state, 'p1').error).toBeNull();
    expect(selectStartable(state)).toEqual(['p1']);
  });

  // retry is the only path back to pending from a terminal state (failed or done).
  it('lets an explicit retry return an already-done block to pending too, discarding its text and edit flag', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'first pass',
    });
    state = transcriptionRunReducer(state, { type: 'edit', id: 'p1', text: 'hand-edited' });

    state = transcriptionRunReducer(state, { type: 'retry', id: 'p1' });
    expect(state.blocks.p1).toEqual(
      expect.objectContaining({ status: 'pending', text: '', edited: false, error: null }),
    );
    expect(selectStartable(state)).toEqual(['p1']);
  });
});

describe('transcriptionRunReducer — edit guard', () => {
  it('ignores an edit while the block is pending or in flight', () => {
    let state = initState(['p1']);
    const pending = state;
    expect(transcriptionRunReducer(state, { type: 'edit', id: 'p1', text: 'too early' })).toEqual(
      pending,
    );

    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    const inFlight = state;
    expect(
      transcriptionRunReducer(state, { type: 'edit', id: 'p1', text: 'still too early' }),
    ).toEqual(inFlight);
  });

  it('never lets a resolve overwrite a block the user has already edited', () => {
    let state = initState(['p1']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'original OCR',
    });
    state = transcriptionRunReducer(state, { type: 'edit', id: 'p1', text: 'hand-corrected' });

    const lateResolve = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'late-arriving OCR text',
    });
    expect(blockAt(lateResolve, 'p1').text).toBe('hand-corrected');
    expect(blockAt(lateResolve, 'p1').edited).toBe(true);
  });

  it('lets an explicit retry replace only its own block, even after another block was edited', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'network',
    });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p2',
      attempt: 1,
      text: 'p2 text',
    });
    state = transcriptionRunReducer(state, { type: 'edit', id: 'p2', text: 'p2 hand-edited' });

    state = transcriptionRunReducer(state, { type: 'retry', id: 'p1' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 2 });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 2,
      text: 'p1 retried',
    });

    expect(blockAt(state, 'p1').text).toBe('p1 retried');
    expect(blockAt(state, 'p2').text).toBe('p2 hand-edited');
    expect(blockAt(state, 'p2').edited).toBe(true);
  });
});

describe('transcriptionRunReducer — unknown ids are inert', () => {
  it('no-ops start, resolve, reject, edit, and retry addressed to an id that is not in the run', () => {
    const state = initState(['p1']);
    expect(transcriptionRunReducer(state, { type: 'start', id: 'ghost', attempt: 1 })).toEqual(
      state,
    );
    expect(
      transcriptionRunReducer(state, { type: 'resolve', id: 'ghost', attempt: 1, text: 'x' }),
    ).toEqual(state);
    expect(
      transcriptionRunReducer(state, {
        type: 'reject',
        id: 'ghost',
        attempt: 1,
        error: 'network' as TranscriptionErrorKind,
      }),
    ).toEqual(state);
    expect(transcriptionRunReducer(state, { type: 'edit', id: 'ghost', text: 'x' })).toEqual(state);
    expect(transcriptionRunReducer(state, { type: 'retry', id: 'ghost' })).toEqual(state);
  });
});

describe('pagesSynced', () => {
  it('updates the internal start-priority order to match a freshly reordered page list', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p3', 'p2', 'p1'] });
    expect(selectStartable(state)).toEqual(['p3', 'p2']);
  });
});

describe('mergeBlocks', () => {
  it('merges resolved pages in session order with a blank-line separator and no page markers', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    state = transcriptionRunReducer(state, { type: 'edit', id: 'p2', text: 'B-edited' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p3', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p3', attempt: 1, text: 'C' });

    const merged = mergeBlocks(state, idsToPages(['p1', 'p2', 'p3']));
    expect(merged).toBe('A\n\nB-edited\n\nC');
    expect(merged).not.toMatch(/page \d/i);
  });

  it('excludes a page with no resolved block from the merge', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    expect(mergeBlocks(state, idsToPages(['p1', 'p2']))).toBe('A');
  });
});

describe('isRunComplete', () => {
  it('is false while any page remains pending, in flight, or failed', () => {
    let state = initState(['p1', 'p2']);
    expect(isRunComplete(state, idsToPages(['p1', 'p2']))).toBe(false);

    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    expect(isRunComplete(state, idsToPages(['p1', 'p2']))).toBe(false);

    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'network',
    });
    expect(isRunComplete(state, idsToPages(['p1', 'p2']))).toBe(false);
  });

  it('is true once every remaining page is done', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    expect(isRunComplete(state, idsToPages(['p1', 'p2']))).toBe(true);
  });

  it('is true once a failed page is removed and the rest are done', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'network',
    });
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p1'] });
    expect(isRunComplete(state, idsToPages(['p1']))).toBe(true);
  });
});

describe('progressLabel', () => {
  it('reports how many pages have resolved out of the total, matching the "Transcribing X of Y…" shape', () => {
    let state = initState(['p1', 'p2', 'p3', 'p4', 'p5']);
    const allFive = idsToPages(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(progressLabel(state, allFive)).toBe('Transcribing 0 of 5…');

    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    expect(progressLabel(state, allFive)).toBe('Transcribing 2 of 5…');
  });

  it('counts a failed page as not yet resolved', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'timeout',
    });
    expect(progressLabel(state, idsToPages(['p1', 'p2', 'p3']))).toBe('Transcribing 1 of 3…');
  });

  it('reports failed pages needing attention once no page is pending or in flight', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'timeout',
    });
    expect(progressLabel(state, idsToPages(['p1', 'p2']))).toBe('1 of 2 read · 1 need attention');
  });

  it('reports a terminally halted queue as needing attention once its last request settles', () => {
    let state = initState(['p1', 'p2', 'p3']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'model_lacks_vision',
    });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });

    // The terminal failure deliberately prevents p3 from starting. A pending
    // block is not outstanding work when the run's dispatch guard has halted it.
    expect(inFlightCount(state)).toBe(0);
    expect(selectStartable(state)).toEqual([]);
    expect(progressLabel(state, idsToPages(['p1', 'p2', 'p3']))).toBe(
      '1 of 3 read · 1 need attention',
    );
  });

  it('reports a completed multi-page run without an in-progress verb', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    expect(progressLabel(state, idsToPages(['p1', 'p2']))).toBe('All 2 pages read');
  });

  it('shrinks the total once a page leaves the session', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'timeout',
    });
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p1'] });
    expect(progressLabel(state, idsToPages(['p1']))).toBe('Page read');
  });
});

describe('hasTerminalError', () => {
  it('is false while no page has hit a terminal, unretryable failure', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'network',
    });
    expect(hasTerminalError(state)).toBe(false);
  });

  it('is true once any page fails with the config-level model_lacks_vision kind', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'model_lacks_vision',
    });
    expect(hasTerminalError(state)).toBe(true);
  });
});

describe('selectStartable — a terminal failure stops the run, not just the button', () => {
  // A five-page run is the shape that makes this cost real: without the
  // short-circuit, page one coming back with a spent balance still lets pages
  // two through five fan out, each a POST that charges the wallet, fails on the
  // same permanent refusal, and rolls back.
  const FIVE_PAGES = ['p1', 'p2', 'p3', 'p4', 'p5'];

  function failFirstPageWith(error: TranscriptionErrorKind): TranscriptionRunState {
    let state = initState(FIVE_PAGES);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    return transcriptionRunReducer(state, { type: 'reject', id: 'p1', attempt: 1, error });
  }

  it.each<TranscriptionErrorKind>(['credit_exhausted', 'service_credit_exhausted'])(
    'dispatches nothing more once a page has failed with %s',
    (error) => {
      const state = failFirstPageWith(error);
      expect(hasTerminalError(state)).toBe(true);
      expect(selectStartable(state)).toEqual([]);
    },
  );

  it('stops the fan-out for a model that cannot read images either', () => {
    // Pre-existing terminal kind: the same argument always applied to it, and
    // the run kept dispatching anyway.
    expect(selectStartable(failFirstPageWith('model_lacks_vision'))).toEqual([]);
  });

  it('keeps dispatching after an ordinary transient failure', () => {
    // The guard must be keyed on the kind, not on "something failed" — a
    // timeout on one page says nothing about the next.
    const state = failFirstPageWith('timeout');
    expect(hasTerminalError(state)).toBe(false);
    expect(selectStartable(state)).toEqual(['p2', 'p3']);
  });
});

describe('transcriptionRunReducer — a page removed mid-flight keeps holding its slot', () => {
  // The bound this pins is money, not tidiness: an in-flight page is a live,
  // wallet-charged request. Dropping its block the instant the writer trims the
  // page would make the run *believe* a slot came free and start a third read
  // while the second was still outstanding. Hand-written 2 on purpose: importing
  // the production constant would let the constant itself go wrong unnoticed.
  const HARD_BOUND = 2;

  // Two in flight (the bound), two more waiting behind them — so a wrongly-freed
  // slot always has a page ready to spend it, and "nothing started" can never
  // pass for the boring reason that there was nothing to start.
  function twoInFlightTwoQueued(): TranscriptionRunState {
    let state = initState(['p1', 'p2', 'p3', 'p4']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'start', id: 'p2', attempt: 1 });
    return state;
  }

  it('proves the queued pages would launch the moment a slot legitimately frees', () => {
    // The control for the assertions below: with p3 and p4 waiting, freeing one
    // slot *does* start p3. So a later "nothing startable" means the slot stayed
    // held, not that the run had run out of work.
    let state = twoInFlightTwoQueued();
    expect(inFlightCount(state)).toBe(HARD_BOUND);
    expect(selectStartable(state)).toEqual([]);
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    expect(inFlightCount(state)).toBe(HARD_BOUND - 1);
    expect(selectStartable(state)).toEqual(['p3']);
  });

  it('still counts the removed page as in flight, so no third read starts', () => {
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });

    expect(inFlightCount(state)).toBe(HARD_BOUND);
    expect(selectStartable(state)).toEqual([]);
    // The page itself is gone from the run: no block to render, no place in order.
    expect(state.blocks.p1).toBeUndefined();
    expect(state.order).toEqual(['p2', 'p3', 'p4']);
  });

  it('releases the slot when the orphaned request finally resolves, landing no text', () => {
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'ghost text',
    });

    expect(inFlightCount(state)).toBe(HARD_BOUND - 1);
    expect(selectStartable(state)).toEqual(['p3']);
    expect(state.blocks.p1).toBeUndefined();
    expect(mergeBlocks(state, idsToPages(['p2', 'p3', 'p4']))).not.toContain('ghost text');
  });

  it('releases the slot when the orphaned request finally rejects', () => {
    // A rejected orphan must free its slot too. If only resolve cleaned up, one
    // failed removal would strand a slot for the rest of the session and quietly
    // halve the run's concurrency.
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'network',
    });

    expect(inFlightCount(state)).toBe(HARD_BOUND - 1);
    expect(selectStartable(state)).toEqual(['p3']);
    expect(state.blocks.p1).toBeUndefined();
    expect(hasTerminalError(state)).toBe(false);
  });

  it('never offers the orphaned page itself, so its removal can never re-charge it', () => {
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p1',
      attempt: 1,
      error: 'network',
    });
    expect(selectStartable(state)).not.toContain('p1');
    // And it is inert to every gesture that could revive it.
    expect(transcriptionRunReducer(state, { type: 'retry', id: 'p1' })).toEqual(state);
    expect(transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 })).toEqual(state);
  });

  it('holds only one slot per orphan, and both when both in-flight pages are removed', () => {
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p3', 'p4'] });
    expect(inFlightCount(state)).toBe(HARD_BOUND);
    expect(selectStartable(state)).toEqual([]);

    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    expect(selectStartable(state)).toEqual(['p3']);
    state = transcriptionRunReducer(state, {
      type: 'reject',
      id: 'p2',
      attempt: 1,
      error: 'timeout',
    });
    expect(inFlightCount(state)).toBe(0);
    expect(selectStartable(state)).toEqual(['p3', 'p4']);
  });

  it('drops a settled orphan for good — a repeat reply cannot free a second slot', () => {
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'x' });
    const settled = state;
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'x' });
    expect(state).toEqual(settled);
    expect(inFlightCount(state)).toBe(HARD_BOUND - 1);
  });

  it('keeps a page that is merely reordered out of the orphan set', () => {
    // Only *leaving* the session orphans a request. A drag-reorder syncs the same
    // ids in a new order; treating that as a removal would hold slots forever.
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, {
      type: 'pagesSynced',
      orderedIds: ['p4', 'p3', 'p2', 'p1'],
    });
    expect(inFlightCount(state)).toBe(HARD_BOUND);
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p2', attempt: 1, text: 'B' });
    expect(inFlightCount(state)).toBe(0);
    expect(blockAt(state, 'p1').text).toBe('A');
  });

  it('leaves a pending or settled page unorphaned when it is removed', () => {
    // Nothing is outstanding for those, so holding a slot for them would be a leak
    // in the other direction: capacity the run never gets back.
    let state = initState(['p1', 'p2', 'p3', 'p4']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'resolve', id: 'p1', attempt: 1, text: 'A' });
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3'] });
    expect(inFlightCount(state)).toBe(0);
    expect(selectStartable(state)).toEqual(['p2', 'p3']);
  });

  it('gives a re-added id a fresh block and a fresh attempt, never the orphan back', () => {
    // Ids are unique per session today, so this is belt-and-braces — but if one
    // ever came back, adopting the orphan would resurrect a request the writer
    // already dismissed, and sharing its attempt token would let the old reply
    // land on the new page.
    let state = twoInFlightTwoQueued();
    state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: ['p2', 'p3', 'p4'] });
    state = transcriptionRunReducer(state, {
      type: 'pagesSynced',
      orderedIds: ['p2', 'p3', 'p4', 'p1'],
    });

    expect(blockAt(state, 'p1').status).toBe('pending');
    expect(blockAt(state, 'p1').attempt).not.toBe(1);
    // The slot is still held by the orphan, so the re-added page waits its turn.
    expect(inFlightCount(state)).toBe(HARD_BOUND);
    expect(selectStartable(state)).toEqual([]);

    // The orphan's late reply settles the orphan and leaves the new page pending.
    state = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'ghost text',
    });
    expect(blockAt(state, 'p1').status).toBe('pending');
    expect(blockAt(state, 'p1').text).toBe('');
    expect(selectStartable(state)).toEqual(['p3']);
  });

  it('never lets the orphan set outgrow the concurrency bound across a long session', () => {
    // Bounded by construction, not by a cap: an orphan only ever replaces an
    // in-flight page one-for-one, so the same bound that limits in-flight pages
    // limits orphans too. Trim every page mid-read, round after round, and the
    // held count never passes two — nor is a slot ever left behind at the end.
    const ids = Array.from({ length: 10 }, (_unused, index) => `p${index + 1}`);
    let state = initState(ids);
    for (let round = 0; round < ids.length; round += 1) {
      for (const id of selectStartable(state)) {
        state = transcriptionRunReducer(state, { type: 'start', id, attempt: 1 });
      }
      const flying = state.order.filter((id) => state.blocks[id]?.status === 'inFlight');
      if (flying.length === 0) break;
      expect(inFlightCount(state)).toBeLessThanOrEqual(HARD_BOUND);

      const remaining = state.order.filter((id) => !flying.includes(id));
      state = transcriptionRunReducer(state, { type: 'pagesSynced', orderedIds: remaining });
      // Every trimmed page is still holding its slot, and nothing new may start.
      expect(inFlightCount(state)).toBe(flying.length);
      expect(selectStartable(state)).toEqual([]);

      for (const id of flying) {
        state = transcriptionRunReducer(state, { type: 'resolve', id, attempt: 1, text: 'late' });
      }
      expect(inFlightCount(state)).toBe(0);
    }
    expect(state.order).toEqual([]);
    expect(inFlightCount(state)).toBe(0);
  });
});
