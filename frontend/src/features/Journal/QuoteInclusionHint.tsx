/**
 * ``QuoteInclusionHint`` — the composer's warm line when folded quotes landed
 * in the review but their inclusion mark did not (#2891, #2885).
 *
 * It lives in the composer rather than in the sources panel because a fold can
 * arrive from the Promoted quotes screen with the panel closed: this is the one
 * place every path can see. It names how many quotes are waiting and offers a
 * retry that re-marks only those -- their words are already in the body, so
 * nothing is spliced twice. Declinable: ignoring it costs nothing.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { RETRY_INCLUSION_LABEL, inclusionRetryHint } from './quoteFoldCopy';

import { SPACING, accent, editorialType, ink, spacing, touchTarget } from '@/design/tokens';

export interface QuoteInclusionHintProps {
  /** How many folded quotes still wait on their mark; nothing renders at zero. */
  failedCount: number;
  onRetry: () => void;
}

export function QuoteInclusionHint({
  failedCount,
  onRetry,
}: QuoteInclusionHintProps): React.JSX.Element | null {
  if (failedCount === 0) return null;
  return (
    <View style={styles.row} testID="quote-inclusion-hint">
      <Text style={styles.text} testID="quote-inclusion-hint-text">
        {inclusionRetryHint(failedCount)}
      </Text>
      <TouchableOpacity
        style={styles.retry}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={RETRY_INCLUSION_LABEL}
        testID="quote-inclusion-retry"
      >
        <Text style={styles.retryText}>{RETRY_INCLUSION_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACING.sm,
    // The save hint's own rhythm: the two read as one quiet line of status.
    paddingTop: spacing(1),
  },
  text: {
    ...editorialType.caption,
    color: ink.soft,
    flexShrink: 1,
  },
  retry: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
  },
  retryText: {
    ...editorialType.action,
    color: accent.primary,
  },
});

export default QuoteInclusionHint;
