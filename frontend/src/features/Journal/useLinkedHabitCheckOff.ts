/**
 * ``useLinkedHabitCheckOff`` — wraps a page's writing-session handler so a
 * finished session also checks off the habit the writer linked (#2861).
 *
 * Composed in ``EntryWritingSurfaces``, which serves both the ordinary journal
 * page and a quick-launched one, so a single seam covers both kinds of page.
 * It sits beside ``useQuickLaunchedSession`` rather than inside it: that hook
 * records practices and has no business with auth or ui-flags, and the screen
 * already lives under the ``AuthProvider`` this one reads.
 *
 * On mount it hydrates the link from ``GET /ui-flags`` (the server owns it, so a
 * fresh device honours a link made elsewhere). The returned handler always
 * calls the wrapped one first, then — only when a link is known — checks the
 * habit off, fire-and-forget: the page never waits on it and never hears of a
 * failure beyond a fixed diagnostic. Confirmed logs can supply a factual note
 * to the page, including a session the writer stopped early.
 *
 * A session can end before the mount read has answered — a slow network, or a
 * read that timed out or failed while the writer wrote. The link is the
 * server's, so "not known yet" is not "none": the session waits for the read
 * on the wire and, if that one does not answer, asks once more of its own.
 */
import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

import { usePaymentScope } from './usePaymentScope';
import { checkOffLinkedHabit } from './writingHabitCheckOff';
import type { LoggedWritingSession, WritingSessionResult } from './writingSession';

import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/context/AuthContext';
import {
  getWritingHabitLinkGeneration,
  isWritingHabitLinkReadInFlight,
  useWritingHabitLinkStore,
} from '@/store/useWritingHabitLinkStore';

type SessionHandler = (_result: WritingSessionResult) => void;

/**
 * The linked habit as the server says it, or ``null`` when none or unknowable:
 * wait for the read already on the wire, and if no read has answered, ask once.
 */
async function linkOnceKnown(token: string | undefined): Promise<number | null> {
  const store = useWritingHabitLinkStore;
  if (isWritingHabitLinkReadInFlight()) await store.getState().hydrate(token);
  if (!store.getState().hydrated) await store.getState().hydrate(token);
  const { hydrated, habitId } = store.getState();
  return hydrated ? habitId : null;
}

/** Whether the page that owns the hook is still mounted, read at any moment. */
function useMountedRef(): React.RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export function useLinkedHabitCheckOff(
  inner: SessionHandler,
  onLogged?: (_notice: LoggedWritingSession) => void,
): SessionHandler {
  const { token, userTimezone } = useAuth();
  const currentSession = usePaymentScope();
  const { showToast } = useToast();
  const latestResult = useRef<WritingSessionResult | null>(null);
  const mounted = useMountedRef();
  const hydrate = useWritingHabitLinkStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);

  const checkOff = useCallback(
    (habitId: number, result: WritingSessionResult) => {
      const linkGeneration = getWritingHabitLinkGeneration();
      void checkOffLinkedHabit({
        habitId,
        result,
        tz: userTimezone,
        showToast,
        isCurrent: () => currentSession() && getWritingHabitLinkGeneration() === linkGeneration,
        onLogged: (message) => {
          if (mounted.current && latestResult.current === result) onLogged?.({ result, message });
        },
      });
    },
    [currentSession, mounted, onLogged, showToast, userTimezone],
  );

  return useCallback(
    (result: WritingSessionResult) => {
      latestResult.current = result;
      inner(result);
      if (!currentSession()) return;
      // Read at the moment the session ends, not at render: a link chosen from
      // the offer mid-page must count for the very next session.
      const { habitId, hydrated } = useWritingHabitLinkStore.getState();
      if (hydrated) {
        if (habitId !== null) checkOff(habitId, result);
        return;
      }
      void linkOnceKnown(token ?? undefined).then((known) => {
        if (known !== null && currentSession()) checkOff(known, result);
      });
    },
    [checkOff, currentSession, inner, token],
  );
}
