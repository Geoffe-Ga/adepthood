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
  type SetStateAction,
} from 'react';

import { completionSuggestions, resonance } from '@/api';
import type { CheckInResult, CompletionSuggestion, Marginalia } from '@/api';
import { formatApiError } from '@/api/errorMessages';

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
  /** The check-in (streak + milestones) from the most recent accept, if any. */
  lastCheckIn: CheckInResult | null;
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

/** Union of two note lists, keyed by id (incoming wins on conflict). */
function mergeById(existing: Marginalia[], incoming: Marginalia[]): Marginalia[] {
  const byId = new Map<number, Marginalia>();
  for (const note of existing) byId.set(note.id, note);
  for (const note of incoming) byId.set(note.id, note);
  return [...byId.values()].sort((a, b) => a.anchor_start - b.anchor_start);
}

/** Union of two suggestion lists, keyed by id, sorted by anchor span. */
function mergeSuggestionsById(
  existing: CompletionSuggestion[],
  incoming: CompletionSuggestion[],
): CompletionSuggestion[] {
  const byId = new Map<number, CompletionSuggestion>();
  for (const s of existing) byId.set(s.id, s);
  for (const s of incoming) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.anchor_start - b.anchor_start);
}

/** Load a list-shaped resource once on open; silent on failure (id only). */
function useLoadOnOpen<T>(
  routeEntryId: number | null,
  load: (_id: number) => Promise<{ items: T[] }>,
  apply: (_items: T[]) => void,
): void {
  useEffect(() => {
    if (routeEntryId == null) return undefined;
    let active = true;
    void load(routeEntryId)
      .then((res) => {
        if (active) apply(res.items);
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
  lastCheckIn: CheckInResult | null;
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void;
  acceptSuggestion: (_id: number) => Promise<void>;
  dismissSuggestion: (_id: number) => Promise<void>;
}

/** Owns suggestion state: load-on-open, merge, and accept/dismiss with guards. */
function useSuggestions(routeEntryId: number | null, setError: SetError): SuggestionsApi {
  const [suggestions, setSuggestions] = useState<CompletionSuggestion[]>([]);
  const [lastCheckIn, setLastCheckIn] = useState<CheckInResult | null>(null);
  const pendingIdsRef = useRef<Set<number>>(new Set());

  useLoadOnOpen(routeEntryId, completionSuggestions.list, setSuggestions);

  const mergeFromGenerate = useCallback((incoming: CompletionSuggestion[]) => {
    setSuggestions((prev) => mergeSuggestionsById(prev, incoming));
  }, []);

  const acceptSuggestion = useCallback(
    async (id: number): Promise<void> => {
      if (pendingIdsRef.current.has(id)) return; // per-id guard — no double-log
      pendingIdsRef.current.add(id);
      try {
        const result = await completionSuggestions.accept(id);
        setSuggestions((prev) => mergeSuggestionsById(prev, [result.suggestion]));
        setLastCheckIn(result.check_in);
      } catch (err) {
        setError(formatApiError(err)); // row stays pending; user can retry
      } finally {
        pendingIdsRef.current.delete(id);
      }
    },
    [setError],
  );

  const dismissSuggestion = useCallback(
    async (id: number): Promise<void> => {
      if (pendingIdsRef.current.has(id)) return;
      pendingIdsRef.current.add(id);
      const snapshot = suggestions;
      setSuggestions(snapshot.filter((s) => s.id !== id)); // optimistic
      try {
        await completionSuggestions.dismiss(id);
      } catch (err) {
        setSuggestions(snapshot); // revert
        setError(formatApiError(err));
      } finally {
        pendingIdsRef.current.delete(id);
      }
    },
    [suggestions, setError],
  );

  return { suggestions, lastCheckIn, mergeFromGenerate, acceptSuggestion, dismissSuggestion };
}

interface GeneratePass {
  loading: boolean;
  requestResonance: () => Promise<void>;
}

/** The charged "generate" pass: flush, generate, merge notes + suggestions. */
function useGeneratePass(
  flush: () => Promise<number | null>,
  setMarginalia: Dispatch<SetStateAction<Marginalia[]>>,
  mergeFromGenerate: (_incoming: CompletionSuggestion[]) => void,
  setError: Dispatch<SetStateAction<string | null>>,
): GeneratePass {
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const requestResonance = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return; // one pass at a time — no double-charge
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const entryId = await flush();
      if (entryId == null) {
        setError(EMPTY_BODY_MESSAGE);
        return;
      }
      const result = await resonance.generate(entryId);
      setMarginalia((prev) => mergeById(prev, result.marginalia));
      mergeFromGenerate(result.suggestions);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [flush, setMarginalia, mergeFromGenerate, setError]);

  return { loading, requestResonance };
}

export function useResonance({ routeEntryId, flush }: UseResonanceArgs): UseResonanceResult {
  const [marginalia, setMarginalia] = useState<Marginalia[]>([]);
  const [error, setError] = useState<string | null>(null);

  useLoadOnOpen(routeEntryId, resonance.list, setMarginalia);
  const sug = useSuggestions(routeEntryId, setError);
  const { loading, requestResonance } = useGeneratePass(
    flush,
    setMarginalia,
    sug.mergeFromGenerate,
    setError,
  );

  const updateNote = useCallback((updated: Marginalia) => {
    setMarginalia((prev) => mergeById(prev, [updated]));
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
    lastCheckIn: sug.lastCheckIn,
    loading,
    error,
    requestResonance,
    updateNote,
    refresh,
    acceptSuggestion: sug.acceptSuggestion,
    dismissSuggestion: sug.dismissSuggestion,
  };
}
