// Persists "the offer made in the finished-writing note has been answered", so
// it is made once and then let go.
//
// ONE flag for every answer, on purpose. The note offers two ways to keep the
// session — as a habit, or as a practice — under a single decline, so a single
// flag is what "the writer has answered" means. A decline must be honoured for
// good, that being the explicit ask; and an acceptance must be too, for a
// plainer reason: whichever thing they kept now exists, so offering again would
// both nag and, if taken up, file a second one beside the first. Either way the
// writer has said what they wanted, and the page has nothing left to ask.
//
// The stored KEY keeps its original ``writing_habit_offer_answered`` name even
// though the offer widened past habits. Renaming it would re-ask every writer
// who has already answered — the one thing this module exists to prevent.
//
// The offer is still a one-time invitation, not a standing menu: nothing brings
// it back on its own. But the writer can (#2861): Settings → Journal → "Offer
// again at the end of a session" calls ``saveWritingOfferAnswered(false)``, so a
// "No thanks" said in the moment is not a door closed for good. That reopening
// is the writer's own choice, made on purpose, which is what keeps it an
// invitation rather than pressure. It is also device-local, like the flag
// itself, and the Settings copy says "on this device" rather than promising
// more. (Whether the account already has a habit LINKED to the timer is the
// server's to say, on ``/ui-flags`` — the offer checks that separately.)
//
// A read failure resolves ``false`` — the offer appears — rather than
// suppressing it: a flaky disk should not silently withhold something the
// person has not been asked about yet. One extra offer after a read blip is a
// smaller harm than never offering again.
import AsyncStorage from '@react-native-async-storage/async-storage';

const WRITING_OFFER_ANSWERED_KEY = '@adepthood/writing_habit_offer_answered';
const FLAG_TRUE = 'true';

/** Record (or clear) that the offer has been answered, either way. */
export async function saveWritingOfferAnswered(value: boolean): Promise<void> {
  await AsyncStorage.setItem(WRITING_OFFER_ANSWERED_KEY, String(value));
}

/** Whether this person has already answered the offer, by declining or keeping it. */
export async function loadWritingOfferAnswered(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(WRITING_OFFER_ANSWERED_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[writingOfferStorage] failed to load the answered flag', err);
    return false;
  }
}
