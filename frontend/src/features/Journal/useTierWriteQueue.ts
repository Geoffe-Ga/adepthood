/**
 * Serialize one entry's privacy-tier writes (#2935).
 *
 * At most one tier PATCH is ever in flight, so the server commits them in the
 * order they are sent and their responses arrive in that order. Two kinds of
 * write come through here:
 *
 * - ``writer``: the writer's own tap on the tier control. The latest one is the
 *   writer's request (``requestedTier``), whether it is still queued or already
 *   sent, and it is what "the tier the control shows" means to everything else.
 *   A tap asked for while a write is out waits; a newer tap replaces it (last
 *   tap wins) and the replaced caller resolves as superseded.
 * - ``system``: the #2930 retry and the carried-words escalation. These never
 *   replace a queued writer tap, and never send a tier looser than the writer's
 *   request: one looser than it, or no stricter than a writer tap already
 *   waiting, is dropped and resolves with the request, so the control goes back
 *   to it. A stricter one waits behind the writer's tap and then raises it.
 */
import { useCallback, useRef } from 'react';

import { isTierLooser } from './journalSaveRetry';

import type { JournalClassification } from '@/api';

export type TierWriteKind = 'writer' | 'system';

/** Resolves to the tier the control should revert to, or null for none. */
type Revert = JournalClassification | null;

type Change = (_tier: JournalClassification) => Promise<Revert>;

interface QueuedWrite {
  tier: JournalClassification;
  kind: TierWriteKind;
  resolve: (_revertTo: Revert) => void;
}

export interface TierWriteQueue {
  enqueue: (_tier: JournalClassification, _kind: TierWriteKind) => Promise<Revert>;
  /** The writer's latest requested tier, queued or sent; null before any tap. */
  requestedTier: () => JournalClassification | null;
}

interface QueueState {
  busy: boolean;
  queue: QueuedWrite[];
  requested: JournalClassification | null;
  /** Bumped on every writer request, so an older write's revert cannot win. */
  requestSeq: number;
}

/** True when ``tier`` must not be sent over the writer's request. */
function looserThanRequest(state: QueueState, tier: JournalClassification): boolean {
  return state.requested != null && isTierLooser(tier, state.requested);
}

/** Queue a system write, or drop it when the writer's request makes it moot. */
function admitSystemWrite(state: QueueState, write: QueuedWrite): boolean {
  const writerWaiting = state.queue.some((queued) => queued.kind === 'writer');
  const noStricter = state.requested != null && !isTierLooser(state.requested, write.tier);
  if (looserThanRequest(state, write.tier) || (writerWaiting && noStricter)) {
    write.resolve(state.requested);
    return false;
  }
  for (const queued of state.queue.filter((q) => q.kind === 'system')) queued.resolve(null);
  state.queue = state.queue.filter((q) => q.kind !== 'system');
  return true;
}

/** Record a writer request, replacing any writer tap still waiting. */
function admitWriterWrite(state: QueueState, write: QueuedWrite): void {
  state.requested = write.tier;
  state.requestSeq += 1;
  for (const queued of state.queue.filter((q) => q.kind === 'writer')) queued.resolve(null);
  state.queue = state.queue.filter((q) => q.kind !== 'writer');
}

/** Send one write; when it settles, send whatever waits next. */
async function sendWrite(state: QueueState, change: Change, write: QueuedWrite): Promise<void> {
  state.busy = true;
  const seq = state.requestSeq;
  let revertTo: Revert = null;
  try {
    revertTo = await change(write.tier);
  } finally {
    // A failed writer write the writer has not since superseded: the control
    // reverts, and so does the request.
    if (write.kind === 'writer' && revertTo != null && seq === state.requestSeq) {
      state.requested = revertTo;
    }
    // A newer writer choice waits and owns the control: never revert over it.
    const writerWaiting = state.queue.some((q) => q.kind === 'writer');
    write.resolve(writerWaiting ? null : revertTo);
    state.busy = false;
    void sendNext(state, change);
  }
}

/** Send the next waiting write, dropping system writes the request has out-asked. */
function sendNext(state: QueueState, change: Change): Promise<void> {
  let next = state.queue.shift();
  while (next != null && next.kind === 'system' && looserThanRequest(state, next.tier)) {
    next.resolve(state.requested);
    next = state.queue.shift();
  }
  return next == null ? Promise.resolve() : sendWrite(state, change, next);
}

export function useTierWriteQueue(change: Change): TierWriteQueue {
  const stateRef = useRef<QueueState>({ busy: false, queue: [], requested: null, requestSeq: 0 });
  const changeRef = useRef(change);
  changeRef.current = change;
  const current: Change = useCallback((tier) => changeRef.current(tier), []);

  const enqueue = useCallback(
    (tier: JournalClassification, kind: TierWriteKind): Promise<Revert> =>
      new Promise<Revert>((resolve) => {
        const state = stateRef.current;
        const write: QueuedWrite = { tier, kind, resolve };
        if (kind === 'writer') admitWriterWrite(state, write);
        else if (!admitSystemWrite(state, write)) return;
        if (state.busy) state.queue.push(write);
        else void sendWrite(state, current, write);
      }),
    [current],
  );

  const requestedTier = useCallback(() => stateRef.current.requested, []);
  return { enqueue, requestedTier };
}
