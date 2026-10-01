/**
 * Settings → Practice: which habit a finished practice session checks off.
 *
 * The practice-side twin of the Journal group's first row (#2861). The row
 * names the current link — "Practice sessions → <Name>", or "not linked" — and
 * opens ``PracticeHabitPicker``, with "Clear link" when there is one. The link
 * lives on the server (``/ui-flags``, ``practice_session_habit_id``), so it
 * reads the same on every device, and it is independent of the writing
 * timer's: the two kinds of session may check off different habits, or only
 * one of them may be linked at all.
 */
import { Hourglass } from 'lucide-react-native';
import React, { useCallback } from 'react';

import { SettingsRow } from './shared/SettingsRow';
import { useHabitLinkRow } from './shared/useHabitLinkRow';
import type { HabitLinkRowWords } from './shared/useHabitLinkRow';

import { EditorialSection } from '@/components/layout/EditorialSection';
import type { Habit } from '@/features/Habits/Habits.types';
import {
  PRACTICE_HABIT_ROW_DESCRIPTION,
  PRACTICE_HABIT_ROW_LINKED_PENDING,
  PRACTICE_SETTINGS_TITLE,
  practiceHabitRowLabel,
} from '@/features/Practice/practiceHabitCopy';
import PracticeHabitPicker from '@/features/Practice/PracticeHabitPicker';
import { usePracticeHabitLinkStore } from '@/store/usePracticeHabitLinkStore';

const WORDS: HabitLinkRowWords = {
  pendingLabel: PRACTICE_HABIT_ROW_LINKED_PENDING,
  rowLabel: practiceHabitRowLabel,
  logTag: 'PracticeSection',
};

const PracticeSection = (): React.JSX.Element => {
  const row = useHabitLinkRow(usePracticeHabitLinkStore, WORDS);
  const { save } = row;
  const choose = useCallback((habit: Habit) => save(habit.id), [save]);
  const clear = useCallback(() => save(null), [save]);

  return (
    <EditorialSection title={PRACTICE_SETTINGS_TITLE} testID="settings-group-practice">
      <SettingsRow
        icon={Hourglass}
        label={row.label}
        description={PRACTICE_HABIT_ROW_DESCRIPTION}
        onPress={row.toggle}
        testID="settings-row-practice-habit"
      />
      {row.open ? (
        <PracticeHabitPicker
          habits={row.habits}
          busy={row.busy}
          onChoose={choose}
          onClear={row.linked ? clear : undefined}
          onCancel={row.close}
        />
      ) : null}
    </EditorialSection>
  );
};

export default PracticeSection;
