import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { PracticeItem } from '@/api';
import { colors, SPACING, BORDER_RADIUS, shadows } from '@/design/tokens';

interface PracticeSelectorProps {
  practices: PracticeItem[];
  selectedPracticeId: number | null;
  onSelect: (_id: number) => void;
  isLoading: boolean;
}

const PracticeSelector: React.FC<PracticeSelectorProps> = ({
  practices,
  selectedPracticeId,
  onSelect,
  isLoading,
}) => {
  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="selector-loading">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (practices.length === 0) {
    return (
      <View style={styles.emptyContainer} testID="selector-empty">
        <Text style={styles.emptyText}>No practices available for this stage yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="practice-selector">
      <Text style={styles.heading}>Choose a Practice</Text>
      {practices.map((practice) => {
        const isSelected = practice.id === selectedPracticeId;
        return (
          <View
            key={practice.id}
            style={[styles.card, isSelected && styles.cardSelected]}
            testID={`practice-card-${practice.id}`}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.practiceName}>{practice.name}</Text>
              {isSelected && (
                <Text style={styles.checkmark} testID="selected-checkmark">
                  ✓
                </Text>
              )}
            </View>
            <Text style={styles.description}>{practice.description}</Text>
            <Text style={styles.duration}>{practice.default_duration_minutes} min per session</Text>
            {!isSelected && (
              <TouchableOpacity
                style={styles.selectButton}
                onPress={() => onSelect(practice.id)}
                testID={`select-practice-${practice.id}`}
              >
                <Text style={styles.selectButtonText}>Select</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: SPACING.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
  },
  emptyContainer: {
    padding: SPACING.xxl,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 16,
    textAlign: 'center',
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.lg,
  },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  cardSelected: {
    borderWidth: 2,
    borderColor: colors.success,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  practiceName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text.primary,
    flex: 1,
  },
  checkmark: {
    fontSize: 20,
    color: colors.success,
    fontWeight: '700',
  },
  description: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.sm,
    lineHeight: 20,
  },
  duration: {
    fontSize: 13,
    color: colors.text.tertiary,
    marginBottom: SPACING.md,
  },
  selectButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  selectButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 15,
  },
});

export default PracticeSelector;
