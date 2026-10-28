import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  CORPUS_CONSENT_GAIN,
  CORPUS_GROUP_TITLE,
  CORPUS_INVITATION_REACH,
} from './corpusConsentCopy';
import {
  CORPUS_SWEEP_BOUND_LINE,
  CORPUS_SWEEP_FAILURE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_READ_FAILURE,
  CORPUS_SWEEP_RETRY_LABEL,
  CORPUS_SWEEP_TITLE,
  CORPUS_SWEEP_WHAT_HEADING,
  corpusSweepActionLabel,
  corpusSweepOutcomeLine,
  corpusSweepPendingLine,
} from './corpusSweepCopy';
import { refreshSweepEstimate, runSweepPass, useCorpusSweepPending } from './useCorpusSweep';

import { ApiError, type CorpusSweepResult } from '@/api';
import { Button } from '@/components/Button';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';

/**
 * "Sort the rest of your writing" (#3499): how much is unsorted, what sorting
 * does, and one bounded pass at a time.
 *
 * The backend sorts at most a pass's worth per request (``POST /corpus/sweep``),
 * so a long backlog takes several. Each pass starts only on a press: the screen
 * reports what the last one did and offers the next, and never loops on its
 * own -- a pass can sort nothing and leave the remainder where it was (no
 * standing consent, a vault answering for the writing, entries the classifier
 * places nowhere), and a loop waiting for zero would spin on exactly those.
 *
 * Nothing here is priced. Sorting is free (#3495), so the confirm carries no
 * acknowledgement and the screen no money language; the shipped route takes no
 * body at all.
 */

/** The per-account limit on passes answers with this; it is a wait, not a fault. */
const HTTP_TOO_MANY_REQUESTS = 429;

type PassError = 'rate-limited' | 'failed';

function passErrorFor(error: unknown): PassError {
  return error instanceof ApiError && error.status === HTTP_TOO_MANY_REQUESTS
    ? 'rate-limited'
    : 'failed';
}

const PASS_ERROR_COPY: Record<PassError, string> = {
  'rate-limited': CORPUS_SWEEP_RATE_LIMITED,
  failed: CORPUS_SWEEP_FAILURE,
};

/** The unsorted count, loaded on arrival, with a retry when it does not load. */
function useArrivalEstimate(): { readFailed: boolean; retry: () => void } {
  const [readFailed, setReadFailed] = useState(false);
  const mounted = useRef(true);
  const read = useCallback(() => {
    setReadFailed(false);
    void refreshSweepEstimate().then((landed) => {
      if (mounted.current) setReadFailed(!landed);
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    read();
    return () => {
      mounted.current = false;
    };
  }, [read]);
  return { readFailed, retry: read };
}

/** One pass at a time: the result of the last, and the error if it had one. */
function useSweepPass(): {
  running: boolean;
  result: CorpusSweepResult | null;
  error: PassError | null;
  run: () => void;
} {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CorpusSweepResult | null>(null);
  const [error, setError] = useState<PassError | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    runSweepPass()
      .then((pass) => {
        if (mounted.current && pass !== null) setResult(pass);
      })
      .catch((failure: unknown) => {
        if (mounted.current) setError(passErrorFor(failure));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setRunning(false);
      });
  }, []);
  return { running, result, error, run };
}

/** What the last pass did; when it sorted nothing but left some, why that happens. */
const PassOutcome = ({ result }: { result: CorpusSweepResult }): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const stalled = result.entries_sorted === 0 && result.entries_remaining > 0;
  return (
    <View testID="corpus-sweep-outcome" accessibilityLiveRegion="polite">
      <Text style={[t.body, styles.paragraph]}>{corpusSweepOutcomeLine(result)}</Text>
      {stalled ? (
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

/** The status under the explanation: the count's state, the last pass, the confirm. */
const SweepActions = ({ pending, readFailed, onRetry }: SweepActionsProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const pass = useSweepPass();
  if (readFailed && pending === null) {
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
  }
  return (
    <View style={styles.actions}>
      {pass.result === null ? null : <PassOutcome result={pass.result} />}
      {pass.result === null && pending === 0 ? (
        <Text style={[t.body, styles.paragraph]} testID="corpus-sweep-nothing-pending">
          {CORPUS_SWEEP_NOTHING_PENDING}
        </Text>
      ) : null}
      {pass.error === null ? null : (
        <Text
          style={[t.body, styles.paragraph]}
          testID="corpus-sweep-error"
          accessibilityLiveRegion="polite"
        >
          {PASS_ERROR_COPY[pass.error]}
        </Text>
      )}
      {pending !== null && pending > 0 ? (
        <Button
          label={corpusSweepActionLabel(pending)}
          onPress={pass.run}
          busy={pass.running}
          testID="corpus-sweep-confirm"
        />
      ) : null}
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
        <Text style={[t.caption, styles.soft]}>{CORPUS_SWEEP_BOUND_LINE}</Text>
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
});
