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
import React from 'react';
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
import { isLinkableHabit } from './writingHabitCheckOff';

import { SPACING, colors, editorialType } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';

export interface WritingHabitPickerProps {
  /** The writer's habits; the ones that cannot be linked are left out here. */
  habits: readonly Habit[];
  /** A habit was chosen. */
  onChoose: (_habit: Habit) => void;
  /** Close without choosing. */
  onCancel: () => void;
  /** Start a new Journaling habit instead; the row is shown only when given. */
  onNew?: () => void;
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
}: Pick<WritingHabitPickerProps, 'onNew' | 'onClear'> & { busy: boolean }): React.JSX.Element {
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

function WritingHabitPicker({
  habits,
  onChoose,
  onCancel,
  onNew,
  onClear,
  busy = false,
}: WritingHabitPickerProps): React.JSX.Element {
  const linkable = habits.filter(isLinkableHabit);
  return (
    <View style={styles.picker} testID="writing-habit-picker">
      <Text style={styles.title}>{WRITING_HABIT_PICKER_TITLE}</Text>
      <Text style={styles.help}>{WRITING_HABIT_PICKER_HELP}</Text>
      <View style={styles.rows}>
        {linkable.map((habit) => (
          <OfferAction
            key={habit.id}
            label={habit.name}
            a11yLabel={writingHabitChooseA11y(habit.name)}
            onPress={() => onChoose(habit)}
            disabled={busy}
            testID={`writing-habit-choose-${habit.id}`}
          />
        ))}
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
