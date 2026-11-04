import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  CORPUS_CONSENT_GAIN,
  CORPUS_GROUP_TITLE,
  CORPUS_INVITATION_REACH,
} from './corpusConsentCopy';
import {
  CORPUS_SWEEP_FAILURE,
  CORPUS_SWEEP_HOW_LINE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_READ_FAILURE,
  CORPUS_SWEEP_RETRY_LABEL,
  CORPUS_SWEEP_TITLE,
  CORPUS_SWEEP_WHAT_HEADING,
  corpusSortOutcomeLine,
  corpusSortProgressLine,
  corpusSweepActionLabel,
  corpusSweepPendingLine,
} from './corpusSweepCopy';
import {
  refreshSweepEstimate,
  startSort,
  useCorpusSortRun,
  useCorpusSweepPending,
} from './useCorpusSweep';

import { ApiError, type CorpusSortRun } from '@/api';
import { Button } from '@/components/Button';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent, ink, radius, rhythm, surface, type as typeRamp } from '@/design/tokens';

/**
 * "Sort the rest of your writing" (#3499): how much is unsorted, what sorting
 * does, and one press that sorts all of it.
 *
 * The press starts a background run on the server (``POST /corpus/sweep``,
 * ``services/corpus_sort_run.py``) that offers every waiting entry once, and the
 * screen follows it by re-reading ``GET /corpus/sweep`` every
 * :data:`SORT_POLL_INTERVAL_MS` while it runs -- and only then. Pressing again
 * while it runs joins the same run, so the button is simply not offered until
 * it ends. Leaving the screen stops the polling, never the sort.
 *
 * Nothing here is priced. Sorting is free (#3495), so the confirm carries no
 * acknowledgement and the screen no money language; the route takes no body.
 */

/**
 * How often a running sort is re-read: often enough to feel live, cheap enough to ignore.
 *
 * Every request counts against the server's ambient per-client floor
 * (``FALLBACK_RATE_LIMIT``, 60 a minute, ``backend/src/rate_limit.py``). Three
 * seconds is twenty reads a minute -- a third of that floor for as long as a
 * sort runs, leaving the rest of the app room to work beside it.
 */
export const SORT_POLL_INTERVAL_MS = 3000;

/** The per-account limit on presses answers with this; it is a wait, not a fault. */
const HTTP_TOO_MANY_REQUESTS = 429;

type PressError = 'rate-limited' | 'failed';

function pressErrorFor(error: unknown): PressError {
  return error instanceof ApiError && error.status === HTTP_TOO_MANY_REQUESTS
    ? 'rate-limited'
    : 'failed';
}

const PRESS_ERROR_COPY: Record<PressError, string> = {
  'rate-limited': CORPUS_SWEEP_RATE_LIMITED,
  failed: CORPUS_SWEEP_FAILURE,
};

/** Whether ``run`` is a sort still going. */
function isRunning(run: CorpusSortRun | null): boolean {
  return run?.state === 'running';
}

/** A ref that reads ``true`` while the component is mounted. */
function useMounted(): React.MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** The unsorted count, loaded on arrival, with a retry when it does not load. */
function useArrivalEstimate(): { readFailed: boolean; retry: () => void } {
  const [readFailed, setReadFailed] = useState(false);
  const mounted = useMounted();
  const read = useCallback(() => {
    setReadFailed(false);
    void refreshSweepEstimate().then((landed) => {
      if (mounted.current) setReadFailed(!landed);
    });
  }, [mounted]);
  useEffect(() => {
    read();
  }, [read]);
  return { readFailed, retry: read };
}

/**
 * Re-read the count and the run every :data:`SORT_POLL_INTERVAL_MS` until cancelled.
 *
 * A chain of timeouts rather than an interval, so a slow read is never
 * overtaken by the next one. Returns the cancel.
 */
function pollUntilCancelled(): () => void {
  const state: { cancelled: boolean; timer?: ReturnType<typeof setTimeout> } = {
    cancelled: false,
  };
  function schedule(): void {
    state.timer = setTimeout(() => {
      void refreshSweepEstimate().then(() => {
        if (!state.cancelled) schedule();
      });
    }, SORT_POLL_INTERVAL_MS);
  }
  schedule();
  return () => {
    state.cancelled = true;
    clearTimeout(state.timer);
  };
}

/** Poll while a sort is going; stop when it ends or the screen goes. */
function useRunPolling(run: CorpusSortRun | null): void {
  const running = isRunning(run);
  useEffect(() => (running ? pollUntilCancelled() : undefined), [running]);
}

/**
 * The run this screen has followed: one it started, or found already going.
 *
 * Only that run's outcome is reported. A sort that ended days ago, before this
 * visit, is history the screen did not witness, and reporting it as news would
 * be telling somebody about a press they may not remember.
 */
function useWatchedRun(run: CorpusSortRun | null): {
  watched: CorpusSortRun | null;
  watch: (id: number) => void;
} {
  const [watchedId, setWatchedId] = useState<number | null>(null);
  const running = isRunning(run);
  const runId = run?.id ?? null;
  useEffect(() => {
    if (running && runId !== null) setWatchedId(runId);
  }, [running, runId]);
  return { watched: run !== null && run.id === watchedId ? run : null, watch: setWatchedId };
}

/** One press at a time, and the error it met, if any. */
function useSortPress(watch: (id: number) => void): {
  pressing: boolean;
  error: PressError | null;
  press: () => void;
} {
  const [pressing, setPressing] = useState(false);
  const [error, setError] = useState<PressError | null>(null);
  const inFlight = useRef(false);
  const mounted = useMounted();
  const press = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPressing(true);
    setError(null);
    startSort()
      .then((result) => {
        if (mounted.current && result?.run) watch(result.run.id);
      })
      .catch((failure: unknown) => {
        if (mounted.current) setError(pressErrorFor(failure));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setPressing(false);
      });
  }, [mounted, watch]);
  return { pressing, error, press };
}

/** How tall the progress track is, in points: visible at a glance, quiet beside the text. */
const SORT_PROGRESS_HEIGHT = 6;
/** A fraction as a percentage of the track's width. */
const PERCENT = 100;

/**
 * How full the bar is: entries looked at over the larger of the starting total
 * and what has been looked at -- so writing that arrives mid-run, which the walk
 * also reaches, can never push the fill past the end. Zero before anything is
 * pending at all.
 */
export function sortProgressFraction(run: CorpusSortRun): number {
  const total = Math.max(run.entries_total, run.entries_offered);
  return total > 0 ? run.entries_offered / total : 0;
}

/**
 * A determinate bar for a running sort (#3677): entries looked at, out of the total.
 *
 * Announced as a ``progressbar`` with its numeric value and labelled with the
 * same sentence shown beneath it. It moves only when a poll lands -- no
 * animation, so there is nothing for reduced motion to switch off -- and it
 * prints no number of its own, so it cannot show the bare zero the screen's
 * price-language test forbids.
 */
const SortProgressBar = ({ run }: { run: CorpusSortRun }): React.JSX.Element => (
  <View
    style={styles.track}
    testID="corpus-sweep-progress-bar"
    accessibilityRole="progressbar"
    accessibilityLabel={corpusSortProgressLine(run)}
    accessibilityValue={{
      min: 0,
      max: Math.max(run.entries_total, run.entries_offered),
      now: run.entries_offered,
    }}
  >
    <View
      style={[styles.fill, { width: `${sortProgressFraction(run) * PERCENT}%` }]}
      testID="corpus-sweep-progress-fill"
    />
  </View>
);

/** A running sort's progress, or a finished one's outcome and, if it left writing, why. */
const RunStatus = ({
  run,
  pending,
}: {
  run: CorpusSortRun;
  pending: number;
}): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const running = isRunning(run);
  const leftBehind = run.state === 'completed' && run.entries_sorted === 0 && pending > 0;
  return (
    <View testID="corpus-sweep-outcome" accessibilityLiveRegion="polite">
      {running ? <SortProgressBar run={run} /> : null}
      <Text
        style={[t.body, styles.paragraph]}
        testID={running ? 'corpus-sweep-progress' : undefined}
      >
        {running ? corpusSortProgressLine(run) : corpusSortOutcomeLine(run, pending)}
      </Text>
      {leftBehind ? (
        <Text style={[t.caption, styles.soft]} testID="corpus-sweep-nothing-sorted">
          {CORPUS_SWEEP_NOTHING_SORTED_REASON}
        </Text>
      ) : null}
    </View>
  );
};

interface SweepActionsProps {
  pending: number | null;
  readFailed: boolean;
  onRetry: () => void;
}

/** The count did not load: say so, and offer to read it again. */
const ReadFailure = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.actions}>
      <Text style={[t.body, styles.paragraph]} testID="corpus-sweep-read-failure">
        {CORPUS_SWEEP_READ_FAILURE}
      </Text>
      <Button
        label={CORPUS_SWEEP_RETRY_LABEL}
        variant="secondary"
        onPress={onRetry}
        testID="corpus-sweep-retry"
      />
    </View>
  );
};

/** The sort's state: a followed run's progress or outcome, or that nothing is waiting. */
const SortState = ({
  run,
  watched,
  pending,
}: {
  run: CorpusSortRun | null;
  watched: CorpusSortRun | null;
  pending: number | null;
}): React.JSX.Element | null => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  if (watched !== null && pending !== null) return <RunStatus run={watched} pending={pending} />;
  if (isRunning(run) || pending !== 0) return null;
  return (
    <Text style={[t.body, styles.paragraph]} testID="corpus-sweep-nothing-pending">
      {CORPUS_SWEEP_NOTHING_PENDING}
    </Text>
  );
};

/** What a press met, when it met something other than a run. */
const PressErrorLine = ({ error }: { error: PressError | null }): React.JSX.Element | null => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  if (error === null) return null;
  return (
    <Text
      style={[t.body, styles.paragraph]}
      testID="corpus-sweep-error"
      accessibilityLiveRegion="polite"
    >
      {PRESS_ERROR_COPY[error]}
    </Text>
  );
};

/** The one confirm, offered only when there is something waiting and no sort going. */
const SortButton = ({
  run,
  pending,
  pressing,
  onPress,
}: {
  run: CorpusSortRun | null;
  pending: number | null;
  pressing: boolean;
  onPress: () => void;
}): React.JSX.Element | null => {
  if (isRunning(run) || pending === null || pending <= 0) return null;
  return (
    <Button
      label={corpusSweepActionLabel(pending)}
      onPress={onPress}
      busy={pressing}
      testID="corpus-sweep-confirm"
    />
  );
};

/** The status under the explanation: the count's state, the sort, the confirm. */
const SweepActions = ({ pending, readFailed, onRetry }: SweepActionsProps): React.JSX.Element => {
  const run = useCorpusSortRun();
  useRunPolling(run);
  const { watched, watch } = useWatchedRun(run);
  const sort = useSortPress(watch);
  if (readFailed && pending === null) return <ReadFailure onRetry={onRetry} />;
  return (
    <View style={styles.actions}>
      <SortState run={run} watched={watched} pending={pending} />
      <PressErrorLine error={sort.error} />
      <SortButton run={run} pending={pending} pressing={sort.pressing} onPress={sort.press} />
    </View>
  );
};

export default function CorpusSweepScreen(): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const pending = useCorpusSweepPending();
  const { readFailed, retry } = useArrivalEstimate();
  const lead = pending !== null && pending > 0 ? corpusSweepPendingLine(pending) : undefined;
  return (
    <ScreenScaffold scroll testID="corpus-sweep-screen">
      <ScreenHeader
        eyebrow={CORPUS_GROUP_TITLE}
        title={CORPUS_SWEEP_TITLE}
        titleHidden
        lead={lead}
      />
      <EditorialSection title={CORPUS_SWEEP_WHAT_HEADING} testID="corpus-sweep-what">
        <Text style={[t.body, styles.paragraph]}>{CORPUS_CONSENT_GAIN}</Text>
        <Text style={[t.body, styles.paragraph]}>{CORPUS_INVITATION_REACH}</Text>
        <Text style={[t.caption, styles.soft]}>{CORPUS_SWEEP_HOW_LINE}</Text>
      </EditorialSection>
      <SweepActions pending={pending} readFailed={readFailed} onRetry={retry} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  paragraph: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  soft: {
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
  actions: {
    marginTop: rhythm.sectionGap,
  },
  track: {
    height: SORT_PROGRESS_HEIGHT,
    borderRadius: radius.sm,
    backgroundColor: surface.sunken,
    overflow: 'hidden',
    marginBottom: rhythm.blockGap,
  },
  fill: {
    height: '100%',
    backgroundColor: accent.primary,
  },
});
