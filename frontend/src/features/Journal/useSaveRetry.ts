/**
 * The React half of the journal page's save recovery (#2930): the ledger that
 * holds what failed, the single-flighted retry that re-sends it, and the
 * reconnect listener that fires that retry when the device comes back online.
 *
 * The decisions themselves (what counts as pending, what a retry sends, when a
 * reconnect may fire) live in the pure ``journalSaveRetry`` module.
 */
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AspectChordValue } from './AspectChordControl';
import {
  NO_PENDING_RETRY,
  deriveHintState,
  hasPendingRetry,
  planRetry,
  recordFailure,
  recordSuccess,
  shouldRetryOnReconnect,
  type PendingRetry,
  type PublishedSaveState,
  type RetryFailure,
  type RetryLane,
  type RetryStep,
  type RetryTrigger,
  type SaveState,
} from './journalSaveRetry';

import type { JournalClassification } from '@/api';
import { useNetworkStatus } from '@/context/NetworkStatusContext';

/** How a writer reports: publish what is happening, and record a lane's outcome. */
export interface SaveReporter {
  publish: (_state: PublishedSaveState) => void;
  fail: (_failure: RetryFailure) => void;
  succeed: (_lane: RetryLane) => void;
}

/** The ledger's stable handles: the reporter writers use, and the refs a retry reads. */
export interface LedgerPorts {
  reporter: SaveReporter;
  pendingRef: React.MutableRefObject<PendingRetry>;
  publishedRef: React.MutableRefObject<PublishedSaveState>;
}

export interface SaveLedger {
  /** Referentially stable across renders. */
  ports: LedgerPorts;
  /** The footer's hint, derived from the published state and the pending record. */
  hint: SaveState;
}

/** A value mirrored into a ref synchronously, so a retry reads it without waiting a render. */
function useMirroredState<T>(initial: T) {
  const ref = useRef<T>(initial);
  const [value, setValue] = useState<T>(initial);
  const set = useCallback((next: T) => {
    if (Object.is(next, ref.current)) return;
    ref.current = next;
    setValue(next);
  }, []);
  return { ref, value, set };
}

/** Own the published save state and the pending-retry record behind the save hint. */
export function useSaveLedger(): SaveLedger {
  const published = useMirroredState<PublishedSaveState>('idle');
  const pending = useMirroredState<PendingRetry>(NO_PENDING_RETRY);
  const { ref: pendingRef, set: setPending } = pending;
  const { ref: publishedRef, set: publish } = published;
  const ports = useMemo<LedgerPorts>(
    () => ({
      reporter: {
        publish,
        fail: (failure) => setPending(recordFailure(pendingRef.current, failure)),
        succeed: (lane) => setPending(recordSuccess(pendingRef.current, lane)),
      },
      pendingRef,
      publishedRef,
    }),
    [publish, pendingRef, publishedRef, setPending],
  );
  return { ports, hint: deriveHintState(published.value, pending.value) };
}

/** Everything a retry needs to re-send each lane through its ordinary writer. */
export interface SaveRetryPorts {
  ledger: LedgerPorts;
  /** The tier the control currently shows; a looser pending tier is never sent. */
  displayedTier: () => JournalClassification;
  /** Finish through the edit gate, so status and the Finish error update too. */
  retryFinish: () => Promise<void>;
  /** Re-run the single-flight body writer on the CURRENT text; it settles the body lane. */
  retryBody: () => Promise<unknown>;
  applyClassification: (_tier: JournalClassification) => Promise<void>;
  applyChord: (_chord: AspectChordValue) => Promise<void>;
}

async function runStep(step: RetryStep, ports: SaveRetryPorts): Promise<void> {
  switch (step.lane) {
    case 'finish':
      return ports.retryFinish();
    case 'body':
      await ports.retryBody();
      return undefined;
    case 'classification':
      return ports.applyClassification(step.value);
    case 'chord':
      return ports.applyChord(step.value);
  }
}

/**
 * Re-send whatever failed, one step at a time (the tier/chord persisters assume
 * one PATCH in flight). Ends on a truthful "Saved" when nothing is left owed
 * and no step published an outcome of its own (a dropped tier, or a body that
 * turned out to be durable already, so the writer sent nothing).
 */
async function dispatchRetry(ports: SaveRetryPorts, trigger: RetryTrigger): Promise<void> {
  const { reporter, pendingRef, publishedRef } = ports.ledger;
  const plan = planRetry(pendingRef.current, trigger, ports.displayedTier());
  for (const lane of plan.dropped) reporter.succeed(lane);
  for (const step of plan.steps) await runStep(step, ports);
  if (!hasPendingRetry(pendingRef.current) && publishedRef.current === 'idle') {
    reporter.publish('saved');
  }
}

export interface SaveRetry {
  /** Re-send every failed write; a second call while one runs joins it. */
  retryFailedSave: (_trigger?: RetryTrigger) => Promise<void>;
  isDispatching: () => boolean;
}

/** The single-flighted retry dispatcher behind the footer's Retry and the reconnect. */
export function useSaveRetry(ports: SaveRetryPorts): SaveRetry {
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const dispatchRef = useRef<Promise<void> | null>(null);
  const retryFailedSave = useCallback((trigger: RetryTrigger = 'tap'): Promise<void> => {
    if (dispatchRef.current) return dispatchRef.current;
    const run = dispatchRetry(portsRef.current, trigger).finally(() => {
      dispatchRef.current = null;
    });
    dispatchRef.current = run;
    return run;
  }, []);
  const isDispatching = useCallback(() => dispatchRef.current != null, []);
  return { retryFailedSave, isDispatching };
}

export interface ReconnectRetryInput {
  hint: SaveState;
  isWriteInFlight: () => boolean;
  retry: SaveRetry;
}

/**
 * Fire one retry when the device comes back online, keeping the offline
 * banner's promise that writing syncs on reconnect. The effect depends only on
 * connectivity, so it runs once per edge; everything else is read fresh.
 */
export function useReconnectRetry(input: ReconnectRetryInput): void {
  const { isOnline } = useNetworkStatus();
  const wasOnlineRef = useRef(isOnline);
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    const { hint, isWriteInFlight, retry } = inputRef.current;
    const gate = {
      wasOnline,
      isOnline,
      hint,
      writeInFlight: isWriteInFlight(),
      dispatching: retry.isDispatching(),
    };
    if (shouldRetryOnReconnect(gate)) void retry.retryFailedSave('reconnect');
  }, [isOnline]);
}
