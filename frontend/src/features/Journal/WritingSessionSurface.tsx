/**
 * ``WritingSessionSurface`` — the quiet mount point for timed writing.
 *
 * Holds the one piece of state a finished session leaves behind and decides
 * what, if anything, to say about it. Kept apart from {@link WritingTimer}
 * deliberately: the timer repaints ten times a second while a session runs, and
 * this does not repaint at all until a session ends. Anything a later lane
 * hangs off a finished session — an offer to keep it as a habit, or as a
 * practice — belongs here or in the banner's ``children``, not in the ticking
 * leaf.
 *
 * Only a session that ran its whole length gets a note back. Stopping early is
 * the writer saying they are done, and remarking on that would be the page
 * commenting on a decision it was not asked about — the elapsed time is still
 * reported to whatever consumes the session either way. That is a decision
 * about what to SAY, not about what a session is worth: a later lane that wants
 * early-stopped sessions reads them off the timer directly rather than
 * loosening this guard.
 *
 * So a standing note is replaced only by a newer note, and otherwise goes away
 * only when the writer closes it. A session with nothing to report leaves the
 * note alone rather than clearing it — having nothing to say is not grounds to
 * destroy a report that already exists, and a note that offers only dismissal
 * must not dismiss itself. It is also the rule the rest of the surface already
 * kept: starting a second session, pausing it, resuming it and changing its
 * length all leave a standing note untouched, and the early stop was the single
 * deviation.
 *
 * The cost of that choice, accepted knowingly: after a finished session and
 * then an abandoned one, the note describes a session two sessions back. It
 * stays true, it stays one tap from gone, and a stale sentence is a smaller
 * harm than an offer that disappears under the writer's thumb.
 *
 * What this buys the banner's ``children`` slot is written out in
 * {@link WritingSessionBanner}.
 */
import React, { useCallback, useRef, useState } from 'react';

import type { WritingSessionResult } from './writingSession';
import WritingSessionBanner from './WritingSessionBanner';
import WritingTimer from './WritingTimer';

import type { EngineDeps } from '@/features/Practice/engine/types';

export interface WritingSessionSurfaceProps {
  /** The length the timer opens at; the writer can change it before starting. */
  initialMinutes?: number;
  /**
   * Begin the session on mount, because the page was opened in order to run it.
   *
   * Passed straight through to {@link WritingTimer}, whose prop carries the
   * reason it exists and the reason it is never a default.
   */
  autoStart?: boolean;
  /**
   * Every finished session, INCLUDING one the writer stopped early.
   *
   * Distinct from the note above, which speaks only for a session that ran its
   * whole length. That guard is about what the page SAYS; a session stopped at
   * twelve minutes of twenty is still twelve minutes of writing, and a consumer
   * recording it against a practice needs to hear about it. Reported before the
   * note is decided, so the two can never disagree about whether a session
   * happened.
   */
  onSession?: (_result: WritingSessionResult) => void;
  /**
   * What to hang in the note's ``children`` slot for a session that finished.
   *
   * A render prop rather than an import, so this module keeps the scope floor
   * ``writingTimerScope`` holds it to: an offer that saves a habit or a
   * practice reaches a store and the server, and it is the hosting screen that
   * supplies it. Absent, the note is exactly what it was — a sentence and a
   * way to close it.
   */
  renderOffer?: (_result: WritingSessionResult) => React.ReactNode;
  /** The engine's clock and adapter seam; tests inject it, production does not. */
  deps?: EngineDeps;
}

/**
 * A finished session, plus a number that changes for every session reported.
 *
 * The number is what keys the offer. Two sessions of the same length produce
 * equal results, and the banner is REPLACED rather than remounted, so without
 * it an offer halfway through an interaction would carry its state across onto
 * a sentence about a different session — which is precisely what
 * ``WritingSessionBanner``'s docstring tells the slot's occupant not to allow.
 */
interface StandingNote {
  result: WritingSessionResult;
  ordinal: number;
}

function WritingSessionSurface({
  initialMinutes,
  autoStart,
  renderOffer,
  onSession,
  deps,
}: WritingSessionSurfaceProps): React.JSX.Element {
  const [note, setNote] = useState<StandingNote | null>(null);
  const dismiss = useCallback(() => setNote(null), []);
  // Held through a ref so ``record`` keeps one identity for the life of the
  // mount: it is the ticking timer's ``onComplete``, and a consumer that
  // re-created its callback each render would otherwise churn that prop ten
  // times a second.
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const record = useCallback((result: WritingSessionResult) => {
    onSessionRef.current?.(result);
    if (!result.reachedFullDuration) return;
    setNote((previous) => ({ result, ordinal: (previous?.ordinal ?? 0) + 1 }));
  }, []);
  return (
    <>
      {note === null ? null : (
        <WritingSessionBanner result={note.result} onDismiss={dismiss}>
          {renderOffer === undefined ? null : (
            <React.Fragment key={note.ordinal}>{renderOffer(note.result)}</React.Fragment>
          )}
        </WritingSessionBanner>
      )}
      <WritingTimer
        initialMinutes={initialMinutes}
        autoStart={autoStart}
        onComplete={record}
        deps={deps}
      />
    </>
  );
}

export default WritingSessionSurface;
