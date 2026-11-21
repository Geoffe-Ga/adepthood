/**
 * The one vault pass a drained upload run is owed (#3773), and the quiet line
 * that follows it.
 *
 * Documents sent as part of an upload run no longer weave themselves into the
 * vault's ontology one at a time. When the upload queue drains with something
 * landed, this asks the server for a single pass over the whole run --
 * classification (with its Praxis pages), then every linking stage -- by
 * pressing `POST /corpus/import/complete` with the run's own id. The server
 * records the run and does the work in its own background, so the pass goes on
 * whether or not this app stays open; what this store keeps is only whether to
 * say "Settling what you've sent…", that it settled, or that the vault was out
 * of reach.
 *
 * **Quiet by design.** A refused or failed press leaves nothing on screen: the
 * documents themselves landed, and the vault's own passes will reach them in
 * time. Nothing here is ever an error the person must act on.
 *
 * **One run followed at a time.** A newer drain takes over from the one being
 * followed -- its pass is the one still to come -- and signing out stops the
 * following, through the store registry.
 */
import { create } from 'zustand';

import { registerStoreReset } from './registry';
import { onUploadQueueDrained, type UploadQueueDrain } from './useUploadQueueStore';

import { corpus, type BulkImportCompletion } from '@/api';

/** How long after the press the first read waits, in ms; each wait then doubles. */
export const SETTLE_POLL_INITIAL_MS = 2_000;

/** The longest wait between reads, in ms: a pass can take many minutes. */
export const SETTLE_POLL_MAX_MS = 30_000;

/** How long "settled" stays on screen before the line goes quiet, in ms. */
export const SETTLED_VISIBLE_MS = 8_000;

/** How many times a press is tried before the app stops asking. */
const MAX_PRESS_ATTEMPTS = 3;

/** How many reads in a row may fail before the app stops following. */
const MAX_READ_FAILURES = 5;

/** The fewest documents a run must have landed for a pass to be worth asking for. */
const MIN_LANDED = 1;

/** Where the followed pass stands, as the line says it. */
export type VaultSettlePhase = 'idle' | 'settling' | 'settled' | 'deferred';

interface VaultSettleState {
  /** The upload run whose pass is being followed; null while idle. */
  batchId: string | null;
  phase: VaultSettlePhase;
  /** Stop following and say nothing (sign-out, tests). */
  reset: () => void;
}

/** Bumped by every new drain and every reset, so a superseded follower stops. */
let generation = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const INITIAL_STATE = { batchId: null as string | null, phase: 'idle' as VaultSettlePhase };

function clearPending(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
}

/** Wait `ms`, unless a newer drain or a reset supersedes `mine` first. */
function wait(ms: number, mine: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (mine !== generation) {
      resolve(false);
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      resolve(mine === generation);
    }, ms);
  });
}

function settle(phase: VaultSettlePhase, mine: number): void {
  if (mine !== generation) return;
  useVaultSettleStore.setState(phase === 'idle' ? { ...INITIAL_STATE } : { phase });
}

/** Press, retrying a few times; the answer, or null once the app stops asking. */
async function press(drain: UploadQueueDrain, mine: number): Promise<BulkImportCompletion | null> {
  for (let attempt = 1; attempt <= MAX_PRESS_ATTEMPTS; attempt += 1) {
    try {
      return await corpus.completeImport({ batchId: drain.runId, landed: drain.landed });
    } catch {
      if (attempt === MAX_PRESS_ATTEMPTS) return null;
      if (!(await wait(SETTLE_POLL_INITIAL_MS * attempt, mine))) return null;
    }
  }
  return null;
}

/** The phase a run's state is said as, or null while it is still going. */
function phaseOf(answer: BulkImportCompletion): VaultSettlePhase | null {
  const run = answer.run;
  if (run === null) return 'idle';
  if (run.state === 'completed') return 'settled';
  if (run.state === 'stopped' || run.state === 'failed') return 'deferred';
  return null;
}

/** Read the run until it ends, backing off between reads; the phase to end on. */
async function follow(batchId: string, mine: number): Promise<VaultSettlePhase> {
  let delay = SETTLE_POLL_INITIAL_MS;
  let failures = 0;
  while (await wait(delay, mine)) {
    try {
      const ended = phaseOf(await corpus.importCompletion(batchId));
      if (ended !== null) return ended;
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= MAX_READ_FAILURES) return 'idle';
    }
    delay = Math.min(delay * 2, SETTLE_POLL_MAX_MS);
  }
  return 'idle';
}

async function run(drain: UploadQueueDrain, mine: number): Promise<void> {
  const answer = await press(drain, mine);
  if (answer === null) {
    settle('idle', mine);
    return;
  }
  const ended = phaseOf(answer) ?? (await follow(drain.runId, mine));
  settle(ended, mine);
  if (ended === 'settled' && (await wait(SETTLED_VISIBLE_MS, mine))) settle('idle', mine);
}

/**
 * Ask for the pass a drained run is owed, and follow it. Does nothing for a
 * run that landed nothing. Exported for tests; the queue's drain calls it.
 */
export function settleDrainedRun(drain: UploadQueueDrain): void {
  if (drain.landed < MIN_LANDED) return;
  clearPending();
  generation += 1;
  const mine = generation;
  useVaultSettleStore.setState({ batchId: drain.runId, phase: 'settling' });
  void run(drain, mine);
}

function resetSettle(): void {
  generation += 1;
  clearPending();
  useVaultSettleStore.setState({ ...INITIAL_STATE });
}

export const useVaultSettleStore = create<VaultSettleState>(() => ({
  ...INITIAL_STATE,
  reset: resetSettle,
}));

onUploadQueueDrained(settleDrainedRun);

registerStoreReset(() => {
  useVaultSettleStore.getState().reset();
});
