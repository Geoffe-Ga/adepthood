/**
 * What the journal page still owes the server, and how a retry pays it (#2930).
 *
 * The page has four independent writes that can fail: the body/title autosave,
 * the Finish write, the privacy tier and the Aspect chord. Each failure is
 * recorded here in its own lane, so a later success on one lane can never
 * erase another lane's failure, and the footer's "Couldn't save" hint is
 * DERIVED from this record rather than being a value any writer can overwrite.
 *
 * Pure: no React, no API. The hooks in ``useSaveRetry`` hold the state and run
 * the plan this module draws up.
 */
import type { AspectChordValue } from './AspectChordControl';

import type { JournalClassification } from '@/api';

/** Every state the footer's save hint can show. */
export type SaveState =
  'idle' | 'typing' | 'saving' | 'saved' | 'error' | 'weekTaken' | 'vaultWithdrawalPending';

/**
 * What a writer may publish. ``error`` is excluded on purpose: it is derived
 * from a non-empty {@link PendingRetry}, so a writer cannot show it (or clear
 * it) without recording what failed.
 */
export type PublishedSaveState = Exclude<SaveState, 'error'>;

export type RetryLane = 'body' | 'finish' | 'classification' | 'chord';

/** One failed write, carrying the value it tried to persist where it has one. */
export type RetryFailure =
  | { lane: 'body' }
  | { lane: 'finish' }
  | { lane: 'classification'; value: JournalClassification }
  | { lane: 'chord'; value: AspectChordValue };

/** One write a retry will re-attempt, in order. */
export type RetryStep = RetryFailure;

/** The failed writes still owed, one independent lane per write. */
export interface PendingRetry {
  body: boolean;
  finish: boolean;
  /** The tier the failed PATCH tried to set, or null when that lane is clear. */
  classification: JournalClassification | null;
  /** The chord the failed PATCH tried to set, or null when that lane is clear. */
  chord: AspectChordValue | null;
}

/** What started a retry: the footer's Retry button, or the device coming back online. */
export type RetryTrigger = 'tap' | 'reconnect';

export interface RetryPlan {
  steps: RetryStep[];
  /** Lanes deliberately NOT re-sent; the caller clears them without a request. */
  dropped: RetryLane[];
}

export const NO_PENDING_RETRY: PendingRetry = Object.freeze({
  body: false,
  finish: false,
  classification: null,
  chord: null,
});

/**
 * How private each tier is, higher is stricter. Mirrors the most-open →
 * most-private order of ``PrivacyTierControl``'s options.
 */
export const CLASSIFICATION_STRICTNESS: Readonly<Record<JournalClassification, number>> =
  Object.freeze({ public: 0, personal: 1, intimate: 2 });

/** The published states that describe something happening right now, so they
 *  outrank an older failure in the hint. */
const TRANSIENT_STATES: ReadonlySet<PublishedSaveState> = new Set<PublishedSaveState>([
  'typing',
  'saving',
  'weekTaken',
  'vaultWithdrawalPending',
]);

/** Record a failure in its own lane; a later failure overwrites the attempted value. */
export function recordFailure(pending: PendingRetry, failure: RetryFailure): PendingRetry {
  switch (failure.lane) {
    case 'body':
      return { ...pending, body: true };
    case 'finish':
      return { ...pending, finish: true };
    case 'classification':
      return { ...pending, classification: failure.value };
    case 'chord':
      return { ...pending, chord: failure.value };
  }
}

function isLaneClear(pending: PendingRetry, lane: RetryLane): boolean {
  const value = pending[lane];
  return value === false || value === null;
}

/** Clear exactly one lane; returns the same object when it was already clear. */
export function recordSuccess(pending: PendingRetry, lane: RetryLane): PendingRetry {
  if (isLaneClear(pending, lane)) return pending;
  return { ...pending, [lane]: NO_PENDING_RETRY[lane] };
}

export function hasPendingRetry(pending: PendingRetry): boolean {
  return (
    pending.body || pending.finish || pending.classification !== null || pending.chord !== null
  );
}

/**
 * The hint the footer shows. Something happening now (typing, saving, a
 * non-retryable condition) outranks an older failure; otherwise any pending
 * lane reads as ``error``; otherwise the last published state stands.
 */
export function deriveHintState(published: PublishedSaveState, pending: PendingRetry): SaveState {
  if (TRANSIENT_STATES.has(published)) return published;
  return hasPendingRetry(pending) ? 'error' : published;
}

/** True when ``attempted`` would leave the entry less private than ``displayed``. */
export function isTierLooser(
  attempted: JournalClassification,
  displayed: JournalClassification,
): boolean {
  return CLASSIFICATION_STRICTNESS[attempted] < CLASSIFICATION_STRICTNESS[displayed];
}

/**
 * The text steps. Finish carries the full body, so on a tap it subsumes a
 * pending body. A reconnect never finishes an entry on its own (that would
 * switch the page to read mode without a tap); it still re-sends the body.
 */
function textSteps(pending: PendingRetry, trigger: RetryTrigger): RetryStep[] {
  if (pending.finish && trigger === 'tap') return [{ lane: 'finish' }];
  return pending.body ? [{ lane: 'body' }] : [];
}

/**
 * Draw up what a retry re-sends. A pending tier LOOSER than the one the control
 * shows is never sent by either trigger — a generic "Retry saving" tap is not
 * consent to make an entry more public — so it is dropped instead, and the
 * writer re-taps that tier deliberately if they still want it.
 */
export function planRetry(
  pending: PendingRetry,
  trigger: RetryTrigger,
  displayedTier: JournalClassification,
): RetryPlan {
  const steps = textSteps(pending, trigger);
  const dropped: RetryLane[] = [];
  const tier = pending.classification;
  if (tier !== null && isTierLooser(tier, displayedTier)) dropped.push('classification');
  else if (tier !== null) steps.push({ lane: 'classification', value: tier });
  if (pending.chord !== null) steps.push({ lane: 'chord', value: pending.chord });
  return { steps, dropped };
}

export interface ReconnectGate {
  wasOnline: boolean;
  isOnline: boolean;
  hint: SaveState;
  writeInFlight: boolean;
  dispatching: boolean;
}

/** Retry on reconnect only on the offline → online edge, only for a visible
 *  failure, and never on top of a write or retry already running. */
export function shouldRetryOnReconnect(gate: ReconnectGate): boolean {
  const edge = !gate.wasOnline && gate.isOnline;
  const idle = !gate.writeInFlight && !gate.dispatching;
  return edge && idle && gate.hint === 'error';
}
