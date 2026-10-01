/**
 * Settings → Journal (#2861): which habit the writing timer checks off, and a
 * way to bring back the end-of-session offer.
 *
 * The first row names the current link — "Writing timer → <Name>", or "not
 * linked" — and opens the same ``WritingHabitPicker`` the offer uses, here with
 * "Clear link" when there is one. The link lives on the server
 * (``/ui-flags``), so it reads the same on every device. The row's state is
 * ``useHabitLinkRow``'s, shared with the Practice group's row.
 *
 * The second row reopens the offer a writer said "No thanks" to. That answer is
 * kept on THIS device (``writingOfferStorage``), so the copy promises exactly
 * that and no more. Reopening is the writer's own choice, made here, which is
 * what keeps it an invitation rather than a nag.
 */
import { NotebookPen, RotateCcw } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';

import { SettingsRow } from './shared/SettingsRow';
import { useHabitLinkRow } from './shared/useHabitLinkRow';
import type { HabitLinkRowWords } from './shared/useHabitLinkRow';

import { EditorialSection } from '@/components/layout/EditorialSection';
import type { Habit } from '@/features/Habits/Habits.types';
import {
  JOURNAL_SETTINGS_TITLE,
  OFFER_AGAIN_DESCRIPTION,
  OFFER_AGAIN_DONE,
  OFFER_AGAIN_LABEL,
  WRITING_TIMER_ROW_DESCRIPTION,
  WRITING_TIMER_ROW_LINKED_PENDING,
  writingTimerRowLabel,
} from '@/features/Journal/saveAsHabitCopy';
import WritingHabitPicker from '@/features/Journal/WritingHabitPicker';
import { saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

const WORDS: HabitLinkRowWords = {
  pendingLabel: WRITING_TIMER_ROW_LINKED_PENDING,
  rowLabel: writingTimerRowLabel,
  logTag: 'JournalSection',
};

const JournalSection = (): React.JSX.Element => {
  const row = useHabitLinkRow(useWritingHabitLinkStore, WORDS);
  const [reopened, setReopened] = useState(false);
  const offerAgain = useCallback(() => {
    void saveWritingOfferAnswered(false).then(() => setReopened(true));
  }, []);
  const { save } = row;
  const choose = useCallback((habit: Habit) => save(habit.id), [save]);
  const clear = useCallback(() => save(null), [save]);

  return (
    <EditorialSection title={JOURNAL_SETTINGS_TITLE} testID="settings-group-journal">
      <SettingsRow
        icon={NotebookPen}
        label={row.label}
        description={WRITING_TIMER_ROW_DESCRIPTION}
        onPress={row.toggle}
        testID="settings-row-writing-habit"
      />
      {row.open ? (
        <WritingHabitPicker
          habits={row.habits}
          busy={row.busy}
          onChoose={choose}
          onClear={row.linked ? clear : undefined}
          onCancel={row.close}
        />
      ) : null}
      <SettingsRow
        icon={RotateCcw}
        label={OFFER_AGAIN_LABEL}
        description={reopened ? OFFER_AGAIN_DONE : OFFER_AGAIN_DESCRIPTION}
        onPress={offerAgain}
        testID="settings-row-writing-offer-again"
      />
    </EditorialSection>
  );
};

export default JournalSection;
