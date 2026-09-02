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
 * reported to whatever consumes the session either way.
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
    setSession(result.reachedFullDuration ? result : null);
  }, []);
  return (
    <>
      {session === null ? null : <WritingSessionBanner result={session} onDismiss={dismiss} />}
      <WritingTimer initialMinutes={initialMinutes} onComplete={record} deps={deps} />
    </>
  );
}

export default WritingSessionSurface;
