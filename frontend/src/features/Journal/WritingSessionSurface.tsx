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
import React, { useCallback, useState } from 'react';

import type { WritingSessionResult } from './writingSession';
import WritingSessionBanner from './WritingSessionBanner';
import WritingTimer from './WritingTimer';

import type { EngineDeps } from '@/features/Practice/engine/types';

export interface WritingSessionSurfaceProps {
  /** The length the timer opens at; the writer can change it before starting. */
  initialMinutes?: number;
  /** The engine's clock and adapter seam; tests inject it, production does not. */
  deps?: EngineDeps;
}

function WritingSessionSurface({
  initialMinutes,
  deps,
}: WritingSessionSurfaceProps): React.JSX.Element {
  const [session, setSession] = useState<WritingSessionResult | null>(null);
  const dismiss = useCallback(() => setSession(null), []);
  const record = useCallback((result: WritingSessionResult) => {
    if (!result.reachedFullDuration) return;
    setSession(result);
  }, []);
  return (
    <>
      {session === null ? null : <WritingSessionBanner result={session} onDismiss={dismiss} />}
      <WritingTimer initialMinutes={initialMinutes} onComplete={record} deps={deps} />
    </>
  );
}

export default WritingSessionSurface;
