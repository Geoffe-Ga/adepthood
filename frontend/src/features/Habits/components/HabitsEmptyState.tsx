import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, radius, spacing, touchTarget } from '../../../design/tokens';

interface HabitsEmptyStateProps {
  /** When provided, renders an "Add a habit" CTA wired to the add-habit modal. */
  onAdd?: () => void;
  /** First stage of the current lap; with `stageEnd`, switches to lap-invite copy. */
  stageStart?: number;
  /** Last stage of the current lap; with `stageStart`, switches to lap-invite copy. */
  stageEnd?: number;
}

interface EmptyStateCopy {
  title: string;
  subtitle: string;
}

const FIRST_RUN_COPY: EmptyStateCopy = {
  title: 'No habits yet',
  subtitle: 'Add your first habit to start building momentum. Small, daily actions compound.',
};

/**
 * Copy for the empty state. With a stage range supplied (any lap past the
 * first), it names the newly-open stages as a gentle, declinable invitation to
 * start another set — never a nudge. Otherwise it keeps the first-run guidance.
 */
const selectCopy = (stageStart?: number, stageEnd?: number): EmptyStateCopy =>
  stageStart !== undefined && stageEnd !== undefined
    ? {
        title: `Stages ${stageStart}–${stageEnd} are open`,
        subtitle:
          'Begin a new set whenever it feels right — no pressure either way, or simply keep tending the habits you already have.',
      }
    : FIRST_RUN_COPY;

/** First-run fallback guiding a zero-habit user to add their first (audit-ux-07). */
export const HabitsEmptyState = ({
  onAdd,
  stageStart,
  stageEnd,
}: HabitsEmptyStateProps): React.JSX.Element => {
  const { title, subtitle } = selectCopy(stageStart, stageEnd);
  return (
    <View style={styles.container} testID="habits-empty-state">
      <Text style={styles.icon}>{'+'}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {onAdd && (
        <TouchableOpacity
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add a habit"
          style={styles.cta}
          testID="habits-empty-add"
        >
          <Text style={styles.ctaText}>Add a habit</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(4),
  },
  icon: {
    fontSize: 40,
    color: colors.text.primary,
    marginBottom: spacing(1.5),
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing(1),
  },
  subtitle: {
    fontSize: 14,
    // AA on #f8f8f8 (5.41:1); CTA text.light sits on the dark secondary button.
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  cta: {
    marginTop: spacing(2.5),
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.light,
  },
});
