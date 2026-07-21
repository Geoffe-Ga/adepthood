/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  TRANSCRIBE_CONCURRENCY,
  transcriptionRunReducer,
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
const emptyState: TranscriptionRunState = { order: [], blocks: {} };

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

function initState(ids: readonly string[]): TranscriptionRunState {
  return transcriptionRunReducer(emptyState, { type: 'init', pageIds: ids });
}

describe('TRANSCRIBE_CONCURRENCY', () => {
  it('is exactly two', () => {
    expect(TRANSCRIBE_CONCURRENCY).toBe(2);
  });
});

describe('transcriptionRunReducer — init', () => {
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

describe('transcriptionRunReducer — pageRemoved', () => {
  it('drops a removed page entirely, so a stray resolve for it is absorbed as a no-op', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'pageRemoved', id: 'p1' });
    expect(state.blocks.p1).toBeUndefined();
    expect(state.order).toEqual(['p2']);

    const afterGhostResolve = transcriptionRunReducer(state, {
      type: 'resolve',
      id: 'p1',
      attempt: 1,
      text: 'ghost text',
    });
    expect(afterGhostResolve.blocks.p1).toBeUndefined();
    expect(afterGhostResolve).toEqual(state);
  });

  it('lets the run complete without the removed page', () => {
    let state = initState(['p1', 'p2']);
    state = transcriptionRunReducer(state, { type: 'start', id: 'p1', attempt: 1 });
    state = transcriptionRunReducer(state, { type: 'pageRemoved', id: 'p1' });
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
    state = transcriptionRunReducer(state, { type: 'pageRemoved', id: 'p2' });
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
    state = transcriptionRunReducer(state, { type: 'pageRemoved', id: 'p2' });
    expect(progressLabel(state, idsToPages(['p1']))).toBe('Transcribing 1 of 1…');
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
