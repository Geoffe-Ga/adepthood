import { useCallback, useState } from 'react';

import { selectHabitById, useHabitStore } from '../../../store/useHabitStore';
import type { Habit, HabitScreenMode } from '../Habits.types';

/** Toast dismissal delay for the archive-CTA acknowledgement message. */
const ARCHIVE_MESSAGE_DURATION_MS = 3000;

export interface HabitUIState {
  /** Currently selected habit, derived from the store by ID. */
  selectedHabit: Habit | null;
  /** Pass the full habit or null; only the ID is stored in local state. */
  setSelectedHabit: (_habit: Habit | null) => void;
  mode: HabitScreenMode;
  setMode: (_mode: HabitScreenMode) => void;
  emojiHabitIndex: number | null;
  setEmojiHabitIndex: (_index: number | null) => void;
  showEnergyCTA: boolean;
  showArchiveMessage: boolean;
  archiveEnergyCTA: () => void;
}

/**
 * Transient UI state for the Habits screen — the selected-habit ID, current
 * mode, emoji picker target, and the energy-scaffolding CTA lifecycle.
 *
 * Domain data (the actual habit objects) lives in the Zustand store. We store
 * only `selectedHabitId` here; the habit is resolved via a selector so that
 * updates to the store propagate automatically — no stale closures.
 */
export const useHabitUI = (): HabitUIState => {
  const [selectedHabitId, setSelectedHabitId] = useState<number | null>(null);
  const selectedHabit = useHabitStore(selectHabitById(selectedHabitId)) ?? null;
  const [mode, setMode] = useState<HabitScreenMode>('normal');
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);
  const [showEnergyCTA, setShowEnergyCTA] = useState(true);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);

  const setSelectedHabit = useCallback((habit: Habit | null) => {
    setSelectedHabitId(habit?.id ?? null);
  }, []);

  const archiveEnergyCTA = useCallback(() => {
    setShowEnergyCTA(false);
    setShowArchiveMessage(true);
    setTimeout(() => setShowArchiveMessage(false), ARCHIVE_MESSAGE_DURATION_MS);
  }, []);

  return {
    selectedHabit,
    setSelectedHabit,
    mode,
    setMode,
    emojiHabitIndex,
    setEmojiHabitIndex,
    showEnergyCTA,
    showArchiveMessage,
    archiveEnergyCTA,
  };
};
