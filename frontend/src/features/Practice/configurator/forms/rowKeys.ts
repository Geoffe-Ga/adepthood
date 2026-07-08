import { useRef } from 'react';

/**
 * Two row-key strategies for the configurator's dynamic lists.
 *
 * `useStableRowKeys` hands out *transient* keys for rows whose backend config
 * schema is `extra="forbid"` (SensePrompt, CardMeditationCard): no key can be
 * persisted onto the row itself, so React needs a stable identity tracked
 * outside the payload. The keys live in a ref and move in lockstep with the
 * rows on add/remove/swap, keeping per-row instance state (an open dropdown,
 * focus) attached to the right row across a reorder or non-tail delete. They
 * never enter the onChange payload, so the module-level numbering is
 * unobservable.
 *
 * `makeRowKeyFactory` mints *persisted* keys for rows that carry a
 * backend-validated `key` field (TalliedCategory, MindfulAnchorOption). Those
 * keys must match `^[a-z][a-z0-9_]*$`, so they are underscore-separated; each
 * is generated once, stored on the row, and round-tripped through the config.
 */

// One monotonic source for every transient key: the shared counter guarantees
// uniqueness across forms, and the per-form prefix just makes a key legible.
// Since transient keys never reach a payload, the numbering itself is
// unobservable.
let nextTransientKey = 0;

interface StableRowKeys {
  keyAt: (index: number) => string;
  append: () => void;
  remove: (index: number) => void;
  swap: (a: number, b: number) => void;
}

/** Transient stable row keys kept in lockstep with the row list (no re-render). */
export function useStableRowKeys(prefix: string, rowCount: number): StableRowKeys {
  const keysRef = useRef<string[] | null>(null);
  keysRef.current ??= Array.from(
    { length: rowCount },
    () => `${prefix}-${(nextTransientKey += 1)}`,
  );

  const current = (): string[] => keysRef.current ?? [];
  const keyAt = (index: number): string => current()[index] ?? `${prefix}-fallback-${index}`;
  const append = (): void => {
    keysRef.current = [...current(), `${prefix}-${(nextTransientKey += 1)}`];
  };
  const remove = (index: number): void => {
    keysRef.current = current().filter((_, i) => i !== index);
  };
  const swap = (a: number, b: number): void => {
    const keys = current();
    const keyA = keys[a];
    const keyB = keys[b];
    if (keyA === undefined || keyB === undefined) return;
    const next = keys.slice();
    next[a] = keyB;
    next[b] = keyA;
    keysRef.current = next;
  };
  return { keyAt, append, remove, swap };
}

/** Closure counter emitting persisted keys `${prefix}_1`, `${prefix}_2`, and so on. */
export function makeRowKeyFactory(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${(counter += 1)}`;
}
