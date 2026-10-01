/**
 * ``PracticeHabitPicker`` — "Which habit?" for practice sessions.
 *
 * The writing timer's picker (``WritingHabitPicker``, #2861) in the practice's
 * own words, with its own testIDs so the two can share a Settings screen.
 * There is no "New habit" row: a practice link is to a habit the person
 * already keeps — the journal's offer to start a Journaling habit has no
 * practice-side counterpart.
 */
import React from 'react';

import {
  PRACTICE_HABIT_CLEAR_A11Y,
  PRACTICE_HABIT_PICKER_HELP,
  PRACTICE_HABIT_PICKER_TITLE,
  practiceHabitChooseA11y,
} from './practiceHabitCopy';

import WritingHabitPicker from '@/features/Journal/WritingHabitPicker';
import type {
  HabitPickerCopy,
  WritingHabitPickerProps,
} from '@/features/Journal/WritingHabitPicker';

/** The practice's words for the shared picker. */
export const PRACTICE_HABIT_PICKER_COPY: HabitPickerCopy = {
  title: PRACTICE_HABIT_PICKER_TITLE,
  help: PRACTICE_HABIT_PICKER_HELP,
  chooseA11y: practiceHabitChooseA11y,
  clearA11y: PRACTICE_HABIT_CLEAR_A11Y,
};

/** Every testID the practice picker renders starts with this. */
export const PRACTICE_HABIT_TEST_ID_PREFIX = 'practice-habit';

export type PracticeHabitPickerProps = Omit<
  WritingHabitPickerProps,
  'copy' | 'testIDPrefix' | 'onNew'
>;

function PracticeHabitPicker(props: PracticeHabitPickerProps): React.JSX.Element {
  return (
    <WritingHabitPicker
      {...props}
      copy={PRACTICE_HABIT_PICKER_COPY}
      testIDPrefix={PRACTICE_HABIT_TEST_ID_PREFIX}
    />
  );
}

export default PracticeHabitPicker;
