import { useCallback, useState } from 'react';

import type { Habit, HabitScreenMode } from '../Habits.types';

/** Toast dismissal delay for the archive-CTA acknowledgement message. */
const ARCHIVE_MESSAGE_DURATION_MS = 3000;

export interface HabitUIState {
  selectedHabit: Habit | null;
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
 * Local UI state for the Habits screen — selection, current mode, emoji
 * picker target, and the energy-scaffolding CTA lifecycle. Everything here
 * is component-local; no global store involvement.
 */
export const useHabitUI = (): HabitUIState => {
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null);
  const [mode, setMode] = useState<HabitScreenMode>('normal');
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);
  const [showEnergyCTA, setShowEnergyCTA] = useState(true);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);

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
