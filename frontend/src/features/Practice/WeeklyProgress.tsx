import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { WEEKLY_TARGET } from './constants';

import { Celebration } from '@/components/feedback/Celebration';
import { accentDark, onShowcase, showcase, SPACING, BORDER_RADIUS } from '@/design/tokens';

/** Fixed segment indices so each completed session fills one visible block. */
const SEGMENTS = Array.from({ length: WEEKLY_TARGET }, (_, i) => i);

interface WeeklyProgressProps {
  count: number;
}

/** Helper line spelling out that the segments count practice sessions toward a weekly goal. */
function helperText(completed: number): string {
  if (completed >= WEEKLY_TARGET) return 'Weekly goal reached — nicely done.';
  const remaining = WEEKLY_TARGET - completed;
  if (completed === 0) {
    return `Complete ${WEEKLY_TARGET} practices this week to reach your goal.`;
  }
  const sessionWord = remaining === 1 ? 'practice' : 'practices';
  return `${remaining} more ${sessionWord} to reach your weekly goal.`;
}

const WeeklyProgress: React.FC<WeeklyProgressProps> = ({ count }) => {
  const completed = Math.max(0, Math.min(count, WEEKLY_TARGET));
  const isComplete = completed >= WEEKLY_TARGET;

  return (
    <View style={styles.container} testID="weekly-progress">
      <View style={styles.labelRow}>
        <Text style={styles.label}>Practices this week</Text>
        <Text style={[styles.count, isComplete && styles.countComplete]} testID="week-count-text">
          {count} of {WEEKLY_TARGET}
        </Text>
      </View>
      <View style={styles.segmentRow} testID="progress-bar-fill">
        {SEGMENTS.map((index) => {
          const filled = index < completed;
          return (
            <View
              key={index}
              testID={`weekly-segment-${index}`}
              accessibilityLabel={filled ? 'completed practice' : 'remaining practice'}
              style={[
                styles.segment,
                filled && styles.segmentFilled,
                filled && isComplete && styles.segmentComplete,
              ]}
            />
          );
        })}
      </View>
      <Celebration active={isComplete} testID="weekly-celebration">
        <Text
          style={[styles.helper, isComplete && styles.helperComplete]}
          testID={isComplete ? 'weekly-complete-message' : 'weekly-helper'}
        >
          {helperText(completed)}
        </Text>
      </Celebration>
    </View>
  );
};

// Styled for the dark umber player ground (#1905): on-showcase ink for the
// copy, a raised-step track, and the AA-clearing dark-canvas accent for the
// filled segments (`strong` marks the goal-reached state).
const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  label: {
    fontSize: 14,
    color: onShowcase.soft,
    fontWeight: '600',
  },
  count: {
    fontSize: 16,
    fontWeight: '700',
    color: onShowcase.primary,
  },
  countComplete: {
    color: accentDark.strong,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  segment: {
    flex: 1,
    height: 10,
    backgroundColor: showcase.raised,
    borderRadius: BORDER_RADIUS.circle,
  },
  segmentFilled: {
    backgroundColor: accentDark.primary,
  },
  segmentComplete: {
    backgroundColor: accentDark.strong,
  },
  helper: {
    fontSize: 13,
    color: onShowcase.soft,
    marginTop: SPACING.sm,
  },
  helperComplete: {
    color: accentDark.strong,
    fontWeight: '500',
  },
});

export default WeeklyProgress;
