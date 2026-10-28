/**
 * ``WritingHabitPicker`` — "Which habit?" for the writing timer (#2861).
 *
 * Shared by the end-of-session offer and by Settings, so the two cannot drift
 * on what may be linked or how a row reads. The writer's own habits are listed
 * by their own names, in their own order: nothing here guesses which habit is
 * "the writing one" by matching names, because the writer knows and the app
 * does not. Only habits a check-off can honestly apply to appear
 * (``isLinkableHabit``: server-backed, not a demo tile, not subtractive, with
 * the full tier ladder).
 *
 * Rows, top to bottom: the habits; then "New habit: Journaling" when the host
 * can create one (``onNew``); then "Clear link" when there is a link to clear
 * (``onClear``); then "Cancel", always — a way back that answers nothing.
 * Every row is a button with a label saying what the tap does, at the design
 * system's touch-target floor (via ``OfferAction``); nothing is drag-only.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import OfferAction from './OfferAction';
import {
  WRITING_HABIT_CANCEL,
  WRITING_HABIT_CANCEL_A11Y,
  WRITING_HABIT_CLEAR,
  WRITING_HABIT_CLEAR_A11Y,
  WRITING_HABIT_NEW,
  WRITING_HABIT_NEW_A11Y,
  WRITING_HABIT_PICKER_HELP,
  WRITING_HABIT_PICKER_TITLE,
  writingHabitChooseA11y,
} from './saveAsHabitCopy';
import { usePaymentScope } from './usePaymentScope';
import { canConfigureWritingHabit, isLinkableHabit } from './writingHabitCheckOff';
import WritingHabitGoalEditor from './WritingHabitGoalEditor';
import { saveWritingHabitGoals } from './writingHabitGoals';

import { useAuth } from '@/context/AuthContext';
import { SPACING, colors, editorialType } from '@/design/tokens';
import type { Habit, HabitGoalSetup } from '@/features/Habits/Habits.types';

export interface WritingHabitPickerProps {
  /** The writer's habits; the ones that cannot be linked are left out here. */
  habits: readonly Habit[];
  /** A habit was chosen. */
  onChoose: (_habit: Habit) => void;
  /** Close without choosing. */
  onCancel: () => void;
  /** Start a new Journaling habit instead; the row is shown only when given. */
  onNew?: (_setup: HabitGoalSetup) => void;
  /** Clear the current link; the row is shown only when given. */
  onClear?: () => void;
  /** A save is in flight: every choice is held so a tap cannot be spent twice. */
  busy?: boolean;
}

/** The optional rows below the habits: a new habit, then clearing the link. */
function ExtraRows({
  onNew,
  onClear,
  busy,
}: {
  onNew?: () => void;
  onClear?: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <>
      {onNew ? (
        <OfferAction
          label={WRITING_HABIT_NEW}
          a11yLabel={WRITING_HABIT_NEW_A11Y}
          onPress={onNew}
          disabled={busy}
          testID="writing-habit-new"
        />
      ) : null}
      {onClear ? (
        <OfferAction
          label={WRITING_HABIT_CLEAR}
          a11yLabel={WRITING_HABIT_CLEAR_A11Y}
          onPress={onClear}
          disabled={busy}
          testID="writing-habit-clear"
        />
      ) : null}
    </>
  );
}

function useCurrentChoice() {
  const currentSession = usePaymentScope();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return React.useCallback(() => alive.current && currentSession(), [currentSession]);
}

function useGoalChoice({ onNew, onChoose }: WritingHabitPickerProps) {
  const { token, userTimezone } = useAuth();
  const [selected, setSelected] = useState<Habit | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const current = useCurrentChoice();
  const selectionSession = useRef(current);
  useEffect(() => {
    setSelected(null);
    setError(false);
    setSaving(false);
  }, [current]);
  const cancel = () => {
    setSelected(null);
    setError(false);
  };
  const save = (setup: HabitGoalSetup) => {
    if (saving || !current()) return;
    if (selected === 'new') {
      onNew?.(setup);
      cancel();
      return;
    }
    if (!selected) return;
    setSaving(true);
    setError(false);
    void saveWritingHabitGoals(selected, setup, userTimezone, token ?? undefined)
      .then((confirmed) => {
        if (current() && confirmed) onChoose(confirmed);
      })
      .catch(() => {
        if (current()) setError(true);
      })
      .finally(() => {
        if (current()) setSaving(false);
      });
  };
  const choose = (habit: Habit | 'new') => {
    selectionSession.current = current;
    setSelected(habit);
  };
  return {
    selected: selectionSession.current === current && current() ? selected : null,
    saving,
    error,
    cancel,
    save,
    choose,
  };
}

function ConfigureRows({
  habits,
  onConfigure,
  busy,
}: {
  habits: readonly Habit[];
  onConfigure: (_habit: Habit) => void;
  busy: boolean;
}) {
  const candidates = habits.filter(
    (habit) => canConfigureWritingHabit(habit) && !isLinkableHabit(habit),
  );
  if (candidates.length === 0) return null;
  return (
    <View style={styles.rows}>
      <Text style={styles.help}>Set up another habit to count minutes or sessions:</Text>
      {candidates.map((habit) => (
        <OfferAction
          key={habit.id}
          label={`Set up ${habit.name}`}
          a11yLabel={`Set timer goals before linking ${habit.name}`}
          onPress={() => onConfigure(habit)}
          disabled={busy}
          testID={`writing-habit-configure-${habit.id}`}
        />
      ))}
    </View>
  );
}

function PickerRows({
  habits,
  onChoose,
  onCancel,
  onNew,
  onClear,
  onConfigure,
  busy = false,
}: Omit<WritingHabitPickerProps, 'onNew'> & {
  onNew?: () => void;
  onConfigure: (_habit: Habit) => void;
}) {
  return (
    <View style={styles.picker} testID="writing-habit-picker">
      <Text style={styles.title}>{WRITING_HABIT_PICKER_TITLE}</Text>
      <Text style={styles.help}>{WRITING_HABIT_PICKER_HELP}</Text>
      <View style={styles.rows}>
        {habits.filter(isLinkableHabit).map((habit) => (
          <OfferAction
            key={habit.id}
            label={habit.name}
            a11yLabel={writingHabitChooseA11y(habit.name)}
            onPress={() => onChoose(habit)}
            disabled={busy}
            testID={`writing-habit-choose-${habit.id}`}
          />
        ))}
        <ConfigureRows habits={habits} onConfigure={onConfigure} busy={busy} />
        <ExtraRows onNew={onNew} onClear={onClear} busy={busy} />
        <OfferAction
          label={WRITING_HABIT_CANCEL}
          a11yLabel={WRITING_HABIT_CANCEL_A11Y}
          onPress={onCancel}
          testID="writing-habit-cancel"
        />
      </View>
    </View>
  );
}

function WritingHabitPicker(props: WritingHabitPickerProps): React.JSX.Element {
  const choice = useGoalChoice(props);
  if (choice.selected !== null)
    return (
      <View style={styles.picker}>
        {choice.error ? (
          <Text style={styles.help} accessibilityRole="alert">
            Some goal changes may have saved. The link has not changed. Try again to confirm all
            goals.
          </Text>
        ) : null}
        <WritingHabitGoalEditor
          habit={choice.selected === 'new' ? undefined : choice.selected}
          onSave={choice.save}
          onCancel={choice.cancel}
          busy={props.busy || choice.saving}
        />
      </View>
    );
  return (
    <PickerRows
      {...props}
      onConfigure={choice.choose}
      onNew={props.onNew ? () => choice.choose('new') : undefined}
    />
  );
}

const styles = StyleSheet.create({
  picker: {
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  title: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  help: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
  rows: {
    alignItems: 'flex-start',
  },
});

export default WritingHabitPicker;
