/**
 * Drives one seeding run: open the picker, queue what came back, and send the
 * documents one after another at the tier the person chose, recording each
 * outcome as it settles.
 *
 * Strictly sequential, and deliberately so. A seed is often a folder at once;
 * sending them in parallel would multiply the memory a 10 MB encode costs and
 * bury the rate limit, and it would make the per-document status a guess. One
 * at a time means every line on screen is the literal truth about that file.
 *
 * **Paced, and patient with a 429 (#3556).** Before each send the run asks
 * {@link createSeedUploadPacer} whether the upload limit has room, and holds the
 * next document (`waiting`) until it does, so a folder past the limit goes over
 * at a steady pace instead of turning into a wall of refusals. A 429 that comes
 * anyway is waited out for as long as its `Retry-After` says, at most
 * {@link MAX_SEED_RATE_LIMIT_WAITS} times per document; every wait stops the
 * moment the run does.
 *
 * **What did not go over can go again, once or twice.** The documents a retry
 * may send ({@link isRetryableSeedStatus}) keep their picked handle and the tier
 * they went at, so "Try again" sends exactly those, under the same identity,
 * and never anything that landed. Bounded by
 * {@link MAX_SEED_RETRIES_PER_DOCUMENT}.
 *
 * PRIVACY: a document's bytes live in the loop's local scope for the length of
 * its own request. Nothing about them enters the run state, a notice, or a log.
 * The picked handles a retry needs are held in this hook's own ref, never in
 * the reducer or app storage, and are dropped when the screen goes.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react';

import { attemptSeedDocument, type SeedAttempt } from './importSeedDocument';
import { pickSeedDocuments, type PickedDocument } from './pickSeedDocuments';
import { SEED_CANCELLED_NOTICE, SEED_FAILED_PICK_NOTICE } from './seedCopy';
import {
  EMPTY_SEED_RUN,
  isRetryableSeedStatus,
  seedRunReducer,
  seedRunTally,
  selectNextQueued,
  type SeedEntry,
  type SeedItem,
  type SeedRunAction,
  type SeedRunState,
  type SeedRunTally,
  type SettledSeedStatus,
} from './seedRun';
import {
  createSeedUploadPacer,
  MAX_SEED_RATE_LIMIT_WAITS,
  rateLimitWaitMs,
  waitOrStop,
  type SeedUploadPacer,
} from './seedUploadPacing';

import type { JournalClassification } from '@/api';

/** The tier a seeded document takes when the person has not changed it. */
export const DEFAULT_SEED_CLASSIFICATION: JournalClassification = 'personal';

/**
 * How many times one document may be sent again by "Try again". Twice: enough
 * for a moment's trouble to pass, few enough that a document the server keeps
 * turning away stops being offered rather than invited back for ever.
 */
export const MAX_SEED_RETRIES_PER_DOCUMENT = 2;

/**
 * One document the run is sending: its run entry, its picked handle, and the
 * tier it goes at. The tier travels with the document, so a retry sends it at
 * the level it was first sent at, whatever the control says now.
 */
interface QueuedDocument {
  entry: SeedEntry;
  document: PickedDocument;
  tier: JournalClassification;
}

/** A sent document's handle, kept only while a retry may still need it. */
interface HeldDocument {
  document: PickedDocument;
  tier: JournalClassification;
  retries: number;
}

/** What the seeding screen reads and drives. */
export interface SeedRunController {
  /** Every document in the run, in pick order. */
  items: SeedItem[];
  /** How much has landed, waits, or did not land. */
  tally: SeedRunTally;
  /** The tier every document in the next pick will be stored at. */
  classification: JournalClassification;
  /** Choose the tier — always before a pick, never after the fact. */
  chooseClassification: (_tier: JournalClassification) => void;
  /** Open the picker and send whatever comes back. */
  choose: () => Promise<void>;
  /**
   * Queue already-chosen documents and send them one at a time, at the tier
   * chosen now. How a reviewed folder import enters the same run as a pick.
   */
  sendDocuments: (_documents: readonly PickedDocument[]) => Promise<void>;
  /**
   * Send again only the documents that did not go over and may (#3556), each
   * under the same identity and tier it first went with. Nothing that landed
   * is sent again. Does nothing while a run is going over.
   */
  retryFailed: () => Promise<void>;
  /** How many documents {@link retryFailed} would send now. */
  retryableCount: number;
  /**
   * Stop the run: nothing still queued or waiting is sent, and each such
   * document settles as `cancelled`. The document already in flight is left to
   * finish, because its request is with the server and no client can un-send it.
   */
  cancel: () => void;
  /** A one-line word about a pick that yielded nothing; null otherwise. */
  notice: string | null;
  /** Whether documents are still going over. */
  isSending: boolean;
  /** Whether the next document is being held for a moment: paced, or waiting out a 429. */
  isPaused: boolean;
  /**
   * Whether anything in this run was held back for want of the upload consent.
   *
   * Read off the outcomes the server actually returned rather than checked
   * ahead of time: the consent gate lives in one place, and a client that
   * pre-flighted it would be a second reading of the same permission, free to
   * disagree with the one that decides.
   */
  needsConsent: boolean;
}

/** Pair each picked document with a run entry, already settled if unreadable. */
function toQueuedDocuments(
  documents: readonly PickedDocument[],
  from: number,
  tier: JournalClassification,
): QueuedDocument[] {
  return documents.map((document, index) => ({
    entry: {
      id: `seed-${from + index}`,
      // A folder document is named by its path, so two `Index.md` rows differ.
      name: document.source?.relativePath ?? document.name,
      status: document.seedable ? 'queued' : 'unsupported_format',
    },
    document,
    tier,
  }));
}

/**
 * What to say about a pick that produced no document to send.
 *
 * `cancelled` here is the picker being dismissed, which is not the run being
 * stopped — that one settles a document at the `cancelled` *status*. The two
 * words come from different vocabularies and say different things.
 */
function emptyPickNotice(kind: 'cancelled' | 'failed'): string {
  return kind === 'cancelled' ? SEED_CANCELLED_NOTICE : SEED_FAILED_PICK_NOTICE;
}

/** What one document's send needs from its run. */
interface SendContext {
  dispatch: Dispatch<SeedRunAction>;
  signal: AbortSignal;
  pacer: SeedUploadPacer;
}

/** Hold a document for `ms`, shown as waiting; false if the run stopped meanwhile. */
async function holdFor(id: string, ms: number, context: SendContext): Promise<boolean> {
  context.dispatch({ type: 'wait', id });
  return waitOrStop(ms, context.signal);
}

/**
 * Wait for the pace to allow a send, then make one attempt. Null when the run
 * stopped during the wait, so the document never went.
 */
async function pacedAttempt(
  id: string,
  queued: QueuedDocument,
  context: SendContext,
): Promise<SeedAttempt | null> {
  const paceMs = context.pacer.delayMs();
  if (paceMs > 0 && !(await holdFor(id, paceMs, context))) return null;
  context.dispatch({ type: 'start', id });
  const attempt = await attemptSeedDocument(queued.document, queued.tier);
  if (attempt.answered) context.pacer.record();
  return attempt;
}

/**
 * Send one document, waiting out a 429 a bounded number of times, and answer
 * the status it settles on. A wait cut short by the run stopping settles as
 * `cancelled`: the refused attempt kept nothing, and no other was made.
 */
async function sendOne(
  id: string,
  queued: QueuedDocument,
  context: SendContext,
): Promise<SettledSeedStatus> {
  let attempt = await pacedAttempt(id, queued, context);
  for (let waits = 0; attempt !== null && attempt.status === 'rate_limited'; waits += 1) {
    const waitMs = rateLimitWaitMs(attempt.retryAfterSeconds);
    if (waits >= MAX_SEED_RATE_LIMIT_WAITS || waitMs === null) break;
    if (!(await holdFor(id, waitMs, context))) return 'cancelled';
    attempt = await pacedAttempt(id, queued, context);
  }
  return attempt === null ? 'cancelled' : attempt.status;
}

/**
 * Send these documents, one at a time, recording each outcome, and answer the
 * batch's own final state.
 *
 * The order comes from the state machine rather than from the array: a local
 * copy of the batch's run is advanced by the same reducer the screen renders
 * from, and {@link selectNextQueued} decides what goes next. That is what makes
 * "one in flight at a time" a property of the machine instead of a promise the
 * loop makes — the loop cannot start a second document while one is in flight,
 * because the selector will not offer it one.
 *
 * The signal is read between documents and by every wait, never handed to the
 * request. A loop held by this callback's stack outlives the screen that
 * started it, so without the check an abandoned run keeps uploading while the
 * person sees an empty screen — and aborting mid-request instead would leave
 * the opposite divergence, a document the server accepted that nothing on
 * device recorded. Checked here, an aborted run stops cleanly at a document
 * boundary: what was sent is known, and what was not was never sent.
 */
async function sendSequentially(
  queued: readonly QueuedDocument[],
  context: SendContext,
): Promise<SeedRunState> {
  const documents = new Map(queued.map((item) => [item.entry.id, item]));
  let batch = seedRunReducer(EMPTY_SEED_RUN, {
    type: 'add',
    entries: queued.map((item) => item.entry),
  });
  for (let next = selectNextQueued(batch); next !== null; next = selectNextQueued(batch)) {
    if (context.signal.aborted) break;
    const document = documents.get(next.id);
    if (!document) break;
    batch = seedRunReducer(batch, { type: 'start', id: next.id });
    // Awaited inside the loop deliberately: this is the one-at-a-time guarantee.
    const status = await sendOne(next.id, document, context);
    context.dispatch({ type: 'settle', id: next.id, status });
    batch = seedRunReducer(batch, { type: 'settle', id: next.id, status });
  }
  return batch;
}

/** The run's items in pick order, for rendering. */
function orderedItems(run: SeedRunState): SeedItem[] {
  const ordered: SeedItem[] = [];
  for (const id of run.order) {
    const item = run.items[id];
    if (item) ordered.push(item);
  }
  return ordered;
}

/**
 * Drop every handle a retry can no longer use: a document that landed, was
 * refused for good, was stopped, or has spent its retries.
 */
function pruneHeld(held: Map<string, HeldDocument>, batch: SeedRunState): void {
  for (const id of batch.order) {
    const status = batch.items[id]?.status;
    const kept = held.get(id);
    const usable =
      kept !== undefined &&
      status !== undefined &&
      isRetryableSeedStatus(status) &&
      kept.retries < MAX_SEED_RETRIES_PER_DOCUMENT;
    if (!usable) held.delete(id);
  }
}

/**
 * Take the held documents a retry will send, counting the retry against each,
 * as a batch to queue. An id with no handle left is skipped.
 */
function takeForRetry(held: Map<string, HeldDocument>, ids: readonly string[]): QueuedDocument[] {
  const queued: QueuedDocument[] = [];
  for (const id of ids) {
    const kept = held.get(id);
    if (kept === undefined) continue;
    kept.retries += 1;
    queued.push({
      entry: { id, name: kept.document.name, status: 'queued' },
      document: kept.document,
      tier: kept.tier,
    });
  }
  return queued;
}

/** One batch at a time through the paced sender, with the handles a retry needs. */
interface BatchRunner {
  run: (_queued: readonly QueuedDocument[]) => Promise<void>;
  cancel: () => void;
  isSending: boolean;
  /** Read synchronously, so a second batch cannot start before a render catches up. */
  sendingRef: { current: boolean };
  /** Sent documents' handles, for a retry; never in the reducer, a log, or storage. */
  heldRef: { current: Map<string, HeldDocument> };
  /** The documents whose handles a retry still holds. */
  heldIds: ReadonlySet<string>;
}

/**
 * Run batches through {@link sendSequentially}, stoppable by `cancel` and by
 * unmount, keeping each sent document's handle only while a retry may use it.
 */
function useBatchRunner(dispatch: Dispatch<SeedRunAction>): BatchRunner {
  const [isSending, setIsSending] = useState(false);
  const [heldIds, setHeldIds] = useState<ReadonlySet<string>>(() => new Set());
  // Held in refs rather than in state: the loop reads them, nothing renders
  // them, and a re-render must not hand an in-flight run a fresh controller.
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const heldRef = useRef(new Map<string, HeldDocument>());
  const [pacer] = useState(() => createSeedUploadPacer());

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: 'cancel' });
  }, [dispatch]);

  // The safety net under the navigation guard: a screen can be torn down by
  // routes the guard never sees, and an unmounted run that kept uploading is
  // the exact divergence between what the person saw and what the server holds.
  // The handles a retry would have used go with the screen.
  useEffect(() => {
    const held = heldRef.current;
    return () => {
      abortRef.current?.abort();
      held.clear();
    };
  }, []);

  const run = useCallback(
    async (queued: readonly QueuedDocument[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      sendingRef.current = true;
      setIsSending(true);
      try {
        const batch = await sendSequentially(queued, {
          dispatch,
          signal: controller.signal,
          pacer,
        });
        pruneHeld(heldRef.current, batch);
      } finally {
        sendingRef.current = false;
        setIsSending(false);
        setHeldIds(new Set(heldRef.current.keys()));
      }
    },
    [dispatch, pacer],
  );

  return { run, cancel, isSending, sendingRef, heldRef, heldIds };
}

/** The sequential sender a run's picks, reviewed folders and retries all go through. */
interface RunSender {
  sendDocuments: (_documents: readonly PickedDocument[]) => Promise<void>;
  retry: (_ids: readonly string[]) => Promise<void>;
  cancel: () => void;
  isSending: boolean;
  /** The documents whose handles a retry still holds. */
  heldIds: ReadonlySet<string>;
}

/** Queue picked documents, or a retry of held ones, into the run and send them. */
function useRunSender(
  classification: JournalClassification,
  dispatch: Dispatch<SeedRunAction>,
): RunSender {
  const { run, cancel, isSending, sendingRef, heldRef, heldIds } = useBatchRunner(dispatch);
  // Monotonic so a document picked twice, or two files of the same name, each
  // get their own row instead of overwriting one another.
  const mintedCount = useRef(0);

  const sendDocuments = useCallback(
    async (documents: readonly PickedDocument[]) => {
      const queued = toQueuedDocuments(documents, mintedCount.current, classification);
      mintedCount.current += queued.length;
      dispatch({ type: 'add', entries: queued.map((item) => item.entry) });
      for (const { entry, document, tier } of queued) {
        heldRef.current.set(entry.id, { document, tier, retries: 0 });
      }
      await run(queued);
    },
    [classification, dispatch, heldRef, run],
  );

  const retry = useCallback(
    async (ids: readonly string[]) => {
      if (sendingRef.current) return;
      const queued = takeForRetry(heldRef.current, ids);
      if (queued.length === 0) return;
      dispatch({ type: 'requeue', ids: queued.map((item) => item.entry.id) });
      await run(queued);
    },
    [dispatch, heldRef, run, sendingRef],
  );

  return { sendDocuments, retry, cancel, isSending, heldIds };
}

/** The seeding run's state plus the actions the screen offers. */
export function useSeedRun(): SeedRunController {
  const [run, dispatch] = useReducer(seedRunReducer, EMPTY_SEED_RUN);
  const [classification, setClassification] = useState<JournalClassification>(
    DEFAULT_SEED_CLASSIFICATION,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const { sendDocuments, retry, cancel, isSending, heldIds } = useRunSender(
    classification,
    dispatch,
  );

  const choose = useCallback(async () => {
    const picked = await pickSeedDocuments();
    if (picked.kind !== 'picked') {
      setNotice(emptyPickNotice(picked.kind));
      return;
    }
    setNotice(null);
    await sendDocuments(picked.documents);
  }, [sendDocuments]);

  const items = useMemo(() => orderedItems(run), [run]);
  const retryableIds = useMemo(
    () =>
      items
        .filter((item) => isRetryableSeedStatus(item.status) && heldIds.has(item.id))
        .map((item) => item.id),
    [items, heldIds],
  );
  const retryFailed = useCallback(() => retry(retryableIds), [retry, retryableIds]);

  return {
    items,
    tally: seedRunTally(run),
    classification,
    chooseClassification: setClassification,
    choose,
    sendDocuments,
    retryFailed,
    retryableCount: retryableIds.length,
    cancel,
    notice,
    isSending,
    isPaused: items.some((item) => item.status === 'waiting'),
    needsConsent: items.some((item) => item.status === 'consent_required'),
  };
}
