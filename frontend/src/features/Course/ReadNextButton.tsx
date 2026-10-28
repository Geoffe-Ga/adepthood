import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';

import { course as courseApi, type NextUnread } from '../../api';
import { Button } from '../../components/Button';

import styles from './Course.styles';
import { useEachCourseSession } from './courseSessionLifecycle';

import { reportDiagnostic } from '@/observability/diagnostics';

export const READ_NEXT_LABEL = 'Read next';
export const CAUGHT_UP_LABEL = 'All caught up';

/**
 * Where "Read next" points: still asking, a Start Here resource or a chapter,
 * or nowhere because every open page is read (``target: null``). A failed lookup is its own state so
 * the button can step aside rather than claim the reader is caught up.
 */
export type NextUnreadState =
  { status: 'loading' } | { status: 'ready'; target: NextUnread | null } | { status: 'error' };

/**
 * The reader's "Read next" target from ``GET /course/next-unread`` (#3147).
 *
 * One server call answers across every open stage, so nothing here sweeps the
 * per-stage listings. ``refresh`` re-asks after a chapter is marked read; it
 * keeps the previous answer on screen while the new one is in flight, so the
 * button does not flash back to its loading state on every mark. Only the
 * newest request may settle, and unmounting supersedes any in flight.
 * ``sessionKey`` (from ``useCourseSessionKey``) re-asks for each newly
 * authenticated account; ``null`` keeps the mount-time ask alone.
 */
const LOADING: NextUnreadState = { status: 'loading' };

export function useNextUnread(sessionKey: string | null = null): {
  state: NextUnreadState;
  refresh: () => void;
} {
  const [answer, setAnswer] = useState<{ key: string | null; state: NextUnreadState }>({
    key: sessionKey,
    state: LOADING,
  });
  const requestSeq = useRef(0);

  const load = useCallback(async (key: string | null) => {
    const requestId = (requestSeq.current += 1);
    try {
      const target = await courseApi.nextUnread();
      if (requestId === requestSeq.current) setAnswer({ key, state: { status: 'ready', target } });
    } catch {
      reportDiagnostic('course_load_failed');
      if (requestId === requestSeq.current) setAnswer({ key, state: { status: 'error' } });
    }
  }, []);

  // An incoming account (#3343) never sees the previous lifecycle's answer:
  // that ask is superseded at the switch, and until the incoming account's own
  // answer lands the button reads as loading -- even for the frame before the
  // new ask starts.
  const start = useCallback(() => void load(sessionKey), [load, sessionKey]);
  const supersede = useCallback(() => {
    requestSeq.current += 1;
  }, []);
  useEachCourseSession(sessionKey, start, supersede);

  const refresh = useCallback(() => {
    void load(sessionKey);
  }, [load, sessionKey]);

  const state = sessionKey === null || answer.key === sessionKey ? answer.state : LOADING;
  return { state, refresh };
}

interface ReadNextButtonProps {
  state: NextUnreadState;
  onOpen: (_target: NextUnread) => void;
}

/**
 * One tap to wherever the reader left off: an unread Start Here resource first,
 * then the earliest unlocked chapter they have not read, in any open stage. When everything open is read it says so
 * and is disabled -- an honest resting state, never a nudge. A failed lookup
 * renders nothing: the stage pills and chapter list still work, and a button
 * that cannot know where to go should not pretend to.
 */
const ReadNextButton = ({ state, onOpen }: ReadNextButtonProps): React.JSX.Element | null => {
  if (state.status === 'error') return null;
  const target = state.status === 'ready' ? state.target : null;
  const caughtUp = state.status === 'ready' && target === null;
  return (
    <View style={styles.readNextBand}>
      <Button
        testID="read-next"
        label={caughtUp ? CAUGHT_UP_LABEL : READ_NEXT_LABEL}
        accessibilityLabel={
          target
            ? `${READ_NEXT_LABEL}: ${target.title}`
            : caughtUp
              ? CAUGHT_UP_LABEL
              : READ_NEXT_LABEL
        }
        busy={state.status === 'loading'}
        disabled={target === null}
        onPress={() => {
          if (target) onOpen(target);
        }}
      />
    </View>
  );
};

export default ReadNextButton;
