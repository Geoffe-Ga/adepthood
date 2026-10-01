/**
 * ``useHabitLinkRow`` — the state behind a Settings row that names which habit
 * a kind of session checks off, and opens a picker to change it.
 *
 * Shared by the Journal group (the writing timer, #2861) and the Practice
 * group (practice sessions), which differ only in the store they mirror and
 * the words on the row. The link lives on the server (``/ui-flags``), so the
 * row reads the same on every device.
 *
 * While a link is known but its habit has not been read yet, the row says
 * "a habit" (``pendingLabel``) — never "not linked", which would tell a linked
 * person the opposite of the truth — and the habits are read so the name can
 * resolve. A linked habit that is locked is ``paused``: nothing is logged
 * against a locked habit, so the row says so rather than implying the session
 * is still checking it off.
 */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { isHabitUnlocked } from '@/features/Habits/HabitUtils';
import { habitManager } from '@/features/Habits/services/habitManager';
import type { HabitLinkStore } from '@/store/createHabitLinkStore';
import { useHabitStore } from '@/store/useHabitStore';

export interface HabitLinkRowWords {
  /** The row's label for a link whose habit has not been read yet. */
  pendingLabel: string;
  /** The row's label for a resolved link (``null`` for none), paused when locked. */
  rowLabel: (_habitName: string | null, _options: { paused: boolean }) => string;
  /** Who is asking, for the warning line when the habits cannot be read. */
  logTag: string;
}

export interface HabitLinkRow {
  label: string;
  habits: readonly Habit[];
  linked: boolean;
  open: boolean;
  busy: boolean;
  toggle: () => void;
  close: () => void;
  save: (_habitId: number | null) => void;
}

/** The row's words for a link: none, a named habit, or one not read yet. */
function rowLabelFor(
  habitId: number | null,
  habits: readonly Habit[],
  words: HabitLinkRowWords,
): string {
  if (habitId === null) return words.rowLabel(null, { paused: false });
  const linked = habits.find((habit) => habit.id === habitId);
  if (!linked) return words.pendingLabel;
  return words.rowLabel(linked.name, { paused: !isHabitUnlocked(linked) });
}

/** Read the habits quietly: a failure leaves the pending label, never an error. */
function loadHabitsQuietly(tz: string, logTag: string): void {
  habitManager.loadHabits(tz).catch((err: unknown) => {
    console.warn(`[${logTag}] failed to read habits`, err);
  });
}

/** The link, the picker's open state, and the moves that change them. */
export function useHabitLinkRow(store: HabitLinkStore, words: HabitLinkRowWords): HabitLinkRow {
  const { token, userTimezone } = useAuth();
  const habits = useHabitStore((state) => state.habits);
  const habitId = store((state) => state.habitId);
  const hydrate = store((state) => state.hydrate);
  const setLink = store((state) => state.setLink);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = rowLabelFor(habitId, habits, words);
  const pending = label === words.pendingLabel;
  const { logTag } = words;

  useEffect(() => {
    void hydrate(token ?? undefined);
  }, [hydrate, token]);
  useEffect(() => {
    if (pending) loadHabitsQuietly(userTimezone, logTag);
  }, [logTag, pending, userTimezone]);

  const toggle = useCallback(() => {
    if (!open) loadHabitsQuietly(userTimezone, logTag);
    setOpen(!open);
  }, [logTag, open, userTimezone]);
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
