import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors } from '../../../design/tokens';
import styles from '../Habits.styles';

import type { ReviewDestination, ReviewRow } from './onboardingReview';

/**
 * The step that asks before it assumes.
 *
 * A returning user's habits are the answer to a question nobody had asked them:
 * scaffolding again used to open on a blank page and append whatever they typed
 * beside everything they already had. This step lists what they have and offers
 * two independent choices per habit, both of them ordinary.
 *
 * Nothing here is weighted. The two destinations are the same pill, the same
 * size, in the same row, each with its own one-line description shown at all
 * times so neither reads as the answer the app is hoping for; a habit already
 * carried from before the program simply opens on the destination it is already
 * living in. Unchecking is a plain toggle that undoes itself, and the
 * confirmation it eventually leads to is somewhere else entirely — this step
 * mutates nothing and promises nothing.
 */

const BRING_ALONG: ReviewDestination = 'bring-along';
const RE_RATE: ReviewDestination = 're-rate';

const DESTINATIONS: ReadonlyArray<{
  readonly value: ReviewDestination;
  readonly label: string;
  readonly description: string;
  readonly testIDPrefix: string;
}> = [
  {
    value: BRING_ALONG,
    label: 'Bring along',
    description:
      'Already mastered — tracked on your carryover pages, taken for granted from here on.',
    testIDPrefix: 'review-bring-along-',
  },
  {
    value: RE_RATE,
    label: 'Re-rate',
    description:
      'Rated again, and given a place in the new energy order alongside anything you add.',
    testIDPrefix: 'review-re-rate-',
  },
];

interface DestinationPillProps {
  habitId: number;
  option: (typeof DESTINATIONS)[number];
  selected: boolean;
  onSelect: (_habitId: number, _destination: ReviewDestination) => void;
}

const DestinationPill = ({ habitId, option, selected, onSelect }: DestinationPillProps) => (
  <TouchableOpacity
    testID={`${option.testIDPrefix}${habitId}`}
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    accessibilityLabel={`${option.label}: ${option.description}`}
    style={[reviewStyles.pill, selected && reviewStyles.pillSelected]}
    onPress={() => onSelect(habitId, option.value)}
  >
    <Text style={reviewStyles.pillLabel}>{option.label}</Text>
    <Text style={reviewStyles.pillDescription}>{option.description}</Text>
  </TouchableOpacity>
);

interface ReviewRowTileProps {
  row: ReviewRow;
  onToggleKeep: (_habitId: number) => void;
  onSelectDestination: (_habitId: number, _destination: ReviewDestination) => void;
}

const ReviewRowTile = ({ row, onToggleKeep, onSelectDestination }: ReviewRowTileProps) => (
  <View style={styles.energyTile} testID={`review-row-${row.habitId}`}>
    <TouchableOpacity
      testID={`review-keep-${row.habitId}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: row.keep }}
      accessibilityLabel={`Keep ${row.name}`}
      style={reviewStyles.keepRow}
      onPress={() => onToggleKeep(row.habitId)}
    >
      <Text style={reviewStyles.checkbox}>{row.keep ? '✓' : ' '}</Text>
      <Text style={styles.energyTileName}>
        {row.icon} {row.name}
      </Text>
    </TouchableOpacity>
    {row.keep && (
      <View style={reviewStyles.pillRow}>
        {DESTINATIONS.map((option) => (
          <DestinationPill
            key={option.value}
            habitId={row.habitId}
            option={option}
            selected={row.destination === option.value}
            onSelect={onSelectDestination}
          />
        ))}
      </View>
    )}
  </View>
);

export interface OnboardingReviewStepProps {
  rows: readonly ReviewRow[];
  onToggleKeep: (_habitId: number) => void;
  onSelectDestination: (_habitId: number, _destination: ReviewDestination) => void;
  onContinue: () => void;
}

export const OnboardingReviewStep = ({
  rows,
  onToggleKeep,
  onSelectDestination,
  onContinue,
}: OnboardingReviewStepProps) => (
  <SafeAreaView style={styles.onboardingStep} testID="review-step">
    <Text style={styles.onboardingTitle}>The habits you already have</Text>
    <Text style={styles.onboardingSubtitle}>
      Keep the ones that are still yours, and say where each one belongs. Unticking one lets it go
      for good.
    </Text>
    <ScrollView>
      {rows.map((row) => (
        <ReviewRowTile
          key={row.habitId}
          row={row}
          onToggleKeep={onToggleKeep}
          onSelectDestination={onSelectDestination}
        />
      ))}
    </ScrollView>
    <View style={styles.onboardingFooter}>
      <TouchableOpacity
        testID="review-continue"
        style={[styles.onboardingContinueButton, styles.footerContinue]}
        onPress={onContinue}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  </SafeAreaView>
);

const reviewStyles = StyleSheet.create({
  keepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  checkbox: {
    fontSize: 18,
    width: 28,
    height: 28,
    lineHeight: 26,
    textAlign: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderRadius: 4,
    borderColor: colors.mystical.glowLight,
    color: colors.secondary,
  },
  pillRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  pill: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mystical.glowLight,
    backgroundColor: '#fffdf7',
  },
  pillSelected: {
    borderColor: colors.secondary,
    backgroundColor: colors.mystical.glowLight,
  },
  pillLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  pillDescription: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
    color: '#555',
  },
});

export default OnboardingReviewStep;
