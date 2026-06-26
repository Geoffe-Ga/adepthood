import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors, radius, spacing } from '../../../design/tokens';

interface HabitsEmptyStateProps {
  /** When provided, renders an "Add a habit" CTA wired to the add-habit modal. */
  onAdd?: () => void;
}

/** First-run fallback guiding a zero-habit user to add their first (audit-ux-07). */
export const HabitsEmptyState = ({ onAdd }: HabitsEmptyStateProps): React.JSX.Element => (
  <View style={styles.container} testID="habits-empty-state">
    <Text style={styles.icon}>{'+'}</Text>
    <Text style={styles.title}>No habits yet</Text>
    <Text style={styles.subtitle}>
      Add your first habit to start building momentum. Small, daily actions compound.
    </Text>
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
    // text.secondary on the light Habits canvas (#f8f8f8) meets WCAG AA; the
    // CTA text below stays text.light on the dark colors.secondary button.
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
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.light,
  },
});
