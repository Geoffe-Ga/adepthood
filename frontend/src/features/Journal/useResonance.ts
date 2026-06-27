/**
 * ``useResonance`` — drives an on-demand resonance pass for a journal entry.
 *
 * On open (entry already has an id) it loads existing marginalia. A request
 * flushes the draft save first (so we resonate against the *saved* latest body),
 * calls the generate endpoint, merges the returned notes, and refreshes the
 * remaining-pass balance. One request runs at a time so rapid taps can't
 * double-charge; errors (notably 402) are mapped to friendly copy and never
 * crash the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { resonance } from '@/api';
import type { Marginalia } from '@/api';
import { formatApiError } from '@/api/errorMessages';

const EMPTY_BODY_MESSAGE = 'Write a little first, then ask for its resonance.';

export interface UseResonanceArgs {
  routeEntryId: number | null;
  /** Persist the latest text and resolve to the entry id (from the writing surface). */
  flush: () => Promise<number | null>;
}

export interface UseResonanceResult {
  marginalia: Marginalia[];
  loading: boolean;
  error: string | null;
  remaining: number | null;
  requestResonance: () => Promise<void>;
}

/** Union of two note lists, keyed by id (incoming wins on conflict). */
function mergeById(existing: Marginalia[], incoming: Marginalia[]): Marginalia[] {
  const byId = new Map<number, Marginalia>();
  for (const note of existing) byId.set(note.id, note);
  for (const note of incoming) byId.set(note.id, note);
  return [...byId.values()].sort((a, b) => a.anchor_start - b.anchor_start);
}

export function useResonance({ routeEntryId, flush }: UseResonanceArgs): UseResonanceResult {
  const [marginalia, setMarginalia] = useState<Marginalia[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (routeEntryId == null) return undefined;
    let active = true;
    void resonance
      .list(routeEntryId)
      .then((res) => {
        if (active) setMarginalia(res.items);
      })
      .catch(() => {
        // A failed initial load shouldn't block writing; stay silent here.
      });
    return () => {
      active = false;
    };
  }, [routeEntryId]);

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
      setRemaining(result.remaining_messages);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [flush]);

  return { marginalia, loading, error, remaining, requestResonance };
}
