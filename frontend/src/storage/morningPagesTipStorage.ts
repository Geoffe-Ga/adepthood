/**
 * Persists the writer's two ways of declining the morning-pages tip (#3005).
 *
 * - **Set aside for today**: the corner X stores the user-timezone day it was
 *   pressed on (``YYYY-MM-DD``), and the tip comes back on any other day.
 * - **Never offer**: the in-card "Don't show this again" link stores a
 *   permanent flag, which only the Settings → Journal "Offer morning pages"
 *   switch clears (and can set).
 *
 * Both live on THIS device (AsyncStorage), unscoped per account, exactly as
 * the single flag before them did. A read error fails open — the tip is an
 * invitation, so being offered it once too often beats losing it silently.
 *
 * The tip once had a single "set aside" flag that retired it for good
 * (``@adepthood/morning_pages_tip_dismissed``). A stored ``'true'`` there is
 * that writer's permanent decline, so the first read carries it over to the
 * never-offer flag — writing the new flag BEFORE removing the old one, so an
 * interruption between the two can never re-offer a tip someone turned down.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const LEGACY_DISMISSED_KEY = '@adepthood/morning_pages_tip_dismissed';
const SET_ASIDE_ON_KEY = '@adepthood/morning_pages_tip_set_aside_on';
const NEVER_OFFER_KEY = '@adepthood/morning_pages_tip_never_offer';
const FLAG_TRUE = 'true';
const FLAG_FALSE = 'false';

/** What the tip needs to decide whether it is offered today. */
export interface MorningPagesTipState {
  /** The user-timezone ``YYYY-MM-DD`` the tip was last set aside on, if ever. */
  setAsideOn: string | null;
  /** True once the writer asked never to be offered it again. */
  neverOffer: boolean;
}

/** Nothing declined: the tip is offered. Also what a failed read falls back to. */
export const MORNING_PAGES_TIP_OPEN: MorningPagesTipState = Object.freeze({
  setAsideOn: null,
  neverOffer: false,
});

/** Carry a legacy permanent decline over to the never-offer flag, once. */
async function migrateLegacyDismissal(): Promise<void> {
  const legacy = await AsyncStorage.getItem(LEGACY_DISMISSED_KEY);
  if (legacy !== FLAG_TRUE) return;
  await AsyncStorage.setItem(NEVER_OFFER_KEY, FLAG_TRUE);
  await AsyncStorage.removeItem(LEGACY_DISMISSED_KEY);
}

export async function loadMorningPagesTipState(): Promise<MorningPagesTipState> {
  try {
    await migrateLegacyDismissal();
    const setAsideOn = await AsyncStorage.getItem(SET_ASIDE_ON_KEY);
    const neverOffer = await AsyncStorage.getItem(NEVER_OFFER_KEY);
    return { setAsideOn, neverOffer: neverOffer === FLAG_TRUE };
  } catch (err) {
    console.warn('[morningPagesTipStorage] failed to load dismissal state', err);
    return { ...MORNING_PAGES_TIP_OPEN };
  }
}

/**
 * Write one declining answer. Never rejects: callers fire it and forget (the
 * answer is already held in memory), so a failed write (quota exceeded,
 * storage blocked) is reported here rather than escaping as an unhandled
 * rejection. The tip is simply offered again on the next read. Resolves
 * whether it was saved, for the one caller that shows the answer back (the
 * Settings switch) and must not show a decline that did not land.
 */
async function saveDecline(key: string, value: string): Promise<boolean> {
  try {
    await AsyncStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.warn('[morningPagesTipStorage] failed to save dismissal state', err);
    return false;
  }
}

/** The corner X: set the tip aside for ``day`` (the writer's today) only. */
export async function saveMorningPagesTipSetAside(day: string): Promise<void> {
  await saveDecline(SET_ASIDE_ON_KEY, day);
}

/** "Don't show this again" (true), or its undoing (false). Resolves whether it saved. */
export async function saveMorningPagesTipNeverOffer(value: boolean): Promise<boolean> {
  return saveDecline(NEVER_OFFER_KEY, value ? FLAG_TRUE : FLAG_FALSE);
}

/**
 * Settings → the "Offer morning pages" switch, turned on: clears the permanent
 * decline AND today's set-aside, so the tip is on the shelf now rather than
 * tomorrow.
 *
 * It also drops any legacy flag the shelf has not migrated yet, and drops it
 * FIRST: if the flag outlived the new write, the next shelf read would carry
 * that old decline over and silently undo the restore. Removing it first means
 * an interruption at any point leaves either the old decline or the restore,
 * never a restore that a later read reverses. Resolves whether it was saved
 * (never rejects), so Settings only says the tip is back when it is.
 */
export async function restoreMorningPagesTip(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(LEGACY_DISMISSED_KEY);
    await AsyncStorage.setItem(NEVER_OFFER_KEY, FLAG_FALSE);
    await AsyncStorage.removeItem(SET_ASIDE_ON_KEY);
    return true;
  } catch (err) {
    console.warn('[morningPagesTipStorage] failed to restore the tip', err);
    return false;
  }
}
