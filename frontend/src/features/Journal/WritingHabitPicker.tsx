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
 *
 * The words default to the writing timer's. A host linking some other kind of
 * session — ``PracticeHabitPicker`` — passes its own ``copy`` and a
 * ``testIDPrefix`` of its own, so two pickers on one screen stay distinct.
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

/** The words a host may replace: what the picker asks, and what each row does. */
export interface HabitPickerCopy {
  title: string;
  help: string;
  /** A habit row's screen-reader label: what choosing it will do. */
  chooseA11y: (_habitName: string) => string;
  clearA11y: string;
}

/** The writing timer's words, which the picker uses unless told otherwise. */
export const WRITING_HABIT_PICKER_COPY: HabitPickerCopy = {
  title: WRITING_HABIT_PICKER_TITLE,
  help: WRITING_HABIT_PICKER_HELP,
  chooseA11y: writingHabitChooseA11y,
  clearA11y: WRITING_HABIT_CLEAR_A11Y,
};

/** The prefix every testID carries unless the host gives its own. */
export const WRITING_HABIT_TEST_ID_PREFIX = 'writing-habit';

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
  /** The host's own words, where they differ from the writing timer's. */
  copy?: Partial<HabitPickerCopy>;
  /** The host's own testID prefix, so two pickers on one screen stay distinct. */
  testIDPrefix?: string;
}

/** The optional rows below the habits: a new habit, then clearing the link. */
function ExtraRows({
  onNew,
  onClear,
  busy,
  clearA11y,
  prefix,
}: Pick<WritingHabitPickerProps, 'onNew' | 'onClear'> & {
  busy: boolean;
  clearA11y: string;
  prefix: string;
}): React.JSX.Element {
  return (
    <>
      {onNew ? (
        <OfferAction
          label={WRITING_HABIT_NEW}
          a11yLabel={WRITING_HABIT_NEW_A11Y}
          onPress={onNew}
          disabled={busy}
          testID={`${prefix}-new`}
        />
      ) : null}
      {onClear ? (
        <OfferAction
          label={WRITING_HABIT_CLEAR}
          a11yLabel={clearA11y}
          onPress={onClear}
          disabled={busy}
          testID={`${prefix}-clear`}
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
  copy,
  testIDPrefix = WRITING_HABIT_TEST_ID_PREFIX,
}: WritingHabitPickerProps): React.JSX.Element {
  const words: HabitPickerCopy = { ...WRITING_HABIT_PICKER_COPY, ...copy };
  const linkable = habits.filter(isLinkableHabit);
  return (
    <View style={styles.picker} testID={`${testIDPrefix}-picker`}>
      <Text style={styles.title}>{words.title}</Text>
      <Text style={styles.help}>{words.help}</Text>
      <View style={styles.rows}>
        {linkable.map((habit) => (
          <OfferAction
            key={habit.id}
            label={habit.name}
            a11yLabel={words.chooseA11y(habit.name)}
            onPress={() => onChoose(habit)}
            disabled={busy}
            testID={`${testIDPrefix}-choose-${habit.id}`}
          />
        ))}
        <ExtraRows
          onNew={onNew}
          onClear={onClear}
          busy={busy}
          clearA11y={words.clearA11y}
          prefix={testIDPrefix}
        />
        <OfferAction
          label={WRITING_HABIT_CANCEL}
          a11yLabel={WRITING_HABIT_CANCEL_A11Y}
          onPress={onCancel}
          testID={`${testIDPrefix}-cancel`}
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
