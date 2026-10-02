/**
 * Persists the writer's "Don't show again" on the link-a-habit note (#3006).
 *
 * The note appears in a finished writing session when no habit is linked to
 * the timer, and points to Settings → Journal, where one can be chosen. It is
 * a pointer, not a question, so it keeps appearing until the writer either
 * links a habit (the server's ``/ui-flags`` answer, checked by the note) or
 * asks it to stop — which is this flag. Settings → Journal → the "Show the
 * habit note" switch clears it, and can set it too.
 *
 * Device-local (AsyncStorage), like the end-of-session offer's flag beside it,
 * and modelled on ``morningPagesTipStorage``: a read error fails open (the note
 * is an invitation, so one extra showing beats losing it silently), a failed
 * write is reported here rather than rejecting, and the restore resolves
 * whether it saved so Settings only says the note is back when it is.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const LINK_HABIT_NUDGE_NEVER_OFFER_KEY = '@adepthood/link_habit_nudge_never_offer';
const FLAG_TRUE = 'true';
const FLAG_FALSE = 'false';

/** Whether the writer has asked never to see the note again on this device. */
export async function loadLinkHabitNudgeDeclined(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LINK_HABIT_NUDGE_NEVER_OFFER_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[linkHabitNudgeStorage] failed to load the decline', err);
    return false;
  }
}

/**
 * "Don't show again". Never rejects: the note is already hidden in memory and
 * the caller fires this and forgets, so a failed write (quota exceeded,
 * storage blocked) is reported here and the note simply returns next session.
 * Resolves whether it was saved, for the Settings switch that also turns the
 * note off and must not show it off when it is not.
 */
export async function saveLinkHabitNudgeDeclined(): Promise<boolean> {
  try {
    await AsyncStorage.setItem(LINK_HABIT_NUDGE_NEVER_OFFER_KEY, FLAG_TRUE);
    return true;
  } catch (err) {
    console.warn('[linkHabitNudgeStorage] failed to save the decline', err);
    return false;
  }
}

/** Settings → the "Show the habit note" switch, turned on. Resolves whether it was saved. */
export async function restoreLinkHabitNudge(): Promise<boolean> {
  try {
    await AsyncStorage.setItem(LINK_HABIT_NUDGE_NEVER_OFFER_KEY, FLAG_FALSE);
    return true;
  } catch (err) {
    console.warn('[linkHabitNudgeStorage] failed to restore the note', err);
    return false;
  }
}
