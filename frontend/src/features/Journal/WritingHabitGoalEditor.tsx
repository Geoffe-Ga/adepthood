import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  JOURNAL_HABIT_DEFAULT_MINUTES,
  JOURNAL_HABIT_DEFAULT_SESSIONS,
  validWritingGoalSetup,
  writingGoalDraft,
  writingGoalSetup,
} from './journalHabitDefaults';
import OfferAction from './OfferAction';

import { SPACING, colors, editorialType } from '@/design/tokens';
import { GoalTargetEditor } from '@/features/Habits/components/GoalModal';
import type { Goal, Habit, HabitGoalSetup } from '@/features/Habits/Habits.types';

export interface WritingHabitGoalEditorProps {
  habit?: Habit;
  onSave: (_setup: HabitGoalSetup) => void;
  onCancel: () => void;
  busy?: boolean;
}

function useGoalDraft(habit?: Habit) {
  const [draft, setDraft] = useState(() => writingGoalDraft(habit));
  const setup = writingGoalSetup(draft);
  const updateGoal = (_id: number, updated: Goal) =>
    setDraft((previous) => ({
      ...previous,
      goals: previous.goals.map((goal) => (goal.tier === updated.tier ? updated : goal)),
    }));
  const updateUnits = (
    _id: number,
    changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>,
  ) =>
    setDraft((previous) => ({
      ...previous,
      goals: previous.goals.map((goal) => ({
        ...goal,
        ...changes,
        ...(changes.target_unit && changes.target_unit !== goal.target_unit
          ? {
              target: (changes.target_unit === 'sessions'
                ? JOURNAL_HABIT_DEFAULT_SESSIONS
                : JOURNAL_HABIT_DEFAULT_MINUTES)[goal.tier],
            }
          : {}),
      })),
    }));
  return { draft, setup, valid: validWritingGoalSetup(setup), updateGoal, updateUnits };
}

export default function WritingHabitGoalEditor({
  habit,
  onSave,
  onCancel,
  busy = false,
}: WritingHabitGoalEditorProps) {
  const { draft, setup, valid, updateGoal, updateUnits } = useGoalDraft(habit);
  return (
    <View style={styles.form} testID="writing-habit-goals">
      <Text style={styles.copy}>Timer goals</Text>
      <Text style={styles.copy}>
        Choose minutes or full sessions. Your timer logs the amount you measured.
      </Text>
      <GoalTargetEditor
        habit={draft}
        timerOnly
        onUpdateGoal={updateGoal}
        onUpdateGoalUnits={updateUnits}
      />
      {valid ? null : (
        <Text style={styles.copy}>Choose positive goals ordered from Low through Stretch.</Text>
      )}
      <OfferAction
        label={busy ? 'Saving goals…' : 'Use these goals'}
        a11yLabel="Use these timer habit goals"
        onPress={() => onSave(setup)}
        disabled={busy || !valid}
        testID="writing-habit-goals-save"
      />
      <OfferAction
        label="Cancel"
        a11yLabel="Cancel setting timer habit goals"
        onPress={onCancel}
        disabled={busy}
        testID="writing-habit-goals-cancel"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: SPACING.sm },
  copy: { ...editorialType.note, color: colors.paper.ink },
});
