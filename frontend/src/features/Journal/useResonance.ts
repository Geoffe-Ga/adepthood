/**
 * ``useResonance`` — drives an on-demand resonance pass for a journal entry.
 *
 * On open (entry already has an id) it loads existing marginalia and completion
 * suggestions. A request flushes the draft save first (so we resonate against
 * the *saved* latest body), calls the generate endpoint, and merges the returned
 * notes and suggestions. One request runs at a time so rapid taps can't
 * double-charge; errors (notably 402) are mapped to friendly copy and never
 * crash the page. Accept/dismiss each guard against a double in-flight tap.
 */
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { mergeByIdSorted, useHydrateOnOpen } from './entryList';
import { optimisticRemove } from './optimisticRemove';

import { completionSuggestions, resonance } from '@/api';
import type {
  CareResponse,
  CheckInResult,
  CompletionSuggestion,
  ContractionReflection,
  Marginalia,
  RelatedEddy,
  RelatedPraxis,
  ResonanceResponse,
} from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { useContractionSignalStore } from '@/store/useContractionSignalStore';

const EMPTY_BODY_MESSAGE = 'Write a little first, then ask for its resonance.';

type SetError = (_e: string) => void;

export interface UseResonanceArgs {
  routeEntryId: number | null;
  /** Persist the latest text and resolve to the entry id (from the writing surface). */
  flush: () => Promise<number | null>;
}

export interface UseResonanceResult {
  marginalia: Marginalia[];
  suggestions: CompletionSuggestion[];
  /** Check-in (streak) per accepted suggestion id, for the confirmed card. */
  acceptedCheckIns: Record<number, CheckInResult | null>;
  /**
   * Human + professional support surface for the latest pass (NORTH-STAR §10).
   * Always ``null`` (never ``undefined``) until a generate pass returns care; a
   * new pass clears any stale care, and the load-on-open path never sets it.
   */
  care: CareResponse | null;
  /**
   * Warm, declinable "tend your foundation" reflection for the latest pass.
   * Always ``null`` (never ``undefined``) until a generate pass returns one; a
   * new pass clears any stale reflection, and the load-on-open path never sets
   * it.
   */
  contraction: ContractionReflection | null;
  /**
   * Reason copy from a pass that was withheld for an intimate entry.
   * ``null`` until a generate pass returns a ``private_message``; a new pass
   * clears any stale copy, and the privacy gate falls back to its own default
   * copy when this is null.
   */
  privateMessage: string | null;
  /**
   * The server's sentence for a pass that produced no margin notes. ``null``
   * until a generate pass returns one; a new pass clears any stale copy, and
   * the load-on-open path never sets it (it runs no pass). Distinct from
   * ``error``: this is a pass that *worked* and had nothing to hand back, which
   * is not a failure and must not be dressed as one.
   */
  noNotesMessage: string | null;
  /** Compiled praxis pages related by the latest completed resonance pass. */
  relatedPraxis: RelatedPraxis[];
  /** Recurring corpus patterns related by the latest completed resonance pass. */
  relatedEddies: RelatedEddy[];
  /**
   * How many generate passes have resolved on this screen, excluding any the
   * privacy floor withheld (``private: true``). A signal, not a thing to show:
   * ``CorpusInvitationNote`` asks the server whether a moment has arrived when
   * it moves (#2407). It starts at zero on every mount and never counts the
   * load-on-open read or a rejected pass.
   */
  completedPasses: number;
  loading: boolean;
  error: string | null;
  requestResonance: () => Promise<void>;
  /** Merge an updated note (e.g. one that just gained a cached essay) by id. */
  updateNote: (_note: Marginalia) => void;
  /** Re-read the persisted marginalia (after an edit re-anchors/stales them). */
  refresh: () => Promise<void>;
  /** Accept a suggestion: logs the completion, flips the row to accepted. */
  acceptSuggestion: (_id: number) => Promise<void>;
  /** Dismiss a suggestion: optimistically removes it, reverts on error. */
  dismissSuggestion: (_id: number) => Promise<void>;
}

interface SuggestionsApi {
  suggestions: CompletionSuggestion[];
  /** Check-in (streak) per accepted suggestion id, for the confirmed card. */
  acceptedCheckIns: Record<number, CheckInResult | null>;
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void;
  acceptSuggestion: (_id: number) => Promise<void>;
  dismissSuggestion: (_id: number) => Promise<void>;
}

/** Owns suggestion state: load-on-open, merge, and accept/dismiss with guards. */
function useSuggestions(routeEntryId: number | null, setError: SetError): SuggestionsApi {
  const [suggestions, setSuggestions] = useState<CompletionSuggestion[]>([]);
  const [acceptedCheckIns, setAcceptedCheckIns] = useState<Record<number, CheckInResult | null>>(
    {},
  );
  const pendingIdsRef = useRef<Set<number>>(new Set());

  useHydrateOnOpen(routeEntryId, completionSuggestions.list, setSuggestions);

  const mergeFromGenerate = useCallback((incoming: CompletionSuggestion[]) => {
    setSuggestions((prev) => mergeByIdSorted(prev, incoming));
  }, []);

  const acceptSuggestion = useCallback(
    (id: number) =>
      runAccept(id, {
        pendingIdsRef,
        setSuggestions,
        setAcceptedCheckIns,
        setError,
      }),
    [setError],
  );

  const dismissSuggestion = useCallback(
    (id: number) =>
      optimisticRemove(id, {
        pendingIds: pendingIdsRef.current,
        current: suggestions,
        setItems: setSuggestions,
        removeRemote: completionSuggestions.dismiss,
        reinsert: (prev, item) => mergeByIdSorted([item], prev),
        onError: setError,
      }),
    [suggestions, setError],
  );

  return {
    suggestions,
    acceptedCheckIns,
    mergeFromGenerate,
    acceptSuggestion,
    dismissSuggestion,
  };
}

interface AcceptDeps {
  pendingIdsRef: MutableRefObject<Set<number>>;
  setSuggestions: Dispatch<SetStateAction<CompletionSuggestion[]>>;
  setAcceptedCheckIns: Dispatch<SetStateAction<Record<number, CheckInResult | null>>>;
  setError: SetError;
}

/** Accept a suggestion: per-id guarded; logs the completion, flips to accepted. */
async function runAccept(id: number, deps: AcceptDeps): Promise<void> {
  if (deps.pendingIdsRef.current.has(id)) return; // per-id guard — no double-log
  deps.pendingIdsRef.current.add(id);
  try {
    const result = await completionSuggestions.accept(id);
    deps.setSuggestions((prev) => mergeByIdSorted(prev, [result.suggestion]));
    deps.setAcceptedCheckIns((prev) => ({ ...prev, [id]: result.check_in }));
  } catch (err) {
    deps.setError(formatApiError(err)); // row stays pending; user can retry
  } finally {
    deps.pendingIdsRef.current.delete(id);
  }
}

interface GeneratePass {
  loading: boolean;
  requestResonance: () => Promise<void>;
}

interface LatestPassState {
  care: CareResponse | null;
  contraction: ContractionReflection | null;
  privateMessage: string | null;
  noNotesMessage: string | null;
  relatedPraxis: RelatedPraxis[];
  relatedEddies: RelatedEddy[];
  /** Resolved, non-intimate passes so far; survives ``clear`` because it counts history. */
  completedPasses: number;
  clear: () => void;
  receive: (_result: ResonanceResponse) => void;
}

/** Own every surface that describes only the latest completed resonance pass. */
function useLatestPassState(): LatestPassState {
  const [care, setCare] = useState<CareResponse | null>(null);
  const [contraction, setContraction] = useState<ContractionReflection | null>(null);
  const [privateMessage, setPrivateMessage] = useState<string | null>(null);
  const [noNotesMessage, setNoNotesMessage] = useState<string | null>(null);
  const [relatedPraxis, setRelatedPraxis] = useState<RelatedPraxis[]>([]);
  const [relatedEddies, setRelatedEddies] = useState<RelatedEddy[]>([]);
  const [completedPasses, setCompletedPasses] = useState(0);

  const clear = useCallback((): void => {
    setCare(null);
    setContraction(null);
    setPrivateMessage(null);
    setNoNotesMessage(null);
    setRelatedPraxis([]);
    setRelatedEddies([]);
  }, []);

  const receive = useCallback((result: ResonanceResponse): void => {
    setCare(result.care ?? null);
    setContraction(result.contraction ?? null);
    useContractionSignalStore.getState().observe(result.contraction ?? null);
    setPrivateMessage(result.private_message ?? null);
    setNoNotesMessage(result.no_notes_message ?? null);
    setRelatedPraxis(result.related_praxis ?? []);
    setRelatedEddies(result.related_eddies ?? []);
    // The server never counts an intimate pass, and neither does this: a
    // client that did would ask for an offer and render "sent once to the
    // language-model provider" beneath the line saying this entry stays put.
    if (result.private !== true) setCompletedPasses((n) => n + 1);
  }, []);

  return {
    care,
    contraction,
    privateMessage,
    noNotesMessage,
    relatedPraxis,
    relatedEddies,
    completedPasses,
    clear,
    receive,
  };
}

interface GeneratePassDeps {
  flush: () => Promise<number | null>;
  setMarginalia: Dispatch<SetStateAction<Marginalia[]>>;
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void;
  latestPass: Pick<LatestPassState, 'clear' | 'receive'>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/** The charged "generate" pass: flush, generate, merge notes + suggestions + care. */
function useGeneratePass(deps: GeneratePassDeps): GeneratePass {
  const { flush, setMarginalia, mergeFromGenerate, latestPass, setError } = deps;
  const { clear: clearLatestPass, receive: receiveLatestPass } = latestPass;
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const requestResonance = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return; // one pass at a time — no double-charge
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    // Latest-pass surfaces never survive into a new request. If it errors, stale
    // care, privacy, no-notes, or Creek context must not describe this attempt.
    clearLatestPass();
    try {
      const entryId = await flush();
      if (entryId == null) {
        setError(EMPTY_BODY_MESSAGE);
        return;
      }
      const result = await resonance.generate(entryId);
      setMarginalia((prev) => mergeByIdSorted(prev, result.marginalia));
      mergeFromGenerate(result.suggestions);
      receiveLatestPass(result);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [flush, setMarginalia, mergeFromGenerate, clearLatestPass, receiveLatestPass, setError]);

  return { loading, requestResonance };
}

export function useResonance({ routeEntryId, flush }: UseResonanceArgs): UseResonanceResult {
  const [marginalia, setMarginalia] = useState<Marginalia[]>([]);
  const latestPass = useLatestPassState();
  const [error, setError] = useState<string | null>(null);

  useHydrateOnOpen(routeEntryId, resonance.list, setMarginalia);
  const sug = useSuggestions(routeEntryId, setError);
  const { loading, requestResonance } = useGeneratePass({
    flush,
    setMarginalia,
    mergeFromGenerate: sug.mergeFromGenerate,
    latestPass,
    setError,
  });

  const updateNote = useCallback((updated: Marginalia) => {
    setMarginalia((prev) => mergeByIdSorted(prev, [updated]));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (routeEntryId == null) return;
    try {
      const res = await resonance.list(routeEntryId);
      setMarginalia(res.items);
    } catch {
      // A failed refresh leaves the current notes in place; nothing to surface.
    }
  }, [routeEntryId]);

  return {
    marginalia,
    suggestions: sug.suggestions,
    acceptedCheckIns: sug.acceptedCheckIns,
    care: latestPass.care,
    contraction: latestPass.contraction,
    privateMessage: latestPass.privateMessage,
    noNotesMessage: latestPass.noNotesMessage,
    relatedPraxis: latestPass.relatedPraxis,
    relatedEddies: latestPass.relatedEddies,
    completedPasses: latestPass.completedPasses,
    loading,
    error,
    requestResonance,
    updateNote,
    refresh,
    acceptSuggestion: sug.acceptSuggestion,
    dismissSuggestion: sug.dismissSuggestion,
  };
}
