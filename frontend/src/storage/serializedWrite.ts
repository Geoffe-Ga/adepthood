/**
 * Serialized write lane — closes BUG-FE-STORAGE-002.
 *
 * AsyncStorage offers no transactional read-modify-write, so two callers
 * issuing `loadPendingCheckIns(); push; setItem` concurrently can both read
 * `[]`, both write a single-item array, and silently lose one of the
 * check-ins. This module funnels writes for a given key through a
 * per-key promise chain so each write sees the result of the previous one.
 *
 * Use it for any RMW against `AsyncStorage` (or similar) where two callers
 * could land in the same JS task. The chain is per-key so different keys
 * remain parallel.
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any prior write on `key` settles. Returns a promise that
 * resolves with `fn`'s result, or rejects with `fn`'s error.
 *
 * Note the `then(fn, fn)` shape: `fn` runs whether `prev` resolved OR
 * rejected. A prior write's failure must NOT block the next write in the
 * lane — but `fn`'s own rejection (the thing THIS caller wants to know
 * about) still propagates to the returned promise, so the caller that
 * owns the failing write is the one that sees the error.
 */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next);
  // `next.finally(...)` returns a fresh promise that mirrors `next`'s
  // settlement. If `next` rejects, that mirror also rejects — and if we
  // leave it dangling, Node/Jest log it as an unhandled rejection. The
  // rejection that the caller actually wants to see is the `return next`
  // below; the cleanup branch is only here to drop the chain head, so
  // attach a no-op catch to silence the duplicate.
  next
    .finally(() => {
      // Only clear the head of the chain; another caller may have already
      // queued behind us (replacing `chains[key]`), in which case we leave
      // their entry in place.
      if (chains.get(key) === next) chains.delete(key);
    })
    .catch(() => {
      /* swallowed: caller awaits `next` for the real error */
    });
  return next;
}

/**
 * Test-only helper. Resets the per-key chain map so a Jest run that
 * exercises serialize() doesn't bleed promise state across tests.
 */
export function _resetSerializedWriteForTests(): void {
  chains.clear();
}
