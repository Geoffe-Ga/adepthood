/**
 * How one document goes over: paced, patient with a 429 and with a busy vault,
 * and stoppable at every wait. The upload queue (#3772) drives these one
 * document at a time; nothing here knows about batches, screens or the queue.
 *
 * **Paced, and patient with a 429 (#3556).** Before each send the queue's one
 * {@link SeedUploadPacer} is asked whether the upload limit has room, and the
 * document is held (`waiting`) until it does. A 429 that comes anyway is waited
 * out for as long as its `Retry-After` says, at most
 * {@link MAX_SEED_RATE_LIMIT_WAITS} times per document.
 *
 * **Patient with a busy vault too (#3770).** A `vault_busy` answer is the vault
 * occupied with a pass of its own, not the document failing: the row reads
 * "Waiting for your vault…", the send waits as long as the answer named and
 * goes again, and none of it is charged against the pace. Those waits have
 * their own bound, {@link MAX_SEED_VAULT_BUSY_WAITS}.
 *
 * Two signals, because stopping and taking back are different acts. `signal`
 * stops the waits: a person stopping a batch never un-sends the document
 * already with the server. `requestSignal` reaches the request itself, and only
 * signing out aborts it.
 *
 * PRIVACY: a document's bytes live in {@link attemptSeedDocument}'s local scope
 * for the length of its own request. Nothing about them enters the run state.
 */
import { attemptSeedDocument, type SeedAttempt } from './importSeedDocument';
import type { PickedDocument } from './pickSeedDocuments';
import type { SeedEntry, SeedRunAction, SeedWaitCause, SettledSeedStatus } from './seedRun';
import {
  MAX_SEED_RATE_LIMIT_WAITS,
  MAX_SEED_VAULT_BUSY_WAITS,
  rateLimitWaitMs,
  vaultBusyWaitMs,
  waitOrStop,
  type SeedUploadPacer,
} from './seedUploadPacing';

import type { JournalClassification } from '@/api';

/**
 * One document the queue is sending: its run entry, its picked handle, and the
 * tier it goes at. The tier travels with the document, so a retry sends it at
 * the level it was first sent at, whatever the control says now.
 */
export interface QueuedDocument {
  entry: SeedEntry;
  document: PickedDocument;
  tier: JournalClassification;
}

/** What a send needs of a document: its handle and the tier it goes at. */
export type SendableDocument = Pick<QueuedDocument, 'document' | 'tier'>;

/** What one document's send needs from the queue. */
export interface SendContext {
  dispatch: (_action: SeedRunAction) => void;
  /** Stops every wait; the document then settles as `cancelled`. */
  signal: AbortSignal;
  /** Aborts the request itself; signing out only (#3772). */
  requestSignal: AbortSignal;
  pacer: SeedUploadPacer;
  /** The id every document of this queue run is sent with (#3770). */
  runId: string;
}

/** Pair each picked document with a run entry, already settled if unreadable. */
export function toQueuedDocuments(
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

/** Hold a document for `ms`, shown as waiting; false if the send stopped meanwhile. */
async function holdFor(
  id: string,
  ms: number,
  context: SendContext,
  cause: SeedWaitCause = 'pace',
): Promise<boolean> {
  context.dispatch({ type: 'wait', id, cause });
  return waitOrStop(ms, context.signal);
}

/**
 * Wait for the pace to allow a send, then make one attempt. Null when the send
 * stopped during the wait, so the document never went.
 */
async function pacedAttempt(
  id: string,
  queued: SendableDocument,
  context: SendContext,
): Promise<SeedAttempt | null> {
  const paceMs = context.pacer.delayMs();
  if (paceMs > 0 && !(await holdFor(id, paceMs, context))) return null;
  context.dispatch({ type: 'start', id });
  const attempt = await attemptSeedDocument(
    queued.document,
    queued.tier,
    context.runId,
    context.requestSignal,
  );
  if (attempt.answered) context.pacer.record();
  return attempt;
}

/** How many waits of each kind one document has taken so far. */
interface WaitsTaken {
  rateLimit: number;
  vaultBusy: number;
}

/** One wait a document will take before its next attempt. */
interface NextWait {
  ms: number;
  cause: SeedWaitCause;
}

/**
 * The wait an attempt earns, counting it against its own kind's budget, or null
 * when it settles here: an answer that is not a wait, a budget spent, or a 429
 * asking for longer than the run will sit through.
 */
function nextWait(attempt: SeedAttempt, taken: WaitsTaken): NextWait | null {
  if (attempt.status === 'vault_busy') {
    if (taken.vaultBusy >= MAX_SEED_VAULT_BUSY_WAITS) return null;
    taken.vaultBusy += 1;
    return { ms: vaultBusyWaitMs(attempt.retryAfterSeconds), cause: 'vault' };
  }
  if (attempt.status !== 'rate_limited' || taken.rateLimit >= MAX_SEED_RATE_LIMIT_WAITS) {
    return null;
  }
  const ms = rateLimitWaitMs(attempt.retryAfterSeconds);
  if (ms === null) return null;
  taken.rateLimit += 1;
  return { ms, cause: 'pace' };
}

/**
 * Send one document, waiting out a 429 or a busy vault a bounded number of
 * times each, and answer the status it settles on. A wait cut short by the send
 * stopping settles as `cancelled`: the refused attempt kept nothing, and no
 * other was made.
 */
export async function sendOne(
  id: string,
  queued: SendableDocument,
  context: SendContext,
): Promise<SettledSeedStatus> {
  const taken: WaitsTaken = { rateLimit: 0, vaultBusy: 0 };
  let attempt = await pacedAttempt(id, queued, context);
  while (attempt !== null) {
    const wait = nextWait(attempt, taken);
    if (wait === null) return attempt.status;
    if (!(await holdFor(id, wait.ms, context, wait.cause))) return 'cancelled';
    attempt = await pacedAttempt(id, queued, context);
  }
  return 'cancelled';
}
