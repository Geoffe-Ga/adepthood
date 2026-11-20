/**
 * The app-level upload queue (#3772): every document a person brings in from
 * "Bring in what you've written", whichever screen they are on by now.
 *
 * Until #3772 the run lived in the Seed screen's own state and stopped when the
 * screen went (#2426), because a run nobody could see was a run that said one
 * thing while the server held another. The queue closes that divergence the
 * other way round: the run is kept here, outside any screen, and a small
 * indicator shows it from anywhere in the app (`UploadQueueIndicator`). So
 * leaving Seed carries on, and coming back shows the same rows.
 *
 * **Within the app session only.** Nothing here is persisted: a picked file's
 * handle cannot be rehydrated, so closing the tab, reloading, or the operating
 * system ending the app stops the queue, and on the web the page warns first.
 *
 * **One request at a time across the whole queue, and one pacer.** A batch
 * queued while another is going over is appended behind it, first in, first
 * out, and the next document is always chosen by {@link selectNextQueued} over
 * the one run every batch shares, which offers nothing while a document is in
 * flight. The pacer lives here rather than in a screen, so neither a remount
 * nor a second batch can exceed the upload limit.
 *
 * **A queue run** begins when something is queued into an idle queue and ends
 * when nothing is left to send. Every document of it carries one `upload_run`
 * id (#3770) -- so does "Try again" afterwards, which sends the run's own
 * documents again under the run's own id -- and each end is announced once, as {@link UploadQueueDrain}, to
 * {@link onUploadQueueDrained} listeners and as `lastDrain`.
 *
 * **Signing out** empties the queue through the store registry, aborts the
 * request in flight, and announces nothing: that run belonged to an account
 * that has gone.
 *
 * PRIVACY: the state holds ids, names and statuses only. The picked handles a
 * send or a retry needs are held in the module's runtime, never in the state,
 * a log, or storage, and go when the queue is reset.
 */
import { create } from 'zustand';

import { registerStoreReset } from './registry';

import type { JournalClassification } from '@/api';
import type { PickedDocument } from '@/features/Seed/pickSeedDocuments';
import {
  EMPTY_SEED_RUN,
  isLandedSeedStatus,
  isRetryableSeedStatus,
  isSettledSeedStatus,
  seedRunReducer,
  selectNextQueued,
  type SeedRunAction,
  type SeedRunState,
} from '@/features/Seed/seedRun';
import { mintSeedRunId } from '@/features/Seed/seedRunId';
import { sendOne, toQueuedDocuments, type SendableDocument } from '@/features/Seed/seedSend';
import { createSeedUploadPacer, type SeedUploadPacer } from '@/features/Seed/seedUploadPacing';

/**
 * How many times one document may be sent again by "Try again". Twice: enough
 * for a moment's trouble to pass, few enough that a document the server keeps
 * turning away stops being offered rather than invited back for ever.
 */
export const MAX_SEED_RETRIES_PER_DOCUMENT = 2;

/** One pick or reviewed folder, as it entered the queue. */
export interface SeedBatch {
  id: string;
  /** The folder's import name for a folder; null for files picked one by one. */
  name: string | null;
  /** Its documents' ids in the shared run, in pick order. */
  ids: readonly string[];
}

/** What a queue run came to, announced once when nothing is left to send. */
export interface UploadQueueDrain {
  /** The `upload_run` id every document of the run was sent with. */
  runId: string;
  /** How many documents the run sent, or tried to. */
  sent: number;
  /** How many of those landed. */
  landed: number;
}

/** What the queue holds and offers. */
export interface UploadQueueState {
  /** Every document queued this session, in the order it was queued. */
  run: SeedRunState;
  /** The batches those documents came in, oldest first. */
  batches: readonly SeedBatch[];
  /** Whether a queue run is going: something is in flight or still to send. */
  isSending: boolean;
  /** The documents whose handles a retry still holds. */
  heldIds: ReadonlySet<string>;
  /** The current queue run's id; null while idle. */
  runId: string | null;
  /** The last queue run's end, for a reader that was not listening. */
  lastDrain: UploadQueueDrain | null;
  /** Queue documents as a new batch at `tier`; resolves when all of them settle. */
  enqueue: (_documents: readonly PickedDocument[], _tier: JournalClassification) => Promise<void>;
  /** Send again the held documents among `ids`; nothing while the queue is going. */
  retry: (_ids: readonly string[]) => Promise<void>;
  /** Stop one batch: what it has not sent settles as `cancelled`. */
  cancelBatch: (_batchId: string) => void;
  /** Stop the whole queue. The document already with the server finishes. */
  cancelAll: () => void;
  /** Empty the queue and take back the request in flight (sign-out, tests). */
  reset: () => void;
}

/** A sent document's handle, kept only while a retry may still need it. */
interface HeldDocument extends SendableDocument {
  retries: number;
}

/**
 * Everything the queue keeps that is never rendered. One per session: a reset
 * replaces it, and a send that finds its runtime replaced writes nothing.
 */
interface QueueRuntime {
  pumping: boolean;
  minted: number;
  batchesMinted: number;
  held: Map<string, HeldDocument>;
  pacer: SeedUploadPacer;
  /** Reaches the requests themselves; aborted only by a reset. */
  session: AbortController;
  /** The document being sent, and the controller that stops its waits. */
  current: { id: string; stop: AbortController } | null;
  /** The documents this queue run has sent, for its drain. */
  sentThisRun: Set<string>;
  /** The id of the latest queue run, which a retry of it is sent under. */
  lastRunId: string | null;
}

function freshRuntime(): QueueRuntime {
  return {
    pumping: false,
    minted: 0,
    batchesMinted: 0,
    held: new Map(),
    // Read through a closure so the clock is whatever `Date` is at the time.
    pacer: createSeedUploadPacer(() => Date.now()),
    session: new AbortController(),
    current: null,
    sentThisRun: new Set(),
    lastRunId: null,
  };
}

let runtime = freshRuntime();

type DrainListener = (_drain: UploadQueueDrain) => void;

const drainListeners = new Set<DrainListener>();

/** Hear each queue run's end. Answers the way to stop listening. */
export function onUploadQueueDrained(listener: DrainListener): () => void {
  drainListeners.add(listener);
  return () => {
    drainListeners.delete(listener);
  };
}

/** How many documents are still in flight or waiting to go. */
export function selectUploadQueueRemaining(state: Pick<UploadQueueState, 'run'>): number {
  let remaining = 0;
  for (const id of state.run.order) {
    const status = state.run.items[id]?.status;
    if (status !== undefined && !isSettledSeedStatus(status)) remaining += 1;
  }
  return remaining;
}

const INITIAL_STATE = {
  run: EMPTY_SEED_RUN,
  batches: [] as readonly SeedBatch[],
  isSending: false,
  heldIds: new Set<string>() as ReadonlySet<string>,
  runId: null as string | null,
  lastDrain: null as UploadQueueDrain | null,
};

/** Whether a retry may still use a document's handle, given how it stands. */
function stillRetryable(kept: HeldDocument, run: SeedRunState, id: string): boolean {
  const status = run.items[id]?.status;
  if (status === undefined) return false;
  if (!isSettledSeedStatus(status)) return true;
  return isRetryableSeedStatus(status) && kept.retries < MAX_SEED_RETRIES_PER_DOCUMENT;
}

/** Drop every handle among `ids` a retry can no longer use. */
function pruneHeld(rt: QueueRuntime, run: SeedRunState, ids: readonly string[]): void {
  for (const id of ids) {
    const kept = rt.held.get(id);
    if (kept !== undefined && !stillRetryable(kept, run, id)) rt.held.delete(id);
  }
}

/** Take the held documents a retry will send, counting the retry against each. */
function takeForRetry(rt: QueueRuntime, ids: readonly string[]): string[] {
  const taken: string[] = [];
  for (const id of ids) {
    const kept = rt.held.get(id);
    if (kept === undefined) continue;
    kept.retries += 1;
    taken.push(id);
  }
  return taken;
}

/** The queue's state now; read at call time, so it is always the live store's. */
function get(): UploadQueueState {
  return useUploadQueueStore.getState();
}

/** Merge into the queue's state. */
function set(
  partial: Partial<UploadQueueState> | ((_state: UploadQueueState) => Partial<UploadQueueState>),
): void {
  useUploadQueueStore.setState(partial);
}

/** Apply run actions for `rt`, unless it has been reset since. */
function dispatchFor(rt: QueueRuntime): (_action: SeedRunAction) => void {
  return (action) => {
    if (rt === runtime) set((state) => ({ run: seedRunReducer(state.run, action) }));
  };
}

/** Resolves once every one of `ids` has settled, or left the queue with a reset. */
function whenSettled(ids: readonly string[]): Promise<void> {
  const done = (state: UploadQueueState): boolean =>
    ids.every((id) => {
      const status = state.run.items[id]?.status;
      return status === undefined || isSettledSeedStatus(status);
    });
  return new Promise((resolve) => {
    if (done(get())) {
      resolve();
      return;
    }
    const stop = useUploadQueueStore.subscribe((state) => {
      if (!done(state)) return;
      stop();
      resolve();
    });
  });
}

/** End the queue run in the same update that settled its last document, and announce it. */
function finishRun(rt: QueueRuntime, run: SeedRunState, runId: string): void {
  let landed = 0;
  for (const id of rt.sentThisRun) {
    const status = run.items[id]?.status;
    if (status !== undefined && isLandedSeedStatus(status)) landed += 1;
  }
  const drain: UploadQueueDrain = { runId, sent: rt.sentThisRun.size, landed };
  rt.pumping = false;
  rt.sentThisRun = new Set();
  set({ run, heldIds: new Set(rt.held.keys()), isSending: false, runId: null, lastDrain: drain });
  for (const listener of drainListeners) listener(drain);
}

/** Send one document and answer the id to send next, or null when the run is over. */
async function sendNext(rt: QueueRuntime, id: string, runId: string): Promise<string | null> {
  const kept = rt.held.get(id);
  const dispatch = dispatchFor(rt);
  const stop = new AbortController();
  rt.current = { id, stop };
  rt.sentThisRun.add(id);
  dispatch({ type: 'start', id });
  const status =
    kept === undefined
      ? 'cancelled'
      : await sendOne(id, kept, {
          dispatch,
          signal: stop.signal,
          requestSignal: rt.session.signal,
          pacer: rt.pacer,
          runId,
        });
  if (rt !== runtime) return null;
  rt.current = null;
  const run = seedRunReducer(get().run, { type: 'settle', id, status });
  pruneHeld(rt, run, [id]);
  const next = selectNextQueued(run);
  if (next !== null) {
    set({ run, heldIds: new Set(rt.held.keys()) });
    return next.id;
  }
  finishRun(rt, run, runId);
  return null;
}

/** Start a queue run if none is going and something waits to be sent. */
function startRun(runId: string): void {
  const rt = runtime;
  const first = rt.pumping ? null : selectNextQueued(get().run);
  if (first === null) return;
  rt.pumping = true;
  rt.lastRunId = runId;
  set({ isSending: true, runId });
  void (async () => {
    // Awaited inside the loop deliberately: this is the one-at-a-time guarantee.
    for (let next: string | null = first.id; next !== null;) {
      next = await sendNext(rt, next, runId);
    }
  })();
}

/** Settle the unsent among `ids` as `cancelled`, and stop the current wait if it is one of them. */
function cancelIds(ids: readonly string[]): void {
  const rt = runtime;
  const run = seedRunReducer(get().run, { type: 'cancel', ids });
  const current = rt.current;
  pruneHeld(
    rt,
    run,
    ids.filter((id) => id !== current?.id),
  );
  set({ run, heldIds: new Set(rt.held.keys()) });
  if (current !== null && ids.includes(current.id)) current.stop.abort();
}

/** Queue documents as a new batch and resolve once each of them has settled. */
async function enqueueDocuments(
  documents: readonly PickedDocument[],
  tier: JournalClassification,
): Promise<void> {
  if (documents.length === 0) return;
  const rt = runtime;
  const queued = toQueuedDocuments(documents, rt.minted, tier);
  rt.minted += queued.length;
  const ids = queued.map((item) => item.entry.id);
  const batch: SeedBatch = {
    id: `batch-${rt.batchesMinted}`,
    name: documents[0]?.source?.namespace ?? null,
    ids,
  };
  rt.batchesMinted += 1;
  for (const { entry, document } of queued) {
    if (entry.status === 'queued') rt.held.set(entry.id, { document, tier, retries: 0 });
  }
  set((state) => ({
    run: seedRunReducer(state.run, { type: 'add', entries: queued.map((item) => item.entry) }),
    batches: [...state.batches, batch],
  }));
  // A batch queued into a running queue joins its run; into an idle one, it starts a new run.
  startRun(mintSeedRunId());
  await whenSettled(ids);
}

/** Send again the held documents among `ids`; nothing while the queue is going. */
async function retryHeld(ids: readonly string[]): Promise<void> {
  const rt = runtime;
  if (rt.pumping) return;
  const taken = takeForRetry(rt, ids);
  if (taken.length === 0) return;
  set((state) => ({ run: seedRunReducer(state.run, { type: 'requeue', ids: taken }) }));
  // A retry is the same run to the person, and the same handshake to the server (#3770).
  startRun(rt.lastRunId ?? mintSeedRunId());
  await whenSettled(taken);
}

/** Empty the queue, abort the request in flight, and drop every handle. */
function resetQueue(): void {
  const previous = runtime;
  runtime = freshRuntime();
  previous.session.abort();
  previous.current?.stop.abort();
  previous.held.clear();
  set({ ...INITIAL_STATE });
}

export const useUploadQueueStore = create<UploadQueueState>(() => ({
  ...INITIAL_STATE,
  enqueue: enqueueDocuments,
  retry: retryHeld,
  cancelBatch: (batchId) => {
    const batch = get().batches.find((candidate) => candidate.id === batchId);
    if (batch !== undefined) cancelIds(batch.ids);
  },
  cancelAll: () => {
    cancelIds(get().run.order);
  },
  reset: resetQueue,
}));

registerStoreReset(() => {
  useUploadQueueStore.getState().reset();
});
