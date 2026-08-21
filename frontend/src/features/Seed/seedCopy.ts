/**
 * What each seeding outcome says out loud.
 *
 * Every line names what happened and the one thing the person can do next, and
 * no two outcomes share a sentence — a vault that cannot take files yet reads
 * as exactly that, not as an error, because the remedy is different and so is
 * the feeling. Nothing here congratulates or nudges: the corpus is theirs, and
 * adding to it is an invitation they already accepted.
 */
import { MAX_SEED_DOCUMENT_LABEL } from './readSeedDocument';
import type { SeedItemStatus, SeedRunTally } from './seedRun';

/** The line shown beneath each document's name, keyed by where it got to. */
export const SEED_STATUS_LINES: Record<SeedItemStatus, string> = {
  queued: 'Waiting its turn.',
  uploading: 'Going over now…',
  ingested: 'In your vault. It will show up in reflections from here on.',
  vault_unavailable: "Your vault didn't answer. Check that it's running, then send this again.",
  // One status, three causes: a vault without uploads, a vault whose version
  // this app cannot negotiate with, and a document marked Intimate, which has no
  // spelling on the vault wire at all. Nothing here can tell which, and the
  // backend answers a single status for all three — so the tier goes first,
  // because it is the only one of the three with a remedy the person holding the
  // file controls. Naming only the vault would send someone to update software
  // that may already be current, or leave someone re-sending a tier that can
  // never go.
  capability_unsupported:
    'Marked Intimate? That tier stays on this device — pick another one if you want this ' +
    "in your vault. Otherwise uploads aren't working between Adepthood and your vault yet; " +
    'keep this one, it can go over once either side has caught up.',
  degraded: "This didn't finish, and nothing in your vault changed. You can send it again.",
  unsupported_format: 'Your vault has no reader for this kind of file yet.',
  too_large: `Larger than ${MAX_SEED_DOCUMENT_LABEL}, which is as much as one document can carry.`,
  unreadable: "This file wouldn't open on this device.",
  failed: "This didn't reach your vault. You can send it again whenever you like.",
};

/** The invitation on the empty screen, before anything has been chosen. */
export const SEED_EMPTY_INVITATION =
  'Whatever you have already written elsewhere can live here too — notes, exports, ' +
  'documents, a folder of markdown. Bring as much or as little as you like.';

/** What the picker button offers. */
export const SEED_CHOOSE_LABEL = 'Choose files';

/** Said when the person closes the picker without choosing anything. */
export const SEED_CANCELLED_NOTICE = 'Nothing chosen — the picker is there whenever you want it.';

/** Said when a pick returns nothing this device can open. */
export const SEED_FAILED_PICK_NOTICE = "Nothing came back from the picker. It's fine to try again.";

/**
 * The one-line state of the run: how far along it is while documents are still
 * going over, and what landed once they have all settled. Null before the first
 * pick, when there is nothing honest to say.
 */
export function seedSummaryLine(tally: SeedRunTally): string | null {
  if (tally.total === 0) {
    return null;
  }
  if (tally.waiting > 0) {
    return `${tally.ingested} of ${tally.total} in your vault so far.`;
  }
  if (tally.refused === 0) {
    return `All ${tally.total} are in your vault.`;
  }
  return `${tally.ingested} of ${tally.total} are in your vault. ${tally.refused} didn't go over.`;
}
