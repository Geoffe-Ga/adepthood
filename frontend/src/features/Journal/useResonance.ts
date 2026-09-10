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
  useMemo,
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
import { habitManager } from '@/features/Habits/services/habitManager';
import { useContractionSignalStore } from '@/store/useContractionSignalStore';

const EMPTY_BODY_MESSAGE = 'Write a little first, then ask for its resonance.';
const completionsCheckedAfterResonanceError = (reason: string): string =>
  `We couldn't create a reflection for this entry. ${reason} We still checked it for completed habits; you can try resonance again whenever you like.`;
const completionsUncheckedAfterResonanceError = (reason: string): string =>
  `We couldn't create a reflection or check this entry for completed habits. ${reason}`;

/**
 * What a failed check-off says, ahead of whatever the failure itself explains.
 *
 * Two parts and no third: the task that did not happen, and the reassurance
 * that the row survived it — the card is still pending server-side, so pressing
 * OK again is a real remedy rather than a hopeful one. The cause is left to
 * ``formatApiError``, which says only what the client can establish. A browser
 * refuses a cross-origin response and a browser that cannot reach the host both
 * reject ``fetch`` identically, so any cause named here would be a
 * guess wearing a diagnosis.
 */
const ACCEPT_FAILED_PREFIX =
  "That check-off didn't go through — the card is still here, so nothing is lost.";

/**
 * The pass, as the author of a complaint. Suggestions sign theirs with their id.
 */
const PASS_SOURCE = 'pass';

/** Who a margin complaint belongs to, so only its author may retire it. */
type ErrorSource = number | typeof PASS_SOURCE;

/** The margin's one complaint, and whose it is. */
interface MarginError {
  message: string;
  source: ErrorSource;
}

/** Report a complaint, or retire one, on behalf of a named author. */
interface MarginErrorApi {
  message: string | null;
  report: (_source: ErrorSource, _message: string) => void;
  /** The pass's own complaint, so ``PASS_SOURCE`` stays the model's business. */
  reportPass: (_message: string) => void;
  retire: (_source: ErrorSource) => void;
  clear: () => void;
}

export interface UseResonanceArgs {
  routeEntryId: number | null;
  /** Persist the latest text and resolve to the entry id (from the writing surface). */
  flush: () => Promise<number | null>;
  /**
   * The auth-hydrated IANA zone, threaded as every ``loadHabits`` caller
   * threads it: an accepted habit's refresh buckets "today" by this, and the
   * device zone would put a late-night check-in on the wrong day.
   */
  userTimezone: string;
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
  requestResonance: (_apiKey?: string | null) => Promise<void>;
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

/**
 * The margin's one complaint slot, and the rule for who may retire it.
 *
 * A single error line sits above the margin's content, so a second failure
 * necessarily replaces the first. What must not happen is a *success* retiring
 * a complaint it never made: with two cards on screen, accepting one used to
 * wipe the other's still-live failure while that card stayed pending and still
 * needed the reader. Every complaint is therefore signed by its author, and
 * only that author can retire it -- or a whole fresh pass, which re-derives the
 * margin and so speaks for everything standing in it.
 */
function useMarginError(): MarginErrorApi {
  const [error, setError] = useState<MarginError | null>(null);

  const report = useCallback((source: ErrorSource, message: string) => {
    setError({ message, source });
  }, []);
  const retire = useCallback((source: ErrorSource) => {
    setError((prev) => (prev?.source === source ? null : prev));
  }, []);
  const clear = useCallback(() => setError(null), []);
  const reportPass = useCallback((message: string) => report(PASS_SOURCE, message), [report]);

  return useMemo(
    () => ({ message: error?.message ?? null, report, reportPass, retire, clear }),
    [error, report, reportPass, retire, clear],
  );
}

/** Owns suggestion state: load-on-open, merge, and accept/dismiss with guards. */
function useSuggestions(
  routeEntryId: number | null,
  marginError: MarginErrorApi,
  userTimezone: string,
): SuggestionsApi {
  const [suggestions, setSuggestions] = useState<CompletionSuggestion[]>([]);
  const [acceptedCheckIns, setAcceptedCheckIns] = useState<Record<number, CheckInResult | null>>(
    {},
  );
  const pendingIdsRef = useRef<Set<number>>(new Set());

  useHydrateOnOpen(routeEntryId, completionSuggestions.list, setSuggestions);

  const mergeFromGenerate = useCallback((incoming: CompletionSuggestion[]) => {
    setSuggestions((prev) => mergeByIdSorted(prev, incoming));
  }, []);

  const { report, retire } = marginError;

  const acceptSuggestion = useCallback(
    (id: number) =>
      runAccept(id, {
        pendingIdsRef,
        setSuggestions,
        setAcceptedCheckIns,
        report,
        retire,
        userTimezone,
      }),
    [report, retire, userTimezone],
  );

  const dismissSuggestion = useCallback(
    (id: number) =>
      optimisticRemove(id, {
        pendingIds: pendingIdsRef.current,
        current: suggestions,
        setItems: setSuggestions,
        removeRemote: completionSuggestions.dismiss,
        reinsert: (prev, item) => mergeByIdSorted([item], prev),
        // Signed with the row's id like an accept's: a dismiss shares the one
        // error slot, so an unsigned complaint here would be erasable by any
        // other card's success -- and retired by its own row actually leaving.
        onError: (message) => report(id, message),
        onSuccess: () => retire(id),
      }),
    [suggestions, report, retire],
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
  report: MarginErrorApi['report'];
  retire: MarginErrorApi['retire'];
  userTimezone: string;
}

/**
 * Push an accepted habit's check-in through to the habit store.
 *
 * The check-in itself is kept in screen-local state for the card's streak line,
 * which on its own leaves the Habits tab and the shelf's "Today's habits" tile
 * disagreeing with the card the writer just watched settle: both load their
 * habits on mount and both stay mounted underneath this screen, so returning to
 * either re-runs nothing. A practice target has no habit row to refresh — the
 * journal-attested session it logs carries no check-in and no streak.
 */
function refreshHabitsAfterAccept(
  target: CompletionSuggestion['target_type'],
  userTimezone: string,
): void {
  if (target !== 'habit') return;
  void habitManager.loadHabits(userTimezone);
}

/** Accept a suggestion: per-id guarded; logs the completion, flips to accepted. */
async function runAccept(id: number, deps: AcceptDeps): Promise<void> {
  if (deps.pendingIdsRef.current.has(id)) return; // per-id guard — no double-log
  deps.pendingIdsRef.current.add(id);
  try {
    const result = await completionSuggestions.accept(id);
    deps.setSuggestions((prev) => mergeByIdSorted(prev, [result.suggestion]));
    deps.setAcceptedCheckIns((prev) => ({ ...prev, [id]: result.check_in }));
    // A success retires this card's own previous complaint; leaving it pinned
    // beside a card that now reads "✓ Checked off" contradicts the card. Only
    // its own: another card's failure is still live, and that card is still
    // pending and still needs the reader's attention.
    deps.retire(id);
    refreshHabitsAfterAccept(result.suggestion.target_type, deps.userTimezone);
  } catch (err) {
    // The row stays pending, so the card is still on screen to press again —
    // which only helps if the writer is told, hence the named failure.
    deps.report(id, `${ACCEPT_FAILED_PREFIX} ${formatApiError(err)}`);
  } finally {
    deps.pendingIdsRef.current.delete(id);
  }
}

interface GeneratePass {
  loading: boolean;
  requestResonance: (_apiKey?: string | null) => Promise<void>;
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
  reportPassError: (_message: string) => void;
  clearError: () => void;
}

interface PassFailureDeps {
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void;
  reportPassError: (_message: string) => void;
}

/**
 * What a refused literary pass still owes the writer.
 *
 * The completion check is independent of the reflection, so a failed pass runs
 * it anyway rather than leaving the entry both unreflected and unchecked, and
 * the message says which of the two actually happened. Every branch here is the
 * pass's own complaint, so each is signed as the pass rather than as any card.
 */
async function reportPassFailure(
  entryId: number | null,
  reason: string,
  deps: PassFailureDeps,
): Promise<void> {
  if (entryId == null) {
    deps.reportPassError(reason);
    return;
  }
  try {
    const detection = await completionSuggestions.detect(entryId);
    deps.mergeFromGenerate(detection.items);
    deps.reportPassError(
      detection.checked
        ? completionsCheckedAfterResonanceError(reason)
        : completionsUncheckedAfterResonanceError(reason),
    );
  } catch {
    // Keep this contextual instead of repeating the provider's generic
    // BotMason copy: the writer needs to know both actions were attempted.
    deps.reportPassError(completionsUncheckedAfterResonanceError(reason));
  }
}

/** The charged "generate" pass: flush, generate, merge notes + suggestions + care. */
function useGeneratePass(deps: GeneratePassDeps): GeneratePass {
  const { flush, setMarginalia, mergeFromGenerate, latestPass, reportPassError, clearError } = deps;
  const { clear: clearLatestPass, receive: receiveLatestPass } = latestPass;
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const requestResonance = useCallback(
    async (apiKey?: string | null): Promise<void> => {
      if (inFlightRef.current) return; // one pass at a time — no double-charge
      inFlightRef.current = true;
      setLoading(true);
      // A fresh pass re-derives the whole margin, so it retires every complaint
      // standing in it -- its own and any card's -- rather than only its own.
      clearError();
      // Latest-pass surfaces never survive into a new request. If it errors, stale
      // care, privacy, no-notes, or Creek context must not describe this attempt.
      clearLatestPass();
      let entryId: number | null = null;
      try {
        entryId = await flush();
        if (entryId == null) {
          reportPassError(EMPTY_BODY_MESSAGE);
          return;
        }
        const result =
          apiKey === undefined
            ? await resonance.generate(entryId)
            : await resonance.generate(entryId, undefined, apiKey);
        setMarginalia((prev) => mergeByIdSorted(prev, result.marginalia));
        mergeFromGenerate(result.suggestions);
        receiveLatestPass(result);
      } catch (err) {
        await reportPassFailure(entryId, formatApiError(err), {
          mergeFromGenerate,
          reportPassError,
        });
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [
      flush,
      setMarginalia,
      mergeFromGenerate,
      clearLatestPass,
      receiveLatestPass,
      reportPassError,
      clearError,
    ],
  );

  return { loading, requestResonance };
}

export function useResonance({
  routeEntryId,
  flush,
  userTimezone,
}: UseResonanceArgs): UseResonanceResult {
  const [marginalia, setMarginalia] = useState<Marginalia[]>([]);
  const latestPass = useLatestPassState();
  const marginError = useMarginError();

  useHydrateOnOpen(routeEntryId, resonance.list, setMarginalia);
  const sug = useSuggestions(routeEntryId, marginError, userTimezone);
  const { loading, requestResonance } = useGeneratePass({
    flush,
    setMarginalia,
    mergeFromGenerate: sug.mergeFromGenerate,
    latestPass,
    reportPassError: marginError.reportPass,
    clearError: marginError.clear,
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
    error: marginError.message,
    requestResonance,
    updateNote,
    refresh,
    acceptSuggestion: sug.acceptSuggestion,
    dismissSuggestion: sug.dismissSuggestion,
  };
}
