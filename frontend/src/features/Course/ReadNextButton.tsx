import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { course as courseApi, type NextUnread } from '../../api';
import { Button } from '../../components/Button';

import styles from './Course.styles';

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
 */
export function useNextUnread(): { state: NextUnreadState; refresh: () => void } {
  const [state, setState] = useState<NextUnreadState>({ status: 'loading' });
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const requestId = (requestSeq.current += 1);
    try {
      const target = await courseApi.nextUnread();
      if (requestId === requestSeq.current) setState({ status: 'ready', target });
    } catch {
      reportDiagnostic('course_load_failed');
      if (requestId === requestSeq.current) setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

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
