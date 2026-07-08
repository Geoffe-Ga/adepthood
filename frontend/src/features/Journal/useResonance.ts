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
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { completionSuggestions, resonance } from '@/api';
import type {
  CareResponse,
  CheckInResult,
  CompletionSuggestion,
  ContractionReflection,
  Marginalia,
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

/** Union of two anchored lists, keyed by id (incoming wins), sorted by anchor span. */
function mergeByIdSorted<T extends { id: number; anchor_start: number }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byId = new Map<number, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.anchor_start - b.anchor_start);
}

/** State updater that folds a loaded snapshot under any state that outran it. */
function mergeSnapshotUnder<T extends { id: number; anchor_start: number }>(
  snapshot: T[],
): (_prev: T[]) => T[] {
  return (prev) => mergeByIdSorted(snapshot, prev);
}

/**
 * Load a list-shaped resource once on open; silent on failure (id only).
 * Merges the loaded snapshot into current state by id (server rows as existing,
 * in-memory as incoming) so a slow load can't clobber state that advanced past
 * its snapshot (generate deltas, accepted flips, essay-bearing notes). Resets to
 * an empty list on each entry change (deps are stable), so a prior entry's rows
 * can't union into a new one while same-entry late loads still merge under state.
 */
function useLoadOnOpen<T extends { id: number; anchor_start: number }>(
  routeEntryId: number | null,
  load: (_id: number) => Promise<{ items: T[] }>,
  apply: Dispatch<SetStateAction<T[]>>,
): void {
  useEffect(() => {
    if (routeEntryId == null) return undefined;
    // Start each entry from empty so a prior entry's rows can't union into it.
    apply([]);
    let active = true;
    void load(routeEntryId)
      .then((res) => {
        if (active) apply(mergeSnapshotUnder(res.items));
      })
      .catch(() => {
        // A failed initial load shouldn't block writing; stay silent here.
      });
    return () => {
      active = false;
    };
  }, [routeEntryId, load, apply]);
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

  useLoadOnOpen(routeEntryId, completionSuggestions.list, setSuggestions);

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
    (id: number) => runDismiss(id, suggestions, { pendingIdsRef, setSuggestions, setError }),
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

interface DismissDeps {
  pendingIdsRef: MutableRefObject<Set<number>>;
  setSuggestions: Dispatch<SetStateAction<CompletionSuggestion[]>>;
  setError: SetError;
}

/** Dismiss a suggestion: per-id guarded; optimistic remove, revert on error. */
async function runDismiss(
  id: number,
  current: CompletionSuggestion[],
  deps: DismissDeps,
): Promise<void> {
  if (deps.pendingIdsRef.current.has(id)) return;
  deps.pendingIdsRef.current.add(id);
  const dismissed = current.find((s) => s.id === id);
  deps.setSuggestions((prev) => prev.filter((s) => s.id !== id)); // optimistic
  try {
    await completionSuggestions.dismiss(id);
  } catch (err) {
    if (dismissed) {
      deps.setSuggestions((prev) => mergeByIdSorted([dismissed], prev)); // revert
    }
    deps.setError(formatApiError(err));
  } finally {
    deps.pendingIdsRef.current.delete(id);
  }
}

interface GeneratePass {
  loading: boolean;
  requestResonance: () => Promise<void>;
}

interface GeneratePassDeps {
  flush: () => Promise<number | null>;
  setMarginalia: Dispatch<SetStateAction<Marginalia[]>>;
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void;
  setCare: Dispatch<SetStateAction<CareResponse | null>>;
  setContraction: Dispatch<SetStateAction<ContractionReflection | null>>;
  setPrivateMessage: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/** The charged "generate" pass: flush, generate, merge notes + suggestions + care. */
function useGeneratePass(deps: GeneratePassDeps): GeneratePass {
  const { flush, setMarginalia, mergeFromGenerate, setCare, setContraction } = deps;
  const { setPrivateMessage, setError } = deps;
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const requestResonance = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return; // one pass at a time — no double-charge
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    // Clear any care from a prior pass up front so a distressed-then-calm
    // sequence never leaves a stale crisis surface on the page.
    setCare(null);
    // Likewise clear any prior contraction so an eased-then-healthy sequence
    // never leaves a stale "tend your foundation" reflection on the page.
    setContraction(null);
    // Likewise clear any withheld-privacy copy up front so an errored or
    // non-withheld pass never leaves a stale privacy surface on the page.
    setPrivateMessage(null);
    try {
      const entryId = await flush();
      if (entryId == null) {
        setError(EMPTY_BODY_MESSAGE);
        return;
      }
      const result = await resonance.generate(entryId);
      setMarginalia((prev) => mergeByIdSorted(prev, result.marginalia));
      mergeFromGenerate(result.suggestions);
      // ``care`` is nullable/absent on ordinary entries — normalise to null.
      setCare(result.care ?? null);
      // ``contraction`` is nullable/absent on healthy entries — normalise to null.
      setContraction(result.contraction ?? null);
      // Feed the shared signal only on a completed pass — never on loading/error.
      useContractionSignalStore.getState().observe(result.contraction ?? null);
      // ``private_message`` is present only when the pass was withheld.
      setPrivateMessage(result.private_message ?? null);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [
    flush,
    setMarginalia,
    mergeFromGenerate,
    setCare,
    setContraction,
    setPrivateMessage,
    setError,
  ]);

  return { loading, requestResonance };
}

export function useResonance({ routeEntryId, flush }: UseResonanceArgs): UseResonanceResult {
  const [marginalia, setMarginalia] = useState<Marginalia[]>([]);
  // Default null (never undefined): the load-on-open path never sets care, so
  // the surface stays hidden until a generate pass returns one.
  const [care, setCare] = useState<CareResponse | null>(null);
  // Default null (never undefined): the load-on-open path never sets it, so the
  // reflection stays hidden until a generate pass returns one.
  const [contraction, setContraction] = useState<ContractionReflection | null>(null);
  // Reason copy from a withheld (intimate) pass; null until one returns it.
  const [privateMessage, setPrivateMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLoadOnOpen(routeEntryId, resonance.list, setMarginalia);
  const sug = useSuggestions(routeEntryId, setError);
  const { loading, requestResonance } = useGeneratePass({
    flush,
    setMarginalia,
    mergeFromGenerate: sug.mergeFromGenerate,
    setCare,
    setContraction,
    setPrivateMessage,
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
    care,
    contraction,
    privateMessage,
    loading,
    error,
    requestResonance,
    updateNote,
    refresh,
    acceptSuggestion: sug.acceptSuggestion,
    dismissSuggestion: sug.dismissSuggestion,
  };
}
