/**
 * What each seeding outcome says out loud.
 *
 * Every line names what happened and the one thing the person can do next, and
 * no two outcomes share a sentence — a vault that cannot take files yet reads
 * as exactly that, not as an error, because the remedy is different and so is
 * the feeling. Nothing here congratulates or nudges: the corpus is theirs, and
 * adding to it is an invitation they already accepted.
 *
 * **Each line names the place the document actually reached.** A document goes
 * to the vault or to this account's own ontologized corpus, the server decides
 * which, and the two are different places with different guarantees. Telling
 * somebody "in your vault" about writing that is in the corpus — or the reverse
 * — would be the one sentence on this screen nobody could check.
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
  in_corpus: 'In your corpus. It will show up in reflections from here on.',
  // The ordinary first answer rather than an error state: the corpus is off
  // until somebody turns it on. It names the setting rather than the endpoint,
  // and the screen offers the way there beneath the list.
  consent_required:
    'Nothing was imported. Documents are only added to your corpus once you turn that on, and ' +
    "you haven't yet.",
  // The asymmetry, said plainly and without blaming the file. Placing writing
  // among the frequencies means showing it to a language model, which is
  // exactly what the Intimate tier exists to refuse.
  tier_refused:
    'Marked Intimate, so it stayed on this device and nothing was stored. Placing a document ' +
    'among the frequencies means reading it with a language model, and Intimate writing never ' +
    'goes to one. Choose another tier if you want this in your corpus.',
  format_unreadable:
    "Adepthood can't open this kind of file on its own, so nothing was stored. It reads " +
    'Markdown and plain text — most apps, including Claude and ChatGPT, can export as ' +
    'Markdown. A connected vault reads richer formats for you.',
  not_text:
    "This file is named as text but isn't readable as text. Re-export it as UTF-8 and send it " +
    'again.',
  empty_document: "There's no writing in this document, so there was nothing to store.",
  document_too_long:
    'Longer than one corpus entry can hold, so nothing was stored. Split it into shorter ' +
    'pieces and send those.',
  // Not a failure of the document and not phrased as one. Writing that sits at
  // no position on the ontology could only ever be retrieved by recency, which
  // is the thing the corpus replaced.
  unclassified:
    "Adepthood couldn't place this among the frequencies, so it wasn't added — a corpus entry " +
    'has to sit somewhere on the map to be found again. Nothing changed, and you can try again.',
  // Decided on device, so it names neither destination: this extension is
  // outside everything either side could read, and it was never sent.
  unsupported_format: 'Nothing here reads this kind of file, so it was never sent.',
  too_large: `Larger than ${MAX_SEED_DOCUMENT_LABEL}, which is as much as one document can carry.`,
  unreadable: "This file wouldn't open on this device.",
  failed: "This didn't get through, and nothing was stored. You can send it again.",
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

/** Said beneath the list when a document is waiting on a permission. */
export const SEED_CONSENT_PROMPT =
  'Adepthood only adds documents to your corpus once you turn that on. Nothing was stored, and ' +
  'the documents are still on your device — turn on "Documents you bring in", then send them ' +
  'again.';

/** What the way there is called. */
export const SEED_CONSENT_LINK_LABEL = 'Open your corpus settings';

/**
 * The one-line state of the run: how far along it is while documents are still
 * going over, and what landed once they have all settled. Null before the first
 * pick, when there is nothing honest to say.
 *
 * Deliberately says "landed" rather than naming a destination. A single pick
 * can only reach one destination, but which one is the server's answer per
 * request, and a summary that named one would be a claim this line cannot
 * check. The per-document row is where the place is named.
 */
export function seedSummaryLine(tally: SeedRunTally): string | null {
  if (tally.total === 0) {
    return null;
  }
  if (tally.waiting > 0) {
    return `${tally.landed} of ${tally.total} have landed so far.`;
  }
  if (tally.refused === 0) {
    return `All ${tally.total} have landed.`;
  }
  return `${tally.landed} of ${tally.total} landed. ${tally.refused} didn't go over.`;
}
