// Persists the "I have read what a resonance pass costs" flag, so someone who
// has explicitly said they no longer need the spend disclosure stops being
// shown it before every pass.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { scopedKey } from './userScope';

/**
 * Namespaced per account, deliberately — this is the one dismissal flag in the
 * app that guards a charge.
 *
 * The sibling one-time flags (``morningPagesTipStorage``,
 * ``returnOfferStorage``) are unscoped, and for a writing tip that is fine: the
 * worst an inherited dismissal costs the next person on the device is a
 * suggestion they never saw. This flag suppresses the only screen that tells
 * someone a resonance pass spends one of their monthly BotMason messages — or
 * bills their own API key — so an inherited dismissal costs them money they
 * were never told about, and the money is charged to *their* allowance, not to
 * the account that ticked the box.
 *
 * That is exactly the leak ``userScope`` exists for (BUG-FE-STATE-001: a device
 * whose owner changes without an explicit logout), and it is not covered by the
 * other half of that fix — ``wipeUserState`` clears habits, the check-in queue,
 * the BYOK key and notifications, and no dismissal flag at all. Scoping is the
 * only thing standing between an owner change and an undisclosed charge, and it
 * costs one call: the flag is read and written from a screen that only an
 * authenticated session can reach, so ``setActiveUser`` has already run
 * (``AuthContext``'s ``adoptDeviceOwner`` on sign-in, ``scopeResumedSession`` on
 * cold start) by the time either function is called.
 */
const RESONANCE_EXPLAINER_DISMISSED_KEY_BASE = '@adepthood/resonance_explainer_dismissed';

const FLAG_TRUE = 'true';

/** This account's dismissal key. Resolved at call time, never frozen at import. */
function dismissedKey(): string {
  return scopedKey(RESONANCE_EXPLAINER_DISMISSED_KEY_BASE);
}

/** Record (or clear) this account's "don't show the cost note again" answer. */
export async function saveResonanceExplainerDismissed(value: boolean): Promise<void> {
  await AsyncStorage.setItem(dismissedKey(), String(value));
}

/**
 * Whether this account has asked not to see the cost note again.
 *
 * A read failure resolves ``false``: erring toward showing a disclosure costs a
 * tap, and erring the other way spends someone's money without telling them.
 */
export async function loadResonanceExplainerDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(dismissedKey());
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[resonanceExplainerStorage] failed to load the dismissal flag', err);
    return false;
  }
}
