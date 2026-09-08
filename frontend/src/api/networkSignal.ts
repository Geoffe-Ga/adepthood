/**
 * The client's one honest piece of connectivity knowledge.
 *
 * A browser deliberately gives JavaScript no way to tell a blocked
 * cross-origin request from a request that never reached anything: both reject
 * ``fetch`` with the same bare ``TypeError`` (#2661). The only thing the app
 * can genuinely observe is what the platform's own connectivity API reports,
 * which ``NetworkStatusContext`` registers here from NetInfo.
 *
 * It lives in its own module rather than in ``./index`` so that the error-copy
 * layer can read it without importing the whole HTTP client — a test that
 * mocks ``@/api`` would otherwise take this signal away and change what the
 * user is told.
 */

/** Registered by the app; returns whether the device believes it is online. */
let networkOnlineGetter: (() => boolean) | null = null;

/** Register (or, with ``null``, unregister) the device connectivity signal. */
export function setNetworkOnlineGetter(getter: (() => boolean) | null): void {
  networkOnlineGetter = getter;
}

/**
 * Whether the client has been *told* the device is offline — never a guess.
 *
 * Returns false when no signal is registered, because "we don't know" and "the
 * device is offline" are different answers and only one of them may be shown to
 * a user as a diagnosis.
 */
export function isDeviceKnownOffline(): boolean {
  return networkOnlineGetter !== null && networkOnlineGetter() === false;
}
