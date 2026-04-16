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
 *  - Build per-feature queue/replay flows (follow-up work).
 */

interface NetworkStatusContextValue {
  isOnline: boolean;
  isInternetReachable: boolean | null;
}

const NetworkStatusContext = createContext<NetworkStatusContextValue>({
  isOnline: true,
  isInternetReachable: null,
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

export function NetworkStatusProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState<boolean | null>(null);
  const onlineRef = useRef(true);
  onlineRef.current = isOnline;

  useEffect(() => {
    // Register with the HTTP client so it can skip retrying while offline.
    setNetworkOnlineGetter(() => onlineRef.current);

    const handleChange = (state: NetInfoState): void => {
      setIsOnline(isStateOnline(state));
      setIsInternetReachable(state.isInternetReachable);
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

  const value = useMemo(() => ({ isOnline, isInternetReachable }), [isOnline, isInternetReachable]);

  return <NetworkStatusContext.Provider value={value}>{children}</NetworkStatusContext.Provider>;
}

export function useNetworkStatus(): NetworkStatusContextValue {
  return useContext(NetworkStatusContext);
}
