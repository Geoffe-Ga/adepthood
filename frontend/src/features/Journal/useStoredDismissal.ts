/**
 * A stored "don’t show this again" answer, as a gate in front of a press needs
 * to consult it.
 *
 * Shared by the explainers that stand in front of a first press — the resonance
 * spend disclosure and the promote-a-quote note — so the one subtle part of
 * both lives once: a press must act on the stored answer, never on a default
 * taken because the read had not landed yet, and a dismissal must hold in
 * memory before its disk write so a fast second press cannot be shown the note
 * it was just dismissed from.
 *
 * ``load`` and ``save`` are the flag's storage pair. They are module functions
 * in both callers, so the hook's callbacks stay stable across renders.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface StoredDismissal {
  /** The answer if it is already in hand, or ``null`` while the read is out. */
  known: () => boolean | null;
  /** The answer, waiting for the read if it has not landed yet. */
  read: () => Promise<boolean>;
  /** Record the reader's "don’t show this again", in memory and on disk. */
  markDismissed: () => void;
}

/**
 * The stored flag, read once per mount and remembered.
 *
 * Two refs rather than one, because they answer different questions: ``settled``
 * lets a press that already has the answer act on it in the same tick, and
 * ``pending`` lets a press that does not wait for the real answer rather than
 * take a default.
 */
export function useStoredDismissal(
  load: () => Promise<boolean>,
  save: (_value: boolean) => Promise<void>,
): StoredDismissal {
  const settled = useRef<boolean | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);

  const read = useCallback((): Promise<boolean> => {
    pending.current ??= load().then((stored) => {
      settled.current = stored;
      return stored;
    });
    return pending.current;
  }, [load]);

  // Warm the read at mount so a press is almost never the thing waiting on it.
  useEffect(() => {
    void read();
  }, [read]);

  const markDismissed = useCallback((): void => {
    // Memory first, disk after: a second press in the same session must not be
    // able to race the write and be shown the note it was just dismissed from.
    settled.current = true;
    pending.current = Promise.resolve(true);
    void save(true);
  }, [save]);

  const known = useCallback((): boolean | null => settled.current, []);

  // Memoised: the entry screen re-renders on every keystroke, and an unstable
  // flag object would hand the gated button a fresh onPress each time.
  return useMemo(() => ({ known, read, markDismissed }), [known, read, markDismissed]);
}
