/**
 * ``useOpenLetterOnArrival`` — a letter quote's Open (#3659).
 *
 * The Promoted quotes screen opens a quote lifted from a Resonance Letter on
 * the page whose margin note the letter belongs to, naming that note as
 * ``openLetterFor``. The page's notes load after it does, so this waits for
 * them and opens the note's letter once it is among them -- the same
 * ``onOpenNote`` a tap on the note in the margin calls. A note that never
 * arrives (since dismissed or deleted) opens nothing: the page is still the
 * page the letter answered.
 */
import { useEffect, useRef } from 'react';

import type { Marginalia } from '@/api';
import type { RootStackParamList } from '@/navigation/RootStack';

export function useOpenLetterOnArrival(
  params: RootStackParamList['JournalEntry'],
  notes: readonly Marginalia[],
  openNote: (_note: Marginalia) => void,
): void {
  const noteId = params?.openLetterFor;
  // Once per note: the request stays on the route after the reader closes the
  // letter, and a later refresh of the notes must not open it again.
  const openedFor = useRef<number | null>(null);
  useEffect(() => {
    if (noteId === undefined || openedFor.current === noteId) return;
    const note = notes.find((candidate) => candidate.id === noteId);
    if (note === undefined) return;
    openedFor.current = noteId;
    openNote(note);
  }, [noteId, notes, openNote]);
}
