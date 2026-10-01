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
 * failure beyond a ``console.warn``.
 *
 * **Once per session.** A minute habit is credited the session's own minutes,
 * which accumulate on the server, so a finish handler that fires twice with
 * the same result would credit the sitting twice. The results already credited
 * are remembered by identity (a ``WeakSet``, so nothing is retained once the
 * page lets the result go) and a repeat is skipped; the wrapped handler still
 * hears every call, as it always did.
 */
import { useCallback, useEffect } from 'react';

import { checkOffLinkedHabit } from './writingHabitCheckOff';
import type { WritingSessionResult } from './writingSession';

import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/context/AuthContext';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

type SessionHandler = (_result: WritingSessionResult) => void;

/** The finished sessions already handed to the check-off. */
const credited = new WeakSet<WritingSessionResult>();

export function useLinkedHabitCheckOff(inner: SessionHandler): SessionHandler {
  const { token, userTimezone } = useAuth();
  const { showToast } = useToast();
  const hydrate = useWritingHabitLinkStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);

  return useCallback(
    (result: WritingSessionResult) => {
      inner(result);
      // Read at the moment the session ends, not at render: a link chosen from
      // the offer mid-page must count for the very next session.
      const { habitId } = useWritingHabitLinkStore.getState();
      if (habitId === null || credited.has(result)) return;
      credited.add(result);
      void checkOffLinkedHabit({
        habitId,
        elapsedMs: result.elapsedMs,
        elapsedMinutes: result.elapsedMinutes,
        tz: userTimezone,
        showToast,
      });
    },
    [inner, showToast, userTimezone],
  );
}
