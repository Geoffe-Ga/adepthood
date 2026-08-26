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
 * PRIVACY: a document's bytes live in the loop's local scope for the length of
 * its own request. Nothing about them enters the run state, a notice, or a log.
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

import { importSeedDocument } from './importSeedDocument';
import { pickSeedDocuments, type PickedDocument } from './pickSeedDocuments';
import { SEED_CANCELLED_NOTICE, SEED_FAILED_PICK_NOTICE } from './seedCopy';
import {
  EMPTY_SEED_RUN,
  seedRunReducer,
  seedRunTally,
  selectNextQueued,
  type SeedEntry,
  type SeedItem,
  type SeedRunAction,
  type SeedRunState,
  type SeedRunTally,
} from './seedRun';

import type { JournalClassification } from '@/api';

/** The tier a seeded document takes when the person has not changed it. */
export const DEFAULT_SEED_CLASSIFICATION: JournalClassification = 'personal';

/** One queued document paired with the run entry that tracks it. */
interface QueuedDocument {
  entry: SeedEntry;
  document: PickedDocument;
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
   * Stop the run: nothing still queued is sent, and each such document settles
   * as `cancelled`. The document already in flight is left to finish, because
   * its request is with the server and no client can un-send it.
   */
  cancel: () => void;
  /** A one-line word about a pick that yielded nothing; null otherwise. */
  notice: string | null;
  /** Whether documents are still going over. */
  isSending: boolean;
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
function toQueuedDocuments(documents: readonly PickedDocument[], from: number): QueuedDocument[] {
  return documents.map((document, index) => ({
    entry: {
      id: `seed-${from + index}`,
      name: document.name,
      status: document.seedable ? 'queued' : 'unsupported_format',
    },
    document,
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

/**
 * Send this pick's documents, one at a time, recording each outcome.
 *
 * The order comes from the state machine rather than from the array: a local
 * copy of the batch's run is advanced by the same reducer the screen renders
 * from, and {@link selectNextQueued} decides what goes next. That is what makes
 * "one in flight at a time" a property of the machine instead of a promise the
 * loop makes — the loop cannot start a second document while one is in flight,
 * because the selector will not offer it one.
 *
 * The signal is read between iterations rather than handed to the request. A
 * loop held by this callback's stack outlives the screen that started it, so
 * without the check an abandoned run keeps uploading while the person sees an
 * empty screen — and aborting mid-request instead would leave the opposite
 * divergence, a document the server accepted that nothing on device recorded.
 * Checked here, an aborted run stops cleanly at a document boundary: what was
 * sent is known, and what was not was never sent.
 */
async function sendSequentially(
  queued: readonly QueuedDocument[],
  tier: JournalClassification,
  dispatch: Dispatch<SeedRunAction>,
  signal: AbortSignal,
): Promise<void> {
  const documents = new Map(queued.map((item) => [item.entry.id, item.document]));
  let batch = seedRunReducer(EMPTY_SEED_RUN, {
    type: 'add',
    entries: queued.map((item) => item.entry),
  });
  for (let next = selectNextQueued(batch); next !== null; next = selectNextQueued(batch)) {
    if (signal.aborted) break;
    const document = documents.get(next.id);
    if (!document) break;
    dispatch({ type: 'start', id: next.id });
    batch = seedRunReducer(batch, { type: 'start', id: next.id });
    // Awaited inside the loop deliberately: this is the one-at-a-time guarantee.
    const status = await importSeedDocument(document, tier);
    dispatch({ type: 'settle', id: next.id, status });
    batch = seedRunReducer(batch, { type: 'settle', id: next.id, status });
  }
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

/** The seeding run's state plus the actions the screen offers. */
export function useSeedRun(): SeedRunController {
  const [run, dispatch] = useReducer(seedRunReducer, EMPTY_SEED_RUN);
  const [classification, setClassification] = useState<JournalClassification>(
    DEFAULT_SEED_CLASSIFICATION,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  // Monotonic so a document picked twice, or two files of the same name, each
  // get their own row instead of overwriting one another.
  const mintedCount = useRef(0);
  // Held in a ref rather than in state: the loop reads it, nothing renders it,
  // and a re-render must not hand an in-flight run a fresh controller.
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: 'cancel' });
  }, []);

  // The safety net under the navigation guard: a screen can be torn down by
  // routes the guard never sees, and an unmounted run that kept uploading is
  // the exact divergence between what the person saw and what the server holds.
  useEffect(() => () => abortRef.current?.abort(), []);

  const choose = useCallback(async () => {
    const picked = await pickSeedDocuments();
    if (picked.kind !== 'picked') {
      setNotice(emptyPickNotice(picked.kind));
      return;
    }
    setNotice(null);
    const queued = toQueuedDocuments(picked.documents, mintedCount.current);
    mintedCount.current += queued.length;
    dispatch({ type: 'add', entries: queued.map((item) => item.entry) });
    const controller = new AbortController();
    abortRef.current = controller;
    setIsSending(true);
    try {
      await sendSequentially(queued, classification, dispatch, controller.signal);
    } finally {
      setIsSending(false);
    }
  }, [classification]);

  const items = useMemo(() => orderedItems(run), [run]);

  return {
    items,
    tally: seedRunTally(run),
    classification,
    chooseClassification: setClassification,
    choose,
    cancel,
    notice,
    isSending,
    needsConsent: items.some((item) => item.status === 'consent_required'),
  };
}
