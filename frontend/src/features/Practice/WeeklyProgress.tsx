import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, SPACING, BORDER_RADIUS } from '@/design/tokens';

const WEEKLY_TARGET = 4;

interface WeeklyProgressProps {
  count: number;
}

const WeeklyProgress: React.FC<WeeklyProgressProps> = ({ count }) => {
  const progress = Math.min(count / WEEKLY_TARGET, 1);
  const isComplete = count >= WEEKLY_TARGET;

  return (
    <View style={styles.container} testID="weekly-progress">
      <View style={styles.labelRow}>
        <Text style={styles.label}>This Week</Text>
        <Text style={[styles.count, isComplete && styles.countComplete]} testID="week-count-text">
          {count}/{WEEKLY_TARGET}
        </Text>
      </View>
      <View style={styles.barBackground}>
        <View
          style={[
            styles.barFill,
            { width: `${progress * 100}%` },
            isComplete && styles.barComplete,
          ]}
          testID="progress-bar-fill"
        />
      </View>
      {isComplete && (
        <Text style={styles.completeText} testID="weekly-complete-message">
          Weekly target reached!
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  label: {
    fontSize: 14,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  count: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
  },
  countComplete: {
    color: colors.success,
  },
  barBackground: {
    height: 8,
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.circle,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.circle,
  },
  barComplete: {
    backgroundColor: colors.success,
  },
  completeText: {
    fontSize: 13,
    color: colors.success,
    fontWeight: '500',
    marginTop: SPACING.xs,
    textAlign: 'center',
  },
});

export default WeeklyProgress;
