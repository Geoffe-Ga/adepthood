/**
 * BUG-FE-STATE-001: logout must wipe every in-memory store so the next user
 * on the device does not inherit the old user's habits, stage progress,
 * journal drafts, etc. The registry is the seam that lets ``AuthContext``
 * reset every store without having to know which stores exist — each store
 * publishes its own ``reset`` callback on module load.
 */

type StoreReset = () => void;

const registered = new Set<StoreReset>();

/**
 * Register a store's ``reset`` action. Safe to call at module scope; the
 * registry deduplicates so hot-reload re-registrations do not fire the same
 * reset multiple times.
 */
export function registerStoreReset(reset: StoreReset): void {
  registered.add(reset);
}

/**
 * Invoke every registered reset. A thrown reset must not stop the rest — a
 * silently-skipped store would leave a previous user's data in memory, the
 * exact failure mode BUG-FE-STATE-001 describes. Errors are logged so they
 * still surface in development.
 */
export function resetAllStores(): void {
  for (const reset of registered) {
    try {
      reset();
    } catch (err: unknown) {
      console.warn('[store/registry] reset callback threw', err);
    }
  }
}

/**
 * Test-only escape hatch: clears the registry so each test starts from a
 * clean slate. Production code must never call this — calling it outside
 * ``NODE_ENV === 'test'`` throws so a stray import can't silently erase the
 * reset callbacks at runtime.
 */
export function __resetRegistryForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetRegistryForTests is only callable in NODE_ENV=test');
  }
  registered.clear();
}
