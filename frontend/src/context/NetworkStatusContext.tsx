import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { setNetworkOnlineGetter } from '@/api';

/**
 * BUG-FRONTEND-INFRA-005 — single source of truth for device connectivity.
 *
 * Before this, every timeout surfaced as a generic "Request failed" toast and
 * users had no cue that the app couldn't reach the network. With a live
 * ``isOnline`` signal we can:
 *
 *  - Render a global offline banner (see ``OfflineBanner``).
 *  - Let the API client short-circuit known-offline reads so they fail fast
 *    instead of stalling for the 30s timeout (``setNetworkOnlineGetter``).
 *  - Retry a failed save when the device comes back online (the journal
 *    page's ``useReconnectRetry``, #2930).
 */

interface NetworkStatusContextValue {
  isOnline: boolean;
}

const NetworkStatusContext = createContext<NetworkStatusContextValue>({
  isOnline: true,
});

/**
 * Interpret a NetInfo snapshot. ``isInternetReachable`` is null while the
 * probe is in flight; we treat it as online until we have a definitive
 * answer so the banner doesn't flash on cold start.
 */
function isStateOnline(state: NetInfoState): boolean {
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

/** The browser events that say the device's connectivity changed. */
const WINDOW_CONNECTIVITY_EVENTS = ['online', 'offline'] as const;

type WindowConnectivityEvent = (typeof WINDOW_CONNECTIVITY_EVENTS)[number];

/** The slice of a browser ``window`` this module listens on; absent on native. */
interface WindowEventTarget {
  addEventListener?: (_type: WindowConnectivityEvent, _listener: () => void) => void;
  removeEventListener?: (_type: WindowConnectivityEvent, _listener: () => void) => void;
}

/**
 * Re-read NetInfo whenever a browser window says it went online or offline (#2930).
 *
 * NetInfo's web module listens only to the NetworkInformation ``change`` event
 * whenever the browser has that API, and browsers are inconsistent about
 * firing it: the local Chromium build fires it going offline but not coming
 * back, and the build CI pins fires it in neither direction for an emulated
 * outage. Relying on it left the app either stuck offline (the banner never
 * cleared) or never offline at all, so there was no offline → online edge for
 * anything waiting on a reconnect to act on. The window's own ``online`` and
 * ``offline`` events are reliable; on either, ``NetInfo.refresh()`` re-reads
 * ``navigator.onLine`` (and restarts the reachability probe when online),
 * delivering the result through the ordinary listener. Native has no
 * ``window.addEventListener``, so this is a no-op there.
 */
function useWindowConnectivityRefresh(): void {
  useEffect(() => {
    const target = (typeof window === 'undefined' ? {} : window) as WindowEventTarget;
    const { addEventListener, removeEventListener } = target;
    if (typeof addEventListener !== 'function') return undefined;
    const refresh = (): void => {
      NetInfo.refresh().catch(() => {
        /* keep the last known state */
      });
    };
    for (const type of WINDOW_CONNECTIVITY_EVENTS) addEventListener.call(target, type, refresh);
    return () => {
      for (const type of WINDOW_CONNECTIVITY_EVENTS)
        removeEventListener?.call(target, type, refresh);
    };
  }, []);
}

export function NetworkStatusProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const onlineRef = useRef(true);
  onlineRef.current = isOnline;

  useEffect(() => {
    // Register with the HTTP client so it can skip retrying while offline.
    setNetworkOnlineGetter(() => onlineRef.current);

    const handleChange = (state: NetInfoState): void => {
      setIsOnline(isStateOnline(state));
    };

    // Seed once, then subscribe for deltas.
    NetInfo.fetch()
      .then(handleChange)
      .catch(() => {
        /* fall back to assume-online */
      });
    const unsubscribe = NetInfo.addEventListener(handleChange);

    return () => {
      unsubscribe();
      setNetworkOnlineGetter(null);
    };
  }, []);

  useWindowConnectivityRefresh();

  const value = useMemo(() => ({ isOnline }), [isOnline]);

  return <NetworkStatusContext.Provider value={value}>{children}</NetworkStatusContext.Provider>;
}

export function useNetworkStatus(): NetworkStatusContextValue {
  return useContext(NetworkStatusContext);
}
