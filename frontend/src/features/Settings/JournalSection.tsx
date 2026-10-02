/**
 * Settings → Journal (#2861): which habit the writing timer checks off, and
 * three switches for the invitations the journal makes — the end-of-session
 * offer, the morning-pages tip (#3005), and the link-a-habit note (#3006).
 *
 * The first row names the current link — "Writing timer → <Name>", or "not
 * linked" — and opens the same ``WritingHabitPicker`` the offer uses, here with
 * "Clear link" when there is one. The link lives on the server
 * (``/ui-flags``), so it reads the same on every device.
 *
 * The three switches each show one device-kept flag the other way up: the
 * journal records a "No thanks" or a "Don't show again", and the switch is
 * that same fact seen from here. So a decline made in the moment turns its
 * switch off by itself, and the writer turns it back on — or off — here. Each
 * is kept on THIS device (``writingOfferStorage``, ``morningPagesTipStorage``,
 * ``linkHabitNudgeStorage``), so the copy promises exactly that and no more.
 * Reopening is the writer's own choice, made on purpose, which is what keeps
 * each an invitation rather than a nag. The morning-pages switch also clears
 * today's set-aside when turned on, so the tip is on the shelf when the
 * writer goes back to it, not only tomorrow.
 *
 * The link-a-habit note opens Settings with ``focus: 'writing-habit'``, which
 * opens the picker in place, whether this section is mounting for it or was
 * already on screen.
 *
 * While a link is known but its habit has not been read yet, the row says
 * "a habit" — never "not linked", which would tell a linked writer the opposite
 * of the truth — and the habits are read so the name can resolve.
 */
import { Bookmark, Link, NotebookPen, Sunrise, type LucideIcon } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  LINK_HABIT_NUDGE_SWITCH,
  MORNING_PAGES_SWITCH,
  WRITING_OFFER_SWITCH,
  type OfferSwitchStorage,
} from './journalOfferSwitches';
import { SettingsRow } from './shared/SettingsRow';
import { SettingsSwitchRow } from './shared/SettingsSwitchRow';
import { useOfferSwitch } from './useOfferSwitch';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { isHabitUnlocked } from '@/features/Habits/HabitUtils';
import { habitManager } from '@/features/Habits/services/habitManager';
import {
  MORNING_PAGES_SWITCH_DESCRIPTION,
  MORNING_PAGES_SWITCH_LABEL,
} from '@/features/Journal/morningPagesCopy';
import {
  JOURNAL_SETTINGS_TITLE,
  LINK_HABIT_NUDGE_SWITCH_DESCRIPTION,
  LINK_HABIT_NUDGE_SWITCH_LABEL,
  OFFER_SWITCH_DESCRIPTION,
  OFFER_SWITCH_LABEL,
  WRITING_TIMER_ROW_DESCRIPTION,
  WRITING_TIMER_ROW_LINKED_PENDING,
  writingTimerRowLabel,
} from '@/features/Journal/saveAsHabitCopy';
import WritingHabitPicker from '@/features/Journal/WritingHabitPicker';
import type { SettingsFocus } from '@/navigation/RootStack';
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

/**
 * The link, the picker's open state, and the moves that change them.
 * ``initiallyOpen`` opens the picker on mount, or whenever it turns true later.
 */
function useWritingHabitRow({ initiallyOpen }: { initiallyOpen: boolean }): {
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
  const [open, setOpen] = useState(initiallyOpen);
  const [busy, setBusy] = useState(false);
  const label = rowLabelFor(habitId, habits);
  const pending = label === WRITING_TIMER_ROW_LINKED_PENDING;

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);
  useEffect(() => {
    if (pending) loadHabitsQuietly(userTimezone);
  }, [pending, userTimezone]);
  // Read through a ref so a zone change (TimezoneSettings pushed over the hub,
  // or the server's zone adopted after a cold load) never re-runs the opening
  // below: only the focus turning on opens the picker, never a later render.
  const timezoneRef = useRef(userTimezone);
  timezoneRef.current = userTimezone;
  useEffect(() => {
    if (!initiallyOpen) return;
    setOpen(true);
    loadHabitsQuietly(timezoneRef.current);
  }, [initiallyOpen]);

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

interface OfferSwitchRowProps {
  icon: LucideIcon;
  label: string;
  description: string;
  storage: OfferSwitchStorage;
  testID: string;
}

/** One invitation's switch, driven from its device-kept flag. */
function OfferSwitchRow({ icon, label, description, storage, testID }: OfferSwitchRowProps) {
  const control = useOfferSwitch(storage);
  return (
    <SettingsSwitchRow
      icon={icon}
      label={label}
      description={description}
      value={control.value}
      disabled={control.busy}
      onValueChange={control.set}
      testID={testID}
    />
  );
}

/** The three invitations, each a switch over the flag the journal writes. */
function OfferSwitchRows(): React.JSX.Element {
  return (
    <>
      <OfferSwitchRow
        icon={Bookmark}
        label={OFFER_SWITCH_LABEL}
        description={OFFER_SWITCH_DESCRIPTION}
        storage={WRITING_OFFER_SWITCH}
        testID="settings-row-writing-offer"
      />
      <OfferSwitchRow
        icon={Sunrise}
        label={MORNING_PAGES_SWITCH_LABEL}
        description={MORNING_PAGES_SWITCH_DESCRIPTION}
        storage={MORNING_PAGES_SWITCH}
        testID="settings-row-morning-pages-offer"
      />
      <OfferSwitchRow
        icon={Link}
        label={LINK_HABIT_NUDGE_SWITCH_LABEL}
        description={LINK_HABIT_NUDGE_SWITCH_DESCRIPTION}
        storage={LINK_HABIT_NUDGE_SWITCH}
        testID="settings-row-link-habit-nudge"
      />
    </>
  );
}

export interface JournalSectionProps {
  /** The part of Settings it was opened on; ``'writing-habit'`` opens the picker. */
  focus?: SettingsFocus;
}

const JournalSection = ({ focus }: JournalSectionProps = {}): React.JSX.Element => {
  const row = useWritingHabitRow({ initiallyOpen: focus === 'writing-habit' });
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
      <OfferSwitchRows />
    </EditorialSection>
  );
};

export default JournalSection;
