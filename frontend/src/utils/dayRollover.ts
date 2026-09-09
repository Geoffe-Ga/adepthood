/**
 * The day boundary, as something a screen can subscribe to.
 *
 * Every "today" the app shows — a habit's done state, its streak chip's tier
 * colour, the journal shelf's done-count — is derived at render time from
 * {@link todayInUserTZ}. That derivation is correct; what was missing is anyone
 * to ask for it again. React Navigation keeps a visited tab mounted, so a
 * mount-only effect never re-runs and a memoised tile whose props did not
 * change never re-renders: the screen keeps yesterday on it until the app is
 * restarted (#2764).
 *
 * This module is the single owner of that boundary. One timeout, scheduled to
 * the next instant at which the calendar day changes in some subscribed zone,
 * re-armed when it fires and when the app returns to the foreground. It is
 * deliberately *not* a poll: a short tick would wake the device all day to
 * answer a question whose answer changes once, and would still be late by up
 * to one tick. It is also deliberately not per-component: a timer inside each
 * tile would multiply with the habit list.
 *
 * Nothing here touches stored data. A completion's timestamp is a fact about
 * when it happened; only the display of "today" moves.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';

import { msUntilNextDayInTZ, todayInUserTZ } from './dateUtils';

type RolloverListener = () => void;

/** Every surface currently showing a day-scoped value. */
const listeners = new Set<RolloverListener>();

/**
 * Subscribed zones, reference-counted.
 *
 * Counted rather than a single "current zone" because the app crosses zones
 * legitimately: the first render uses the UTC default and the second the
 * auth-hydrated one (#269), and both are live for the moment in between. The
 * timer is armed for the *soonest* boundary among them, so no subscriber waits
 * on another's midnight.
 */
const subscribedZones = new Map<string, number>();

let timer: ReturnType<typeof setTimeout> | null = null;
let foregroundSubscription: NativeEventSubscription | null = null;

/** How long until the day changes for whichever subscribed zone changes first. */
const nextDelayMs = (): number => {
  const now = new Date();
  let soonest = Number.POSITIVE_INFINITY;
  for (const zone of subscribedZones.keys()) {
    soonest = Math.min(soonest, msUntilNextDayInTZ(zone, now));
  }
  // No zone registered yet — the subscribing effects have not all run. They
  // each re-arm, so a UTC-shaped placeholder is only ever held for a tick.
  return Number.isFinite(soonest) ? soonest : msUntilNextDayInTZ('UTC', now);
};

const disarm = (): void => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};

const notify = (): void => {
  // Copied first: a listener may unsubscribe as it runs.
  for (const listener of [...listeners]) {
    listener();
  }
};

const arm = (): void => {
  disarm();
  if (listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    notify();
    arm();
  }, nextDelayMs());
};

/**
 * Returning to the foreground is its own boundary event.
 *
 * A backgrounded app's JS timers are suspended by the OS, so the midnight
 * timeout may simply not have run — which is precisely the reported case of
 * "left the app open overnight". Re-read on the way back in rather than trust
 * a timer that was asleep for the moment that mattered.
 */
const handleAppStateChange = (status: AppStateStatus): void => {
  if (status !== 'active') return;
  notify();
  arm();
};

/** Subscribe to day changes. Returns the unsubscribe. */
const subscribeToDayRollover = (listener: RolloverListener): (() => void) => {
  listeners.add(listener);
  foregroundSubscription ??= AppState.addEventListener('change', handleAppStateChange);
  arm();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    disarm();
    foregroundSubscription?.remove();
    foregroundSubscription = null;
  };
};

/** Declare a zone whose midnight the shared timer must wake for. */
const registerZone = (tz: string): (() => void) => {
  subscribedZones.set(tz, (subscribedZones.get(tz) ?? 0) + 1);
  arm();
  return () => {
    const remaining = (subscribedZones.get(tz) ?? 1) - 1;
    if (remaining > 0) {
      subscribedZones.set(tz, remaining);
    } else {
      subscribedZones.delete(tz);
    }
    arm();
  };
};

/**
 * Today's `YYYY-MM-DD` calendar day in `tz`, kept current while mounted.
 *
 * Read it wherever a day-scoped value is derived — either for the value itself
 * or as the dependency that says "recompute when the day turns over". A
 * component that calls it re-renders at the boundary even inside a
 * `React.memo` whose props have not changed, which is the whole point: the
 * habit tile's props do not change at midnight, only the meaning of "today"
 * does.
 *
 * The snapshot is read fresh rather than cached, so a subscriber that somehow
 * missed a notification still self-corrects on its next render for any other
 * reason.
 *
 * @param tz - The user's IANA timezone. Pass the auth-hydrated zone, never a
 *   device-resolved one, so a profile-edited zone takes effect immediately.
 */
export const useDayKey = (tz: string): string => {
  useEffect(() => registerZone(tz), [tz]);
  const readDayKey = useCallback(() => todayInUserTZ(tz), [tz]);
  return useSyncExternalStore(subscribeToDayRollover, readDayKey);
};
