/**
 * ``ReturnRestingCard`` — the way back for habits set down during a Return the
 * person has since walked away from.
 *
 * Letting a habit rest is a soft pause, never a deletion: the habit keeps every
 * goal and every logged day. But the card that offered the pause lives inside
 * the arc, so leaving the arc used to take the only visible way back with it,
 * and a rested habit could be recovered only by long-pressing a locked tile.
 * This card stands outside the arc so the invitation that paused a habit can
 * always undo itself. It renders only when something is actually resting, so it
 * never becomes one more thing asking to be dealt with.
 *
 * Presentational and tokens-only; a quieter sibling of ``ReturnCompletionCard``.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { RETURN_RESTING_BODY, RETURN_RESTING_HEADING } from './returnCopy';
import ReturnRecommitSection from './ReturnRecommitSection';

import type { ReleasedHabit } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
} from '@/design/tokens';

export interface ReturnRestingCardProps {
  restingHabits: ReleasedHabit[];
  onRecommit: (_habitId: number) => void;
}

function ReturnRestingCard({
  restingHabits,
  onRecommit,
}: ReturnRestingCardProps): React.JSX.Element {
  return (
    <View style={styles.card} testID="return-resting-card">
      <Text style={styles.heading} accessibilityRole="header">
        {RETURN_RESTING_HEADING}
      </Text>
      <ReturnRecommitSection
        releasedHabits={restingHabits}
        onRecommit={onRecommit}
        heading={null}
        body={RETURN_RESTING_BODY}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.low,
    marginTop: spacing(1),
    ...paperShadow.card,
  },
  heading: {
    ...editorialType.heading,
    color: colors.paper.ink,
  },
});

export default ReturnRestingCard;
