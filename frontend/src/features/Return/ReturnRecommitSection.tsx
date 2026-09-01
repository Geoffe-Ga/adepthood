/**
 * ``ReturnRecommitSection`` — the list of habits still resting from a Return,
 * each with its own take-it-up-again affordance.
 *
 * Shared by the two surfaces that can offer a rested habit back: the completion
 * card that closes a finished arc, and the resting card that stands on its own
 * once no arc is running. Both render the identical row, because a soft pause is
 * the same soft pause whether or not the arc that made it is still open — only
 * the framing copy above it differs, which is why ``heading`` and ``body`` are
 * props. Presentational and tokens-only; it renders nothing when nothing rests.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RETURN_RECOMMIT_ACTION,
  RETURN_RECOMMIT_BODY,
  RETURN_RECOMMIT_HEADING,
  buildReturnRecommitA11y,
} from './returnCopy';

import type { ReleasedHabit } from '@/api';
import { SPACING, colors, editorialType, spacing, touchTarget } from '@/design/tokens';

export interface ReturnRecommitSectionProps {
  releasedHabits: ReleasedHabit[];
  onRecommit: (_habitId: number) => void;
  /** Pass ``null`` when the surrounding card already renders its own header. */
  heading?: string | null;
  body?: string;
}

/** A single resting habit with its take-it-up-again affordance. */
function RecommitRow({
  habit,
  onRecommit,
}: {
  habit: ReleasedHabit;
  onRecommit: (_habitId: number) => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.recommitRow}
      onPress={() => onRecommit(habit.habit_id)}
      accessibilityRole="button"
      accessibilityLabel={buildReturnRecommitA11y(habit.name)}
      testID={`return-recommit-${habit.habit_id}`}
    >
      <Text style={styles.recommitName}>
        {habit.icon} {habit.name}
      </Text>
      <Text style={styles.recommitAction}>{RETURN_RECOMMIT_ACTION}</Text>
    </TouchableOpacity>
  );
}

/** Filter to the habits that have not been taken up again; the rest are done. */
export function restingHabits(releasedHabits: ReleasedHabit[]): ReleasedHabit[] {
  return releasedHabits.filter((habit) => !habit.recommitted);
}

function ReturnRecommitSection({
  releasedHabits,
  onRecommit,
  heading = RETURN_RECOMMIT_HEADING,
  body = RETURN_RECOMMIT_BODY,
}: ReturnRecommitSectionProps): React.JSX.Element | null {
  const resting = restingHabits(releasedHabits);
  if (resting.length === 0) return null;
  return (
    <View style={styles.recommitSection} testID="return-recommit-section">
      {heading === null ? null : <Text style={styles.recommitHeading}>{heading}</Text>}
      <Text style={styles.recommitBody}>{body}</Text>
      {resting.map((habit) => (
        <RecommitRow key={habit.habit_id} habit={habit} onRecommit={onRecommit} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  recommitSection: {
    marginTop: spacing(1.5),
  },
  recommitHeading: {
    ...editorialType.action,
    color: colors.paper.ink,
  },
  recommitBody: {
    ...editorialType.marginNote,
    color: colors.paper.inkSoft,
    marginTop: spacing(0.5),
  },
  recommitRow: {
    minHeight: touchTarget.minimum,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
  },
  recommitName: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    flexShrink: 1,
  },
  recommitAction: {
    ...editorialType.action,
    color: colors.tier.clear,
    marginLeft: SPACING.md,
  },
});

export default ReturnRecommitSection;
