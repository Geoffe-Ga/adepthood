/**
 * ``useQuoteSelection`` — the checked quotes of a multi-select fold-in (#2885),
 * shared by the sources panel and the Promoted quotes screen.
 *
 * It owns only ids. Which ids "Select all" may take (the panel's unfolded
 * pending quotes, the screen's LOADED pending rows) is the caller's to say, so
 * the rule that select-all never reaches past what is on screen lives where the
 * rows do.
 */
import { useCallback, useMemo, useState } from 'react';

export interface QuoteSelection {
  /** True while rows act as checkboxes rather than fold on a tap. */
  selecting: boolean;
  selected: ReadonlySet<number>;
  /** Enter or leave selection mode; either way the selection starts empty. */
  toggleMode: () => void;
  toggle: (_id: number) => void;
  selectAll: (_ids: readonly number[]) => void;
  clear: () => void;
  /**
   * Uncheck every id not in ``ids``: after a batch, only its failures stay
   * checked for another try; after a remove, a row no longer listed drops out.
   */
  keepOnly: (_ids: readonly number[]) => void;
  /**
   * Reconcile one batch: uncheck the ids it ``sent``, then re-check the ones
   * that ``failed``. Anything checked meanwhile, outside the batch, stays.
   */
  settle: (_sent: readonly number[], _failed: readonly number[]) => void;
}

const EMPTY: ReadonlySet<number> = new Set<number>();

/** A copy of ``ids`` with ``id`` flipped. */
function flipped(ids: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** ``ids`` minus ``sent``, plus ``failed``: one batch's reconciliation. */
function settled(
  ids: ReadonlySet<number>,
  sent: readonly number[],
  failed: readonly number[],
): ReadonlySet<number> {
  const next = new Set(ids);
  for (const id of sent) next.delete(id);
  for (const id of failed) next.add(id);
  return next;
}

/** ``ids`` narrowed to ``keep``, or ``ids`` itself when nothing would change. */
function narrowed(ids: ReadonlySet<number>, keep: readonly number[]): ReadonlySet<number> {
  const live = new Set(keep);
  const next = new Set([...ids].filter((id) => live.has(id)));
  return next.size === ids.size ? ids : next;
}

export function useQuoteSelection(): QuoteSelection {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(EMPTY);

  const toggleMode = useCallback(() => {
    setSelected(EMPTY);
    setSelecting((on) => !on);
  }, []);
  const toggle = useCallback((id: number) => setSelected((prev) => flipped(prev, id)), []);
  const selectAll = useCallback((ids: readonly number[]) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => setSelected(EMPTY), []);
  const keepOnly = useCallback(
    (ids: readonly number[]) => setSelected((prev) => narrowed(prev, ids)),
    [],
  );

  const settle = useCallback(
    (sent: readonly number[], failed: readonly number[]) =>
      setSelected((prev) => settled(prev, sent, failed)),
    [],
  );

  return useMemo(
    () => ({ selecting, selected, toggleMode, toggle, selectAll, clear, keepOnly, settle }),
    [selecting, selected, toggleMode, toggle, selectAll, clear, keepOnly, settle],
  );
}
