/**
 * Warns before the page goes while the upload queue still has documents going
 * over (#3772).
 *
 * Moving around the app no longer stops a run -- the queue lives above every
 * screen -- so there is no in-app exit to hold any more. What does stop it is
 * the page itself going: a reload, or a closed tab, takes the picked files with
 * it, and nothing can reopen them. On the web the browser's own
 * `beforeunload` prompt is the only warning there is, so it is armed while the
 * queue is going over and nowhere else.
 *
 * Armed only while active. A confirmation on every reload of an idle app would
 * be a toll on the ordinary case to guard the rare one, and it would teach
 * people to dismiss the prompt that matters.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { SEED_LEAVE_BROWSER_WARNING } from './seedCopy';

/**
 * Warn before a page reload or close takes a running queue with it. Web only,
 * and a no-op wherever there is no page: a device has no `window`, and reaching
 * for the bare global there throws rather than quietly doing nothing.
 */
export function useUnloadWarning(isActive: boolean): void {
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
