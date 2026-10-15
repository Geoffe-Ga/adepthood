import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';

import { CORPUS_CONSENT_FAILURE } from './corpusConsentCopy';

import { captureSessionToken, corpusConsent, type CorpusConsent } from '@/api';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { registerStoreReset } from '@/store/registry';
import { decodeJwtPayload, isTokenExpired } from '@/utils/token';

interface ConsentState {
  epoch: number;
  accountGeneration: number;
  decisions: readonly CorpusConsent[] | null;
  error: string | null;
  pending: readonly string[];
}

/** A withdrawal question belongs to the confirmed decision it described. */
export interface ConsentConfirmation {
  epoch: number;
  decision: CorpusConsent;
}

export function confirmationMatches(
  question: ConsentConfirmation | null,
  epoch: number,
  decisions: readonly CorpusConsent[] | null,
): boolean {
  return (
    question !== null &&
    question.epoch === epoch &&
    (decisions ?? []).some(
      (row) =>
        row.source === question.decision.source &&
        row.granted &&
        row.decided_at === question.decision.decided_at,
    )
  );
}

let generation = 0;
const empty = (): ConsentState => ({
  epoch: generation,
  accountGeneration: getActiveUserGeneration(),
  decisions: null,
  error: null,
  pending: [],
});
const useConsentState = create<ConsentState>(() => empty());
let readers = 0;
let read: Promise<void> | null = null;
let revisions: Record<string, number> = {};

function reset(): void {
  generation += 1;
  read = null;
  revisions = {};
  useConsentState.setState(empty());
}

registerStoreReset(reset);

function currentOperation(
  epoch = generation,
  owner = getActiveUser(),
  accountGeneration = getActiveUserGeneration(),
): () => boolean {
  return () =>
    generation === epoch &&
    owner === getActiveUser() &&
    accountGeneration === getActiveUserGeneration();
}

function mergeRead(rows: CorpusConsent[], startedWith: Record<string, number>): CorpusConsent[] {
  const state = useConsentState.getState();
  return rows.map((row) => {
    if (startedWith[row.source] === revisions[row.source] && !state.pending.includes(row.source))
      return row;
    return state.decisions?.find((existing) => existing.source === row.source) ?? row;
  });
}

function confirmSource(source: string, confirmed: CorpusConsent): void {
  const latest = useConsentState.getState();
  useConsentState.setState({
    decisions: (latest.decisions ?? []).map((row) => (row.source === source ? confirmed : row)),
  });
}

function clearPending(source: string): void {
  useConsentState.setState({
    pending: useConsentState.getState().pending.filter((item) => item !== source),
  });
}

/** Admit only a captured credential belonging to the active authenticated namespace. */
function consentCredential(): string | null {
  const owner = getActiveUser();
  const token = captureSessionToken();
  if (parseUserId(owner) === null || !token || isTokenExpired(token)) return null;
  return parseUserId(decodeJwtPayload(token)?.sub) === owner ? token : null;
}

/** Coalesce the visible Settings surfaces; failed reads remain retryable. */
function load(): Promise<void> {
  if (read) return read;
  const current = currentOperation();
  const token = consentCredential();
  if (!token) {
    useConsentState.setState({ decisions: null, error: CORPUS_CONSENT_FAILURE });
    return Promise.resolve();
  }
  const startedWith = { ...revisions };
  useConsentState.setState({ error: null });
  const request = corpusConsent
    .list(token)
    .then((rows) => {
      if (!current()) return;
      useConsentState.setState({ decisions: mergeRead(rows, startedWith) });
    })
    .catch(() => {
      if (current()) useConsentState.setState({ error: CORPUS_CONSENT_FAILURE });
    })
    .finally(() => {
      if (read === request) read = null;
    });
  read = request;
  return request;
}

/** Publish only a server echo, with one outstanding write per source. */
function decide(source: string, granted: boolean): void {
  const state = useConsentState.getState();
  if (state.pending.includes(source)) return;
  const current = currentOperation();
  const token = consentCredential();
  if (!token) {
    useConsentState.setState({ error: CORPUS_CONSENT_FAILURE });
    return;
  }
  revisions[source] = (revisions[source] ?? 0) + 1;
  useConsentState.setState({ error: null, pending: [...state.pending, source] });
  const request = corpusConsent.set(source, granted, token);
  void request
    .then((confirmed) => {
      if (!current()) return;
      confirmSource(source, confirmed);
    })
    .catch(() => {
      if (current()) useConsentState.setState({ error: CORPUS_CONSENT_FAILURE });
    })
    .finally(() => {
      if (current()) clearPending(source);
    });
}

/** Reuse confirmed data while either Settings surface remains mounted. */
export function useCorpusConsent() {
  const state = useConsentState();
  const live = useRef(true);
  const owner = getActiveUser();
  const accountGeneration = getActiveUserGeneration();
  const callbacks = useMemo(() => {
    const current = currentOperation(state.epoch, owner, accountGeneration);
    return {
      decide: (source: string, granted: boolean, question?: ConsentConfirmation) => {
        const latest = useConsentState.getState();
        const valid =
          question === undefined ||
          (question.decision.source === source &&
            confirmationMatches(question, latest.epoch, latest.decisions));
        if (valid && live.current && current()) decide(source, granted);
      },
      retry: () => (live.current && current() ? load() : Promise.resolve()),
    };
    // The reset epoch and account bind retained UI callbacks to their session.
  }, [state.epoch, owner, accountGeneration]);
  useEffect(() => {
    if (useConsentState.getState().accountGeneration !== accountGeneration) reset();
    live.current = true;
    readers += 1;
    if (useConsentState.getState().decisions === null) void load();
    return () => {
      live.current = false;
      readers -= 1;
      if (readers === 0) reset();
    };
  }, [accountGeneration]);
  const visible = state.accountGeneration === accountGeneration ? state : empty();
  return { ...visible, ...callbacks };
}
