/**
 * ``ReturnCompletionCard`` — the warm close of a finished Return arc: all five
 * foci met, self through all beings. A quiet, reflective set-down rather than a
 * reward or rank, with the single ``set it down`` affordance. Presentational +
 * reduced-motion-safe; tokens only. Reads as a softer sibling of ``ReturnArcCard``.
 */
import React from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RETURN_ARC_LEAVE,
  RETURN_ARC_LEAVE_A11Y,
  RETURN_COMPLETE_BODY,
  RETURN_COMPLETE_HEADING,
  RETURN_RECOMMIT_ACTION,
  RETURN_RECOMMIT_BODY,
  RETURN_RECOMMIT_HEADING,
  buildReturnRecommitA11y,
} from './returnCopy';

import type { ReleasedHabit } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { usePressScale } from '@/hooks/usePressScale';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface ReturnCompletionCardProps {
  onLeave: () => void;
  releasedHabits?: ReleasedHabit[];
  onRecommit?: (_habitId: number) => void;
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

/** The re-commit section: habits rested this arc, each individually re-adoptable. */
function RecommitSection({
  releasedHabits,
  onRecommit,
}: {
  releasedHabits: ReleasedHabit[];
  onRecommit: (_habitId: number) => void;
}): React.JSX.Element | null {
  const resting = releasedHabits.filter((habit) => !habit.recommitted);
  if (resting.length === 0) return null;
  return (
    <View style={styles.recommitSection} testID="return-recommit-section">
      <Text style={styles.recommitHeading}>{RETURN_RECOMMIT_HEADING}</Text>
      <Text style={styles.recommitBody}>{RETURN_RECOMMIT_BODY}</Text>
      {resting.map((habit) => (
        <RecommitRow key={habit.habit_id} habit={habit} onRecommit={onRecommit} />
      ))}
    </View>
  );
}

function ReturnCompletionCard({
  onLeave,
  releasedHabits = [],
  onRecommit,
}: ReturnCompletionCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const handleRecommit = onRecommit ?? (() => undefined);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID="return-completion-card">
        <Text style={styles.heading} accessibilityRole="header">
          {RETURN_COMPLETE_HEADING}
        </Text>
        <Text style={styles.body}>{RETURN_COMPLETE_BODY}</Text>
        <RecommitSection releasedHabits={releasedHabits} onRecommit={handleRecommit} />
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.leave}
            onPress={onLeave}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            accessibilityRole="button"
            accessibilityLabel={RETURN_ARC_LEAVE_A11Y}
            testID="return-completion-leave"
          >
            <Text style={styles.leaveText}>{RETURN_ARC_LEAVE}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.low,
    ...paperShadow.card,
  },
  heading: {
    ...editorialType.heading,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing(1.5),
  },
  leave: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveText: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
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

export default ReturnCompletionCard;
