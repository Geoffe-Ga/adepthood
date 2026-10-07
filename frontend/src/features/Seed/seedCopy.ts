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
 * to the account's vault, or — since #3016, for an account the server finds no
 * vault for — nowhere at all, and the server decides which. The corpus lines
 * below the vault's are the server's other vocabulary; telling somebody "in
 * your vault" about writing that is not there would be the one sentence on this
 * screen nobody could check.
 */
import { MAX_SEED_DOCUMENT_LABEL } from './readSeedDocument';
import type { SeedItemStatus, SeedRunTally } from './seedRun';

import type { CorpusDestination } from '@/features/Journal/corpusDestination';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';

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
    'Marked Intimate? That stays on this device — pick a different privacy level if you want ' +
    "this in your vault. Otherwise Adepthood can't send to your vault just yet; keep this one " +
    'and try again later.',
  degraded: "This didn't finish, and nothing in your vault changed. You can send it again.",
  in_corpus: 'Kept with the rest of your writing. It will show up in reflections from here on.',
  // The ordinary first answer rather than an error state: the corpus is off
  // until somebody turns it on. It names the setting rather than the endpoint,
  // and the screen offers the way there beneath the list.
  consent_required:
    'Nothing was added. Documents only join your writing once you turn that on, and ' +
    "you haven't yet.",
  // The asymmetry, said plainly and without blaming the file. Placing writing
  // among the frequencies means showing it to a language model, which is
  // exactly what the Intimate tier exists to refuse.
  tier_refused:
    'Marked Intimate, so it stayed on this device and nothing was stored. Placing a document ' +
    'among the frequencies means an AI reads it, and Intimate writing never goes to one. ' +
    'Choose a different privacy level if you want this kept with your writing.',
  format_unreadable:
    "Adepthood can't open this kind of file on its own, so nothing was stored. It reads " +
    'Markdown and plain text — most apps, including Claude and ChatGPT, can export as ' +
    'Markdown. A connected vault reads richer formats for you.',
  not_text:
    "This file is named as text but can't be read as text. Save a plain-text copy from the " +
    'app it came from and send that instead.',
  empty_document: "There's no writing in this document, so there was nothing to store.",
  document_too_long:
    'Too long to keep as one piece, so nothing was stored. Split it into shorter ' +
    'pieces and send those.',
  // Not a failure of the document and not phrased as one. Writing that sits at
  // no position on the ontology could only ever be retrieved by recency, which
  // is the thing the corpus replaced.
  unclassified:
    "Adepthood couldn't place this among the frequencies, so it wasn't added — a piece of " +
    'writing has to sit somewhere on the map to be found again. Nothing changed, and you can ' +
    'try again.',
  // The one answer the server gives an account it finds no vault for (#3016).
  // Worded to stay true for each such account: one that never set a vault up,
  // one whose vault is still being prepared, one whose vault could not be
  // reached at the address on record. So it offers "set it up or check on it",
  // never "set one up" alone, and says "for this account" rather than "you
  // have none". It names the Settings row rather than a vault, because the
  // corpus lines are held to never naming one.
  vault_required:
    'Nothing was stored. Documents you bring in are kept with the rest of your writing, and ' +
    `that place isn't ready yet. Open ${VAULT_ROW_LABEL} in Settings to set it up ` +
    'or check on it, then send this again.',
  // Decided on device, so it names neither destination: this extension is
  // outside everything either side could read, and it was never sent.
  unsupported_format: 'Nothing here reads this kind of file, so it was never sent.',
  too_large: `Larger than ${MAX_SEED_DOCUMENT_LABEL}, which is as much as one document can carry.`,
  unreadable: "This file wouldn't open on this device.",
  failed: "This didn't get through, and nothing was stored. You can send it again.",
  // Not a refusal by anything. The run was stopped while this one was still
  // waiting its turn, so it was never sent and nothing anywhere changed.
  cancelled:
    'The run stopped while this one was still waiting, so it was never sent and nothing about ' +
    'it changed. Choose it again whenever you like.',
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
  'Adepthood only keeps documents with your writing once you turn that on. Nothing was ' +
  'stored, and the documents are still on your device — turn on "Documents you bring in", ' +
  'then send them again.';

/** What the way there is called. */
export const SEED_CONSENT_LINK_LABEL = 'Open that setting';

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

/**
 * How far along a run is while documents are still going over. Null once
 * nothing is waiting, because a finished run has {@link seedSummaryLine} to
 * say what became of it.
 *
 * The position counts the whole run rather than the latest pick: a second pick
 * appends to the same list, and a number that restarted while the list did not
 * would be a count of something nobody can see. Says "sending" and names no
 * destination — which of the two answered is the server's word per request.
 */
export function seedProgressLine(tally: SeedRunTally): string | null {
  if (tally.waiting === 0) {
    return null;
  }
  const settled = tally.total - tally.waiting;
  return `Sending ${settled + 1} of ${tally.total}…`;
}

/** What the question about leaving a run in flight is called. */
export const SEED_LEAVE_TITLE = 'Documents are still going over';

/**
 * The whole of what leaving costs, said before it is paid.
 *
 * Names what is happening, why leaving matters, what becomes of each half of
 * the run, and both ways out — because the one thing this screen must never do
 * is let the person believe a run was abandoned while documents kept arriving
 * in their corpus.
 */
export const SEED_LEAVE_WARNING =
  'Some of these documents are still going over. The one already on its way has left this ' +
  'device and will finish wherever it lands; everything still waiting is never sent, and those ' +
  'files stay on your device exactly as they are. Stay to let the rest go over, or leave and ' +
  'choose them again another time.';

/** The way out that stops the run. */
export const SEED_LEAVE_CONFIRM_LABEL = 'Leave and stop sending';

/** The way out that is no exit at all. */
export const SEED_LEAVE_STAY_LABEL = 'Stay while the rest go over';

/**
 * The same warning in the one line a browser will take.
 *
 * A page reload never reaches the navigator, so on the web this is the only
 * warning there is. Browsers have shown their own wording since 2016 and
 * ignore this text; it is set because the API is what arms the prompt, and
 * kept truthful because nothing is served by a string that lies where it does
 * happen to show.
 */
export const SEED_LEAVE_BROWSER_WARNING =
  'Documents are still going over. Leaving now stops the run, and everything still waiting is ' +
  'never sent.';

// ---------------------------------------------------------------------------
// The way in, when there is nowhere to keep a document yet (#3017)
// ---------------------------------------------------------------------------
//
// A corpus lives in a vault (#3015), so "Bring in your writing" is offered to
// an account with nowhere to keep a document as an invitation to give its
// corpus a place first -- never hidden, never disabled, and never a task. These
// lines are shown only when the server has said nothing is attached; an
// account whose vault state is unknown gets the picker and the ordinary lines.

/** The Settings row that opens the seeding screen, named as it always was. */
export const SEED_ROW_LABEL = 'Bring in your writing';

/** What that row says when there is a place to keep what comes in, or nobody knows. */
export const SEED_ROW_DESCRIPTION =
  'Add notes, exports, and documents you have already written elsewhere.';

/** What that row says to an account with nowhere to keep a document yet. */
export const SEED_ROW_VAULT_FIRST_DESCRIPTION =
  `Documents you bring in are kept with the rest of your writing. Set that up under ` +
  `${VAULT_ROW_LABEL}, then bring them in.`;

/** The Journal band's open action for an account with nowhere to keep a document yet. */
export const VAULT_FIRST_CTA = 'Give your writing a place to live';

/**
 * The words that open each corpus destination, keyed by the destination.
 *
 * One record rather than a label chosen beside a route, so the words a person
 * taps cannot come to name somewhere other than where the tap goes.
 */
export const CORPUS_CTA_BY_DESTINATION: Readonly<Record<CorpusDestination, string>> = {
  CorpusConsent: 'Look at the decision',
  SeedCorpus: SEED_ROW_LABEL,
  VaultSettings: VAULT_FIRST_CTA,
};

/** What the seeding screen says in place of the picker when there is nowhere to keep a document. */
export const SEED_VAULT_INVITATION =
  "Documents you bring in are kept with the rest of your writing, and there isn't a place for " +
  'them yet. Set one up, and they can come in from there. Your journal works the same ' +
  'either way.';

/** The way there from the seeding screen. */
export const SEED_VAULT_INVITATION_LINK_LABEL = `Open ${VAULT_ROW_LABEL}`;

/** Every line above, for the copy sweep. */
export const VAULT_GATE_COPY: readonly string[] = [
  SEED_ROW_LABEL,
  SEED_ROW_DESCRIPTION,
  SEED_ROW_VAULT_FIRST_DESCRIPTION,
  VAULT_FIRST_CTA,
  SEED_VAULT_INVITATION,
  SEED_VAULT_INVITATION_LINK_LABEL,
  ...Object.values(CORPUS_CTA_BY_DESTINATION),
];
