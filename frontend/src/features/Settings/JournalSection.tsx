/**
 * Settings → Journal (#2861): which habit the writing timer checks off, a way
 * to bring back the end-of-session offer, and a way to bring back the
 * morning-pages invitation (#3005).
 *
 * The first row names the current link — "Writing timer → <Name>", or "not
 * linked" — and opens the same ``WritingHabitPicker`` the offer uses, here with
 * "Clear link" when there is one. The link lives on the server
 * (``/ui-flags``), so it reads the same on every device.
 *
 * The second row reopens the offer a writer said "No thanks" to. That answer is
 * kept on THIS device (``writingOfferStorage``), so the copy promises exactly
 * that and no more. Reopening is the writer's own choice, made here, which is
 * what keeps it an invitation rather than a nag.
 *
 * The third row does the same for the shelf's morning-pages tip after "Don't
 * show this again" — also kept on this device (``morningPagesTipStorage``). It
 * clears today's set-aside too, so the tip is on the shelf when the writer
 * goes back to it, not only tomorrow.
 *
 * While a link is known but its habit has not been read yet, the row says
 * "a habit" — never "not linked", which would tell a linked writer the opposite
 * of the truth — and the habits are read so the name can resolve.
 */
import { NotebookPen, RotateCcw } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';

import { SettingsRow } from './shared/SettingsRow';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { isHabitUnlocked } from '@/features/Habits/HabitUtils';
import { habitManager } from '@/features/Habits/services/habitManager';
import {
  MORNING_PAGES_OFFER_AGAIN_DESCRIPTION,
  MORNING_PAGES_OFFER_AGAIN_DONE,
  MORNING_PAGES_OFFER_AGAIN_LABEL,
} from '@/features/Journal/morningPagesCopy';
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
import { restoreMorningPagesTip } from '@/storage/morningPagesTipStorage';
import { saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';

/** The row's words for a link: none, a named habit, or one not read yet. */
function rowLabelFor(habitId: number | null, habits: readonly Habit[]): string {
  if (habitId === null) return writingTimerRowLabel(null);
  const linked = habits.find((habit) => habit.id === habitId);
  if (!linked) return WRITING_TIMER_ROW_LINKED_PENDING;
  return writingTimerRowLabel(linked.name, { paused: !isHabitUnlocked(linked) });
}

/** Read the habits quietly: a failure leaves the pending label, never an error. */
function loadHabitsQuietly(tz: string): void {
  habitManager.loadHabits(tz).catch((err: unknown) => {
    console.warn('[JournalSection] failed to read habits', err);
  });
}

/** The link, the picker's open state, and the moves that change them. */
function useWritingHabitRow(): {
  label: string;
  habits: readonly Habit[];
  linked: boolean;
  open: boolean;
  busy: boolean;
  toggle: () => void;
  close: () => void;
  save: (_habitId: number | null) => void;
} {
  const { token, userTimezone } = useAuth();
  const habits = useHabitStore((state) => state.habits);
  const habitId = useWritingHabitLinkStore((state) => state.habitId);
  const hydrate = useWritingHabitLinkStore((state) => state.hydrate);
  const setLink = useWritingHabitLinkStore((state) => state.setLink);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = rowLabelFor(habitId, habits);
  const pending = label === WRITING_TIMER_ROW_LINKED_PENDING;

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);
  useEffect(() => {
    if (pending) loadHabitsQuietly(userTimezone);
  }, [pending, userTimezone]);

  const toggle = useCallback(() => {
    if (!open) loadHabitsQuietly(userTimezone);
    setOpen(!open);
  }, [open, userTimezone]);
  const save = useCallback(
    (next: number | null) => {
      setBusy(true);
      void setLink(next, token ?? undefined).then((saved) => {
        setBusy(false);
        if (saved) setOpen(false);
      });
    },
    [setLink, token],
  );
  const close = useCallback(() => setOpen(false), []);
  return { label, habits, linked: habitId !== null, open, busy, toggle, close, save };
}

const JournalSection = (): React.JSX.Element => {
  const row = useWritingHabitRow();
  const [reopened, setReopened] = useState(false);
  const offerAgain = useCallback(() => {
    void saveWritingOfferAnswered(false).then(() => setReopened(true));
  }, []);
  const [tipReopened, setTipReopened] = useState(false);
  const offerTipAgain = useCallback(() => {
    void restoreMorningPagesTip().then((restored) => setTipReopened(restored));
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
      <SettingsRow
        icon={RotateCcw}
        label={MORNING_PAGES_OFFER_AGAIN_LABEL}
        description={
          tipReopened ? MORNING_PAGES_OFFER_AGAIN_DONE : MORNING_PAGES_OFFER_AGAIN_DESCRIPTION
        }
        onPress={offerTipAgain}
        testID="settings-row-morning-pages-offer-again"
      />
    </EditorialSection>
  );
};

export default JournalSection;
