// Persists the "the Return offer was set aside" flag so a decline is honoured
// across launches — the offer stays quiet until the person chooses otherwise.
import AsyncStorage from '@react-native-async-storage/async-storage';

const RETURN_OFFER_DISMISSED_KEY = '@adepthood/return_offer_dismissed';
const FLAG_TRUE = 'true';

export async function saveReturnOfferDismissed(): Promise<void> {
  await AsyncStorage.setItem(RETURN_OFFER_DISMISSED_KEY, FLAG_TRUE);
}

export async function loadReturnOfferDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(RETURN_OFFER_DISMISSED_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[returnOfferStorage] failed to load dismissal flag', err);
    return false;
  }
}
