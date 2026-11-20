/**
 * The Seed screen's view of the app-level upload queue (#3772): what it reads
 * and drives, with the picker and the privacy choice that belong to the screen.
 *
 * The run itself lives in {@link useUploadQueueStore}, not here. Leaving the
 * screen does not stop it, and a remount reads the same rows; a pick made while
 * documents are still going over is queued behind them as its own batch. How a
 * document is sent -- paced, patient with a 429 and a busy vault (#3556, #3770)
 * -- is `seedSend.ts`; the queue, its one pacer and its drain are the store's.
 *
 * PRIVACY: nothing about a document's bytes reaches this hook. The picked
 * handles a send or a retry needs are held by the queue's runtime, never in
 * state, a log, or storage.
 */
import { useCallback, useMemo, useState } from 'react';

import { pickSeedDocuments, type PickedDocument } from './pickSeedDocuments';
import { SEED_CANCELLED_NOTICE, SEED_FAILED_PICK_NOTICE } from './seedCopy';
import {
  isRetryableSeedStatus,
  isSkippedSeedStatus,
  seedRunTally,
  tallySeedItems,
  type SeedItem,
  type SeedRunState,
  type SeedRunTally,
} from './seedRun';

import type { JournalClassification } from '@/api';
import {
  MAX_SEED_RETRIES_PER_DOCUMENT,
  useUploadQueueStore,
  type SeedBatch,
} from '@/store/useUploadQueueStore';

export { MAX_SEED_RETRIES_PER_DOCUMENT };

/** The tier a seeded document takes when the person has not changed it. */
export const DEFAULT_SEED_CLASSIFICATION: JournalClassification = 'personal';

/**
 * Where one batch stands: nothing of it sent yet, some of it going over, or
 * every document settled.
 */
export type SeedBatchState = 'queued' | 'sending' | 'settled';

/** One batch as the run list shows it, under its own header row. */
export interface SeedBatchView {
  id: string;
  /** The folder's import name; null for files picked one by one. */
  name: string | null;
  items: SeedItem[];
  /** How many of its documents are still in flight or waiting to go. */
  remaining: number;
  state: SeedBatchState;
  /** Its own landed, failed, remaining and skipped counts (#3771). */
  tally: SeedRunTally;
}

/** What the seeding screen reads and drives. */
export interface SeedRunController {
  /** Every document in the queue this session, in the order it was queued. */
  items: SeedItem[];
  /** The same documents by the batch they came in, oldest first (#3772). */
  batches: SeedBatchView[];
  /** How much has landed, failed, is still to go, or was skipped (#3771). */
  tally: SeedRunTally;
  /** The tier every document in the next pick will be stored at. */
  classification: JournalClassification;
  /** Choose the tier — always before a pick, never after the fact. */
  chooseClassification: (_tier: JournalClassification) => void;
  /** Open the picker and queue whatever comes back; open while a run is going (#3772). */
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
   * Stop the whole queue: nothing still queued or waiting is sent, and each such
   * document settles as `cancelled`. The document already in flight is left to
   * finish, because its request is with the server and no client can un-send it.
   */
  cancel: () => void;
  /** Stop one batch the same way, leaving the others to go over (#3772). */
  cancelBatch: (_batchId: string) => void;
  /** A one-line word about a pick that yielded nothing; null otherwise. */
  notice: string | null;
  /** Whether the queue is still sending, from this screen or before it was opened. */
  isSending: boolean;
  /** Whether the next document is being held for a moment: paced, or waiting out a 429. */
  isPaused: boolean;
  /** Whether the next document is waiting out a busy vault (#3770). */
  isWaitingOnVault: boolean;
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

/** The run's items in queue order, for rendering. */
function orderedItems(run: SeedRunState): SeedItem[] {
  const ordered: SeedItem[] = [];
  for (const id of run.order) {
    const item = run.items[id];
    if (item) ordered.push(item);
  }
  return ordered;
}

/**
 * Where a batch stands, read off its documents. A skipped file settled on
 * arrival (#3771), so it says nothing about whether the batch has started.
 */
function batchState(items: readonly SeedItem[], remaining: number): SeedBatchState {
  if (remaining === 0) return 'settled';
  return items.every((item) => item.status === 'queued' || isSkippedSeedStatus(item.status))
    ? 'queued'
    : 'sending';
}

/** One batch with its documents and how far it has got. */
function toBatchView(batch: SeedBatch, run: SeedRunState): SeedBatchView {
  const items: SeedItem[] = [];
  for (const id of batch.ids) {
    const item = run.items[id];
    if (item) items.push(item);
  }
  const tally = tallySeedItems(items);
  return {
    id: batch.id,
    name: batch.name,
    items,
    remaining: tally.remaining,
    state: batchState(items, tally.remaining),
    tally,
  };
}

/** The queue's documents in order and by batch, and the ones a retry may send. */
function useQueueView(): {
  items: SeedItem[];
  batches: SeedBatchView[];
  retryableIds: string[];
  run: SeedRunState;
} {
  const run = useUploadQueueStore((state) => state.run);
  const batches = useUploadQueueStore((state) => state.batches);
  const heldIds = useUploadQueueStore((state) => state.heldIds);
  const items = useMemo(() => orderedItems(run), [run]);
  const batchViews = useMemo(() => batches.map((batch) => toBatchView(batch, run)), [batches, run]);
  const retryableIds = useMemo(
    () =>
      items
        .filter((item) => isRetryableSeedStatus(item.status) && heldIds.has(item.id))
        .map((item) => item.id),
    [items, heldIds],
  );
  return { items, batches: batchViews, retryableIds, run };
}

/** The seeding screen's view of the upload queue, plus the actions it offers. */
export function useSeedRun(): SeedRunController {
  const { items, batches, retryableIds, run } = useQueueView();
  const isSending = useUploadQueueStore((state) => state.isSending);
  const enqueue = useUploadQueueStore((state) => state.enqueue);
  const retry = useUploadQueueStore((state) => state.retry);
  const cancel = useUploadQueueStore((state) => state.cancelAll);
  const cancelBatch = useUploadQueueStore((state) => state.cancelBatch);
  const [classification, setClassification] = useState<JournalClassification>(
    DEFAULT_SEED_CLASSIFICATION,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const sendDocuments = useCallback(
    (documents: readonly PickedDocument[]) => enqueue(documents, classification),
    [enqueue, classification],
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

  const retryFailed = useCallback(() => retry(retryableIds), [retry, retryableIds]);

  return {
    items,
    batches,
    tally: seedRunTally(run),
    classification,
    chooseClassification: setClassification,
    choose,
    sendDocuments,
    retryFailed,
    retryableCount: retryableIds.length,
    cancel,
    cancelBatch,
    notice,
    isSending,
    isPaused: items.some((item) => item.status === 'waiting'),
    isWaitingOnVault: items.some((item) => item.status === 'vault_waiting'),
    needsConsent: items.some((item) => item.status === 'consent_required'),
  };
}
