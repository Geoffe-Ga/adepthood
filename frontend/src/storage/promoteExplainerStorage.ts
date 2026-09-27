// Persists the "I know what promoting a quote does" flag, so someone who has
// asked not to see the promote explainer again goes straight to choosing a
// passage.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { scopedKey } from './userScope';

/**
 * Namespaced per account, following the ``userScope`` convention for new
 * per-user flags.
 *
 * The explainer tells a reader what promotion is and where a promoted quote
 * goes. Whether they have read that is a fact about the person, not the
 * device: the next account on a shared phone has never been told, and an
 * inherited dismissal would leave them promoting passages with no idea where
 * they went. The flag is only read and written from the entry screen, which an
 * authenticated session alone can reach, so ``setActiveUser`` has already run
 * by the time either function is called.
 */
const PROMOTE_EXPLAINER_DISMISSED_KEY_BASE = '@adepthood/promote_explainer_dismissed';

const FLAG_TRUE = 'true';

/** This account's dismissal key. Resolved at call time, never frozen at import. */
function dismissedKey(): string {
  return scopedKey(PROMOTE_EXPLAINER_DISMISSED_KEY_BASE);
}

/** Record (or clear) this account's "don't show the promote note again" answer. */
export async function savePromoteExplainerDismissed(value: boolean): Promise<void> {
  await AsyncStorage.setItem(dismissedKey(), String(value));
}

/**
 * Whether this account has asked not to see the promote note again.
 *
 * A read failure resolves ``false``: showing the note once more costs a tap,
 * which is the cheaper way to be wrong.
 */
export async function loadPromoteExplainerDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(dismissedKey());
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[promoteExplainerStorage] failed to load the dismissal flag', err);
    return false;
  }
}
