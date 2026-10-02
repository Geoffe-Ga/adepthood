/**
 * The three device-kept "offer it or not" flags behind Settings → Journal, each
 * read as a switch: ``read`` answers whether the thing is currently offered,
 * ``write`` sets that and resolves whether the write landed.
 *
 * Each is stored the other way up (as a decline or an answer), because the
 * journal records the writer's "No thanks" or "Don't show again" and the
 * switch is the same fact seen from Settings. The inversion lives here, once,
 * so the section itself only ever thinks in "offered" and the switch cannot
 * show a decline that did not save.
 */
import {
  loadLinkHabitNudgeDeclined,
  restoreLinkHabitNudge,
  saveLinkHabitNudgeDeclined,
} from '@/storage/linkHabitNudgeStorage';
import {
  loadMorningPagesTipState,
  restoreMorningPagesTip,
  saveMorningPagesTipNeverOffer,
} from '@/storage/morningPagesTipStorage';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '@/storage/writingOfferStorage';

/** A device-kept flag, as a switch sees it: offered or not. */
export interface OfferSwitchStorage {
  /** Whether the thing is currently offered on this device. */
  read: () => Promise<boolean>;
  /** Offer it (true) or stop (false); resolves whether the write landed. */
  write: (_offered: boolean) => Promise<boolean>;
}

/** The end-of-session keep-this offer: stored as "answered", shown as "offered". */
export const WRITING_OFFER_SWITCH: OfferSwitchStorage = {
  read: async () => !(await loadWritingOfferAnswered()),
  write: async (offered) => {
    try {
      await saveWritingOfferAnswered(!offered);
      return true;
    } catch (err) {
      console.warn('[journalOfferSwitches] failed to save the offer answer', err);
      return false;
    }
  },
};

/**
 * The shelf's morning-pages tip: stored as "never offer", shown as "offered".
 * Turning it on restores today's set-aside too, so the tip is on the shelf
 * when the writer goes back, not only tomorrow.
 */
export const MORNING_PAGES_SWITCH: OfferSwitchStorage = {
  read: async () => !(await loadMorningPagesTipState()).neverOffer,
  write: (offered) => (offered ? restoreMorningPagesTip() : saveMorningPagesTipNeverOffer(true)),
};

/** The link-a-habit note after a session: stored as "declined", shown as "offered". */
export const LINK_HABIT_NUDGE_SWITCH: OfferSwitchStorage = {
  read: async () => !(await loadLinkHabitNudgeDeclined()),
  write: (offered) => (offered ? restoreLinkHabitNudge() : saveLinkHabitNudgeDeclined()),
};
