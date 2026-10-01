/**
 * ``usePracticeHabitCheckOff`` — the seam between a saved practice session and
 * the habit the person linked practice sessions to.
 *
 * The practice-side twin of ``useLinkedHabitCheckOff`` (#2861). On mount it
 * hydrates the link from ``GET /ui-flags`` (the server owns it, so a fresh
 * device honours a link made elsewhere). The returned function takes the
 * payload a session was just saved with and — only when a link is known —
 * checks the habit off, fire-and-forget: the save never waits on it and never
 * hears of a failure beyond a ``console.warn``.
 *
 * **Once per session.** A minute habit is credited the session's own minutes,
 * which accumulate on the server, so a save path that reports the same
 * payload twice would credit the sitting twice. The payloads already credited
 * are remembered by identity (a ``WeakSet``, so nothing is retained once the
 * caller lets the payload go) and a repeat is skipped.
 *
 * The link is read at the moment the session is saved, not at render, so a
 * link chosen in Settings counts for the very next session.
 */
import { useCallback, useEffect } from 'react';

import { checkOffPracticeHabit, elapsedMinutesOf } from '../practiceHabitCheckOff';

import type { PracticeSessionCreate } from '@/api';
import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/context/AuthContext';
import { usePracticeHabitLinkStore } from '@/store/usePracticeHabitLinkStore';

/** What a caller hands over once ``POST /practice-sessions/`` has resolved. */
export type PracticeSessionSavedHandler = (_payload: PracticeSessionCreate) => void;

/** The saved payloads already handed to the check-off. */
const credited = new WeakSet<PracticeSessionCreate>();

export function usePracticeHabitCheckOff(): PracticeSessionSavedHandler {
  const { token, userTimezone } = useAuth();
  const { showToast } = useToast();
  const hydrate = usePracticeHabitLinkStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);

  return useCallback(
    (payload: PracticeSessionCreate) => {
      const { habitId } = usePracticeHabitLinkStore.getState();
      if (habitId === null || credited.has(payload)) return;
      credited.add(payload);
      void checkOffPracticeHabit({
        habitId,
        elapsedMinutes: elapsedMinutesOf(payload),
        tz: userTimezone,
        showToast,
      });
    },
    [showToast, userTimezone],
  );
}
