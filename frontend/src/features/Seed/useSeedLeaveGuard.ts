/**
 * Holds an exit open while a seeding run is still going over, so leaving is a
 * choice somebody makes rather than something that happens to them.
 *
 * Two exits, because the report came from the web build and only one of them
 * reaches React Navigation. A screen popped from the native stack fires
 * `beforeRemove`, which can be held and then performed once the person has
 * answered. A browser reload or a close never reaches the navigator at all, so
 * on web the page's own `beforeunload` prompt is the only warning there is.
 *
 * Armed only while a run is active. A confirmation on every exit from an idle
 * screen would be a toll on the ordinary case to guard the rare one, and it
 * would teach people to dismiss the prompt that matters.
 *
 * Stopping the run is the caller's to do: this hook decides *when* to ask and
 * performs the exit afterwards, and knows nothing about what a run is.
 */
import { useNavigation, type NavigationAction } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { SEED_LEAVE_BROWSER_WARNING } from './seedCopy';

/** What the screen reads and drives to ask its question. */
export interface SeedLeaveGuard {
  /** Whether the question is on screen, waiting on an answer. */
  isPrompting: boolean;
  /** Stop the run, then make the exit that was held. */
  confirmLeave: () => void;
  /** Put the question away and leave the run alone. */
  stay: () => void;
}

/**
 * Warn before a page reload takes a run with it. Web only, and a no-op
 * wherever there is no page: a device has no `window`, and reaching for the
 * bare global there throws rather than quietly doing nothing.
 */
function useBeforeUnloadWarning(isActive: boolean): void {
  useEffect(() => {
    if (!isActive || Platform.OS !== 'web') return undefined;
    if (typeof globalThis.window === 'undefined') return undefined;
    // Captured rather than re-resolved in the cleanup, which runs at teardown
    // by which point the page may already be going.
    const view = globalThis.window;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = SEED_LEAVE_BROWSER_WARNING;
    };
    view.addEventListener('beforeunload', warn);
    return () => view.removeEventListener('beforeunload', warn);
  }, [isActive]);
}

/**
 * Ask before an active run is left, and perform the exit once it is answered.
 *
 * @param isActive - whether documents are still going over.
 * @param onLeave - stops the run; called before the held exit is performed.
 */
export function useSeedLeaveGuard(isActive: boolean, onLeave: () => void): SeedLeaveGuard {
  const navigation = useNavigation();
  const [isPrompting, setIsPrompting] = useState(false);
  const held = useRef<NavigationAction | null>(null);
  // Set once the person has said to go: the exit we perform ourselves must not
  // be caught by our own listener and asked about a second time.
  const leaving = useRef(false);

  useEffect(() => {
    if (!isActive) return undefined;
    return navigation.addListener('beforeRemove', (event) => {
      if (leaving.current) return;
      event.preventDefault();
      held.current = event.data.action;
      setIsPrompting(true);
    });
  }, [isActive, navigation]);

  useBeforeUnloadWarning(isActive);

  const confirmLeave = useCallback(() => {
    leaving.current = true;
    setIsPrompting(false);
    onLeave();
    const action = held.current;
    held.current = null;
    if (action !== null) navigation.dispatch(action);
  }, [navigation, onLeave]);

  const stay = useCallback(() => {
    held.current = null;
    setIsPrompting(false);
  }, []);

  return { isPrompting, confirmLeave, stay };
}
