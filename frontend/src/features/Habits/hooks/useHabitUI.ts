import { useCallback, useEffect, useState } from 'react';

import {
  loadEnergyScaffoldingArchived,
  saveEnergyScaffoldingArchived,
} from '../../../storage/energyScaffoldingStorage';
import { selectHabitById, useHabitStore } from '../../../store/useHabitStore';
import type { Habit, HabitScreenMode } from '../Habits.types';

import { uiFlags } from '@/api';

/** Toast dismissal delay for the archive-CTA acknowledgement message. */
const ARCHIVE_MESSAGE_DURATION_MS = 3000;

// Server is source of truth after login (account-scoped ``GET /ui-flags``); the
// local cache is only an offline fallback when the GET rejects. Kept flat to
// stay well under the cognitive-complexity budget.
async function resolveEnergyArchived(token?: string): Promise<boolean> {
  try {
    const flags = await uiFlags.get(token);
    return flags.energy_scaffolding_archived;
  } catch {
    return loadEnergyScaffoldingArchived();
  }
}

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
export const useHabitUI = (token?: string | null): HabitUIState => {
  const normalizedToken = token ?? undefined;
  const [selectedHabitId, setSelectedHabitId] = useState<number | null>(null);
  const selectedHabit = useHabitStore(selectHabitById(selectedHabitId)) ?? null;
  const [mode, setMode] = useState<HabitScreenMode>('normal');
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);
  // Start hidden so a previously-archived CTA never flashes before the async
  // read resolves; the effect reveals it only when it isn't archived.
  const [showEnergyCTA, setShowEnergyCTA] = useState(false);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveEnergyArchived(normalizedToken)
      .then((archived) => {
        if (cancelled) return;
        setShowEnergyCTA(!archived);
        // Re-seed the offline cache so it matches the server-resolved value.
        saveEnergyScaffoldingArchived(archived).catch(console.warn);
      })
      .catch((err: unknown) => {
        console.warn('[useHabitUI] failed to load energy-CTA archived state', err);
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedToken]);

  const setSelectedHabit = useCallback((habit: Habit | null) => {
    setSelectedHabitId(habit?.id ?? null);
  }, []);

  const archiveEnergyCTA = useCallback(() => {
    setShowEnergyCTA(false);
    setShowArchiveMessage(true);
    setTimeout(() => setShowArchiveMessage(false), ARCHIVE_MESSAGE_DURATION_MS);
    saveEnergyScaffoldingArchived(true).catch((err: unknown) => {
      console.warn('[useHabitUI] failed to persist energy-CTA archived state', err);
    });
    uiFlags.update({ energy_scaffolding_archived: true }, normalizedToken).catch((err: unknown) => {
      console.warn('[useHabitUI] failed to sync energy-CTA archived state', err);
    });
  }, [normalizedToken]);

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
