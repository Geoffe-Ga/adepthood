/**
 * The journal page's half of the quick launch: what a page opened to run a
 * saved practice does differently from a page opened to write on.
 *
 * Three differences, and no others. The timer opens at the practice's own
 * length rather than the page's default; it is already running, because
 * starting it is what the writer tapped; and the finished session is recorded
 * against the selection it was launched from.
 *
 * ## Why the offer is withheld here
 *
 * A page reached this way exists BECAUSE the writer already answered "keep this
 * as a practice". Asking again at the end of every session it opens is exactly
 * the nag ``writingOfferStorage``'s single stored flag exists to prevent, and
 * the flag alone would not cover it: a writer who chose ``Journaling`` from the
 * practice catalogue instead of from the note has never been asked, and would
 * be asked to keep a practice they already hold. So the offer is withheld by
 * the launch itself rather than by what happens to be on disk.
 *
 * ## Why nothing is sent for a stage the writer has not reached
 *
 * ``POST /practice-sessions/`` refuses a session logged against a stage the
 * writer has not reached (403 ``stage_locked``). ``planQuickLaunch`` already
 * knows that before the page opens and hands over ``userPracticeId: null``, so
 * the request is simply not made. Provoking a refusal that was known in advance
 * would turn a deliberate state into an error, and the writing is unaffected
 * either way — the page is the floor and is never gated.
 *
 * ## Once per session, without a latch
 *
 * ``WritingSessionSurface`` reports each finished session exactly once, on the
 * edge into ``complete``, and a backgrounded device that wakes past the end
 * still crosses that edge once. So this records once per session and holds no
 * "already recorded" flag of its own — a flag would be indistinguishable from
 * one, right up to the second session on the same page, which is a real second
 * session and belongs on the record like the first.
 */
import { useCallback } from 'react';

import type { WritingSessionResult } from './writingSession';

import { practiceSessions } from '@/api';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';
import { manualSessionPayload } from '@/features/Practice/utils/sessionWindow';

/** The launch a route carries into the journal page. */
export interface WritingSessionLaunch {
  /** The length the timer opens at, and starts running at, in minutes. */
  readonly minutes: number;
  /**
   * The selection the finished session is recorded against, or ``null`` when
   * the practice's stage is still ahead of the writer and nothing is counted.
   */
  readonly userPracticeId: number | null;
}

/** What the writing surface is given for this page. */
export interface LaunchedWritingSession {
  /** The length the timer opens at; ``undefined`` leaves the page's default. */
  readonly initialMinutes: number | undefined;
  /** Whether the session begins on mount. */
  readonly autoStart: boolean;
  /** Whether this page was opened in order to run a practice's session. */
  readonly launched: boolean;
  /** Called for every finished session, however it ended. */
  readonly onSession: (_result: WritingSessionResult) => void;
}

/**
 * Record one finished session against a selection.
 *
 * Resolves rather than throws: a session that could not be filed is not the
 * writer's fault and costs them nothing — the writing itself is already saved
 * by the page's own autosave, and the practice is still theirs. The warning is
 * for whoever reads the log, not for them.
 *
 * @param userPracticeId - The selection to record against.
 * @param result - The finished session, as the surface reported it.
 */
async function recordSession(userPracticeId: number, result: WritingSessionResult): Promise<void> {
  try {
    await practiceSessions.create(
      manualSessionPayload({
        userPracticeId,
        endedAt: new Date(),
        durationMinutes: result.elapsedMs / MS_PER_MINUTE,
      }),
    );
  } catch (err) {
    console.warn('[quickLaunch] the finished writing session was not recorded', err);
  }
}

/**
 * What this page runs, and what becomes of it.
 *
 * @param launch - The launch the route carried, or ``undefined`` for an
 *   ordinary page the writer simply opened.
 * @returns The props the writing surface is mounted with.
 */
export function useQuickLaunchedSession(
  launch: WritingSessionLaunch | undefined,
): LaunchedWritingSession {
  const userPracticeId = launch?.userPracticeId ?? null;
  const onSession = useCallback(
    (result: WritingSessionResult) => {
      if (userPracticeId === null) return;
      void recordSession(userPracticeId, result);
    },
    [userPracticeId],
  );
  // One fact, two consumers: a launched page starts its own session AND
  // withholds the offer to make one. Derived once so the two can never end up
  // disagreeing about whether this page was launched.
  const launched = launch !== undefined;
  return { initialMinutes: launch?.minutes, autoStart: launched, launched, onSession };
}
