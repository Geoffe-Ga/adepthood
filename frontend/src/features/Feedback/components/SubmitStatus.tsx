import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  FEEDBACK_EDIT_AFTER_FAILURE_COPY,
  FEEDBACK_OUTCOME_COPY,
  type FeedbackFailureKind,
} from '../feedbackOutcome';
import { FEEDBACK_TEST_IDS } from '../feedbackTestIds';

import { colors, ink, rhythm, SPACING, type as typeRamp } from '@/design/tokens';

interface SubmitStatusProps {
  failure: FeedbackFailureKind | null;
  /** A frozen attempt is waiting: say what editing it would mean. */
  frozen: boolean;
  /** Validation stopped the send before any request. */
  message: string | null;
}

/**
 * The announced status line under the form. It is an `alert` with an
 * assertive live region, so a screen reader hears the outcome without hunting
 * for it, and it renders nothing when there is nothing to say.
 */
export function SubmitStatus({
  failure,
  frozen,
  message,
}: SubmitStatusProps): React.JSX.Element | null {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const text = failure === null ? message : FEEDBACK_OUTCOME_COPY[failure];
  if (text === null) return null;
  return (
    <View
      style={styles.wrap}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      testID={FEEDBACK_TEST_IDS.status}
    >
      <Text allowFontScaling style={[t.body, styles.text]}>
        {text}
      </Text>
      {frozen ? (
        <Text allowFontScaling style={[t.caption, styles.soft]}>
          {FEEDBACK_EDIT_AFTER_FAILURE_COPY}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: rhythm.blockGap, gap: SPACING.xs },
  text: { color: colors.destructive.text },
  soft: { color: ink.soft },
});
