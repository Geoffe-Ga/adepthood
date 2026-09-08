// Persists "the offer to keep a timed writing session as a habit has been
// answered", so it is made once and then let go.
//
// One flag for both answers on purpose. A decline must be honoured for good —
// that is the explicit ask — and an acceptance must be too, for a plainer
// reason: the habit now exists, so offering again would both nag and, if taken
// up, file a second Journaling habit beside the first. Either way the writer
// has said what they wanted, and the page has nothing left to ask.
//
// The cost, accepted knowingly: a writer who keeps the habit and later deletes
// it is not offered it again. That is the same shape as the decline — the offer
// is a one-time invitation, not a standing menu — and the habits screen is
// where a habit is added on purpose.
//
// A read failure resolves ``false`` — the offer appears — rather than
// suppressing it: a flaky disk should not silently withhold something the
// person has not been asked about yet. One extra offer after a read blip is a
// smaller harm than never offering again.
import AsyncStorage from '@react-native-async-storage/async-storage';

const WRITING_HABIT_OFFER_ANSWERED_KEY = '@adepthood/writing_habit_offer_answered';
const FLAG_TRUE = 'true';

/** Record (or clear) that the offer has been answered, either way. */
export async function saveWritingHabitOfferAnswered(value: boolean): Promise<void> {
  await AsyncStorage.setItem(WRITING_HABIT_OFFER_ANSWERED_KEY, String(value));
}

/** Whether this person has already answered the offer, by declining or keeping it. */
export async function loadWritingHabitOfferAnswered(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(WRITING_HABIT_OFFER_ANSWERED_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[writingHabitOfferStorage] failed to load the answered flag', err);
    return false;
  }
}
