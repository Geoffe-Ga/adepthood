import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, editorialType, surface } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import OfferAction from '@/features/Journal/OfferAction';

/** Keep long choices readable on desktop while the card fits narrow phones. */
const PICKER_MAX_WIDTH = 480;

export interface PracticeHabitPickerProps {
  practiceName: string;
  /** Server-backed eligible timer habits supplied by the link controller. */
  habits: readonly Habit[];
  onChoose: (_habit: Habit) => void;
  onNew: () => void;
  onClear?: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

function ExistingHabits({
  habits,
  onChoose,
  busy,
}: Pick<PracticeHabitPickerProps, 'habits' | 'onChoose' | 'busy'>): React.JSX.Element {
  return (
    <>
      {habits.map((habit) => (
        <OfferAction
          key={habit.id}
          label={habit.name}
          a11yLabel={`Link ${habit.name} to this practice`}
          onPress={() => onChoose(habit)}
          disabled={busy}
          testID={`practice-habit-choose-${habit.id}`}
        />
      ))}
    </>
  );
}

type ChoicesProps = Omit<PracticeHabitPickerProps, 'onCancel'>;

/** The scrolling rows: every one a write, so every one held while busy. */
function Choices({
  practiceName,
  habits,
  onChoose,
  onNew,
  onClear,
  busy,
  error,
}: ChoicesProps): React.JSX.Element {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.rows}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ExistingHabits habits={habits} onChoose={onChoose} busy={busy} />
      <OfferAction
        label={`New habit: ${practiceName}`}
        a11yLabel={`Create a habit called ${practiceName} for this practice`}
        onPress={onNew}
        disabled={busy}
        testID="practice-habit-new"
      />
      {onClear ? (
        <OfferAction
          label="Clear link"
          a11yLabel="Stop logging this practice to its linked habit"
          onPress={onClear}
          disabled={busy}
          testID="practice-habit-clear"
        />
      ) : null}
    </ScrollView>
  );
}

export default function PracticeHabitPicker({
  practiceName,
  habits,
  onChoose,
  onNew,
  onClear,
  onCancel,
  busy = false,
  error,
}: PracticeHabitPickerProps): React.JSX.Element {
  // A choose or clear PATCH still lands and applies after the picker closes,
  // so closing mid-request would read as "cancelled" while the link changes
  // anyway (#3382). Hold both ways out — Cancel and the system back / Escape —
  // until the request settles; a failure re-enables them beside its message.
  const dismiss = (): void => {
    if (!busy) onCancel();
  };
  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={dismiss}
      testID="practice-habit-picker-modal"
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal testID="practice-habit-picker">
          <Text accessibilityRole="header" style={styles.title}>
            Link a habit
          </Text>
          <Text style={styles.help}>Each completed session can count toward a habit.</Text>
          <Choices
            practiceName={practiceName}
            habits={habits}
            onChoose={onChoose}
            onNew={onNew}
            onClear={onClear}
            busy={busy}
            error={error}
          />
          <OfferAction
            label="Cancel"
            a11yLabel="Close without choosing a habit"
            onPress={dismiss}
            disabled={busy}
            testID="practice-habit-cancel"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
    backgroundColor: colors.mystical.overlay,
  },
  card: {
    width: '100%',
    maxWidth: PICKER_MAX_WIDTH,
    maxHeight: '85%',
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
  },
  title: { ...editorialType.note, color: colors.paper.ink },
  help: { ...editorialType.caption, color: colors.paper.inkSoft, marginVertical: SPACING.sm },
  scroll: { flexShrink: 1 },
  rows: { gap: SPACING.xs },
  error: { ...editorialType.caption, color: colors.danger },
});
