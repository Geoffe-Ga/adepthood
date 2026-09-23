import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { FEEDBACK_CONTEXT_LABELS, FEEDBACK_PREVIEW_COPY } from '../feedbackCopy';
import { FEEDBACK_TEST_IDS } from '../feedbackTestIds';

import type { FeedbackContext } from '@/api';
import { BORDER_RADIUS, ink, rhythm, SPACING, surface, type as typeRamp } from '@/design/tokens';

/** The envelope keys in the order the privacy policy lists them. */
const CONTEXT_KEY_ORDER: ReadonlyArray<keyof FeedbackContext> = [
  'screen',
  'control',
  'platform',
  'app_build',
  'viewport_class',
  'locale',
  'correlation_id',
];

/**
 * "What will be attached": a rendering of exactly the `context` object that
 * will be sent. It is handed the payload's own `context` -- never one built
 * separately -- so the list cannot claim less than the request carries.
 */
export function AttachedContextPreview({
  context,
}: {
  context: FeedbackContext;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const present = CONTEXT_KEY_ORDER.filter((key) => context[key] !== undefined);
  return (
    <View style={styles.card} testID={FEEDBACK_TEST_IDS.preview}>
      <Text allowFontScaling accessibilityRole="header" style={[t.label, styles.heading]}>
        {FEEDBACK_PREVIEW_COPY.heading}
      </Text>
      <Text allowFontScaling style={[t.caption, styles.soft]}>
        {FEEDBACK_PREVIEW_COPY.lead}
      </Text>
      {present.map((key) => (
        <Text
          allowFontScaling
          key={key}
          style={[t.caption, styles.row]}
          testID={FEEDBACK_TEST_IDS.previewValue(key)}
        >
          {`${FEEDBACK_CONTEXT_LABELS[key]}: ${String(context[key])}`}
        </Text>
      ))}
      <Text allowFontScaling style={[t.caption, styles.soft, styles.spaced]}>
        {FEEDBACK_PREVIEW_COPY.notIncluded}
      </Text>
      <Text allowFontScaling style={[t.caption, styles.soft]}>
        {FEEDBACK_PREVIEW_COPY.retention}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginVertical: rhythm.blockGap,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.sunken,
  },
  heading: { color: ink.primary, marginBottom: SPACING.xs },
  soft: { color: ink.soft },
  row: { color: ink.primary, marginTop: SPACING.xs },
  spaced: { marginTop: SPACING.sm },
});
