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
import { MANAGED_SEED_DOCUMENT_LABEL, MAX_SEED_DOCUMENT_LABEL } from './readSeedDocument';
import type { SeedItemStatus, SeedRunTally } from './seedRun';

import type { CorpusDestination } from '@/features/Journal/corpusDestination';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';

/** The line shown beneath each document's name, keyed by where it got to. */
export const SEED_STATUS_LINES: Record<SeedItemStatus, string> = {
  queued: 'Waiting its turn.',
  // Paced to keep a big folder from being turned away, or waiting out the
  // pause the server asked for (#3556). Nothing is wrong, and it goes next.
  waiting: 'Pausing a moment so everything goes over at a steady pace. This one is next.',
  // The vault answered that it was busy -- a pass of its own holding it for a
  // while (#3770). Not a failure and not this document's doing: the run waits
  // as long as the vault asked, then sends it again.
  vault_waiting:
    "Waiting for your Corpus… It's busy settling what it already holds, and this one goes " +
    "over as soon as it's free.",
  uploading: 'Going over now…',
  ingested: 'In your Corpus. It will show up in reflections from here on.',
  vault_unavailable:
    "Where your Corpus is kept didn't answer. Check that it's running, then send this again.",
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
    "this in your Corpus. Otherwise Adepthood can't send to where your Corpus is kept just yet; keep this one " +
    'and try again later.',
  // Answered after the document went over, so it cannot promise the vault is
  // unchanged: the vault may have kept it and lost only its reply (#3052).
  // Sending again is safe — the same file updates in place.
  degraded:
    "We couldn't confirm this reached your Corpus. Send it again — the same file updates in " +
    'place rather than making a second copy.',
  // The vault stayed busy through every wait the run would take (#3770). It
  // refused before anything was written, so "nothing was stored" is a fact,
  // and the cause was the vault's moment, so it can go again.
  vault_busy:
    'Your Corpus stayed busy the whole time, so this one is still with you and nothing was ' +
    'stored. Send it again once your Corpus has settled.',
  // The vault refused the file's type with a 415 (#3771) before writing
  // anything. Counted with the skipped files, and offered no resend: the same
  // file is refused the same way.
  unsupported_source:
    "Skipped · your Corpus doesn't take this kind of file as a document, so nothing was " +
    'stored. It is still with you.',
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
    'Markdown. Storage connected to keep your Corpus reads richer formats for you.',
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
  // The skipped files (#3771): decided on device from a file's name, place and
  // size, before anything was sent. Each opens with "Skipped ·" so a row reads
  // as the count it belongs to, then says why in a phrase and that nothing left.
  //
  // Outside everything the vault reads, or a type it refuses outright.
  unsupported_format: "Skipped · your Corpus doesn't read this type, so it was never sent.",
  // A type the vault reads, left behind because the folder's attachments were
  // not switched on. Offered, never pressed: it is the person's choice.
  attachments_off:
    'Skipped · attachments are off, so this was never sent. Bring the folder in again with ' +
    'them on if you want it too.',
  too_large:
    `Skipped · larger than ${MAX_SEED_DOCUMENT_LABEL}, which is as much as one document can ` +
    'carry, so it was never sent.',
  app_settings: "Skipped · an app's own settings rather than your writing, so it was never sent.",
  hidden_file: 'Skipped · a hidden file, so it was never sent.',
  unsafe_name:
    "Skipped · its name or folder can't be sent as it is, so it never was. Renamed, it can " +
    'come in.',
  name_collision:
    'Skipped · another file here has the same path spelled another way, and either would ' +
    'overwrite the other, so neither was sent. Rename one and both can come in.',
  // A Substack export's stat CSVs and subscriber roster (#3798): other people's
  // addresses rather than the person's writing, so the device keeps them.
  subscriber_data:
    'Skipped · a list of who received or opened a post, so it stays on this device and ' +
    'was never sent.',
  // The managed vault's request ceiling (#3051), checked on the server before a
  // byte of the document left it, so "nothing was stored" is a fact. The same
  // file can never fit, so this offers a smaller file rather than another go.
  managed_too_large:
    'Too large for your Corpus, so nothing was stored. Your Corpus takes files up to about ' +
    `${MANAGED_SEED_DOCUMENT_LABEL}; a smaller file, or this one split in parts, will go over.`,
  unreadable: "This file wouldn't open on this device.",
  // Decided on device from the platform's own connectivity signal, before any
  // request was made, so "wasn't sent" is a fact rather than a guess.
  offline: "This device was offline, so this wasn't sent. Send it again once you're connected.",
  // Only a 4xx answer to the one attempt there was: the server turned the
  // document away, so nothing was kept (#3239).
  failed: "This didn't get through, and nothing was stored. You can send it again.",
  // The server kept asking for a pause after the run had waited it out more
  // than once (#3556). Not a judgement of the document: nothing was stored, and
  // it can go again in a minute or two.
  rate_limited:
    'Too many went over at once, so nothing was stored for this one yet. Give it a minute, ' +
    'then send it again.',
  // The request left the device and its answer was lost on the way back: a
  // timeout, a dropped connection, a server error, or a reply this app could
  // not read. The server may already have kept it, so this says only what is
  // known, and names no destination because which one answered is what was
  // lost. Sending again is safe, as for `degraded` (#3238).
  unconfirmed:
    "No clear answer came back, so we couldn't confirm this arrived. Send it again — the same " +
    'file updates in place rather than making a second copy.',
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

/** Between two counts in a line: the same middle dot the batch headers use. */
const COUNT_SEPARATOR = ' · ';

/** How the skipped count is named: what kind of skip it mostly is. */
const SKIPPED_LABEL = 'skipped (unsupported type)';

/**
 * The run's four counts, always in this order and always all four (#3771):
 * `12 landed · 3 failed · 40 remaining · 18 skipped (unsupported type)`. A
 * fifth, `stopped`, follows only when the person stopped something. Null
 * before the first pick, when there is nothing honest to count.
 *
 * Plain counts, no praise and no pressure: the same line reads the same
 * whether everything landed or nothing did. Deliberately says "landed" rather
 * than naming a destination -- which one answered is the server's word per
 * request, and the per-document row is where the place is named.
 */
export function seedSummaryLine(tally: SeedRunTally): string | null {
  if (tally.total === 0) {
    return null;
  }
  const counts = [
    `${tally.landed} landed`,
    `${tally.failed} failed`,
    `${tally.remaining} remaining`,
    `${tally.skipped} ${SKIPPED_LABEL}`,
  ];
  if (tally.stopped > 0) counts.push(`${tally.stopped} stopped`);
  return counts.join(COUNT_SEPARATOR);
}

/**
 * The sub-line beneath the counts when some of the failed may have landed
 * after all (#3239): their reply was lost, so nobody can say. Null when none.
 * A sub-line of Failed rather than a fifth count, because "failed" is true of
 * them as far as anyone can see, and this says what is not known.
 */
export function seedUnconfirmedLine(tally: SeedRunTally): string | null {
  if (tally.unconfirmed === 0) return null;
  const which =
    tally.unconfirmed === 1
      ? "1 of those couldn't be confirmed — it may have arrived"
      : `${tally.unconfirmed} of those couldn't be confirmed — they may have arrived`;
  return `${which}. Sending again updates in place rather than making a second copy.`;
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
export function seedProgressLine(
  tally: SeedRunTally,
  paused = false,
  waitingOnVault = false,
): string | null {
  if (tally.remaining === 0) {
    return null;
  }
  if (waitingOnVault) {
    return SEED_VAULT_BUSY_PROGRESS_LINE;
  }
  if (paused) {
    return SEED_PAUSED_PROGRESS_LINE;
  }
  // Skipped files were never going to be sent, so the position counts only
  // what is sent or was meant to be (#3771).
  const sendable = tally.total - tally.skipped;
  const settled = sendable - tally.remaining;
  return `Sending ${settled + 1} of ${sendable}…`;
}

/**
 * The progress line while the next document is held for a moment (#3556), so
 * a run waiting out its pace does not claim to be sending.
 */
export const SEED_PAUSED_PROGRESS_LINE =
  'Pausing a moment between documents so they all go over at a steady pace…';

/**
 * The progress line while the next document waits out a busy vault (#3770):
 * the vault's own pass is holding things, not the pace and not the document.
 */
export const SEED_VAULT_BUSY_PROGRESS_LINE =
  "Waiting for your Corpus to finish what it's doing. The rest go over once it's free…";

/**
 * The offer to send again the documents that did not go over (#3556), counting
 * exactly what it will send. Only those: anything that landed stays as it is.
 */
export function seedRetryLabel(count: number): string {
  return count === 1 ? 'Try that one again' : `Try those ${count} again`;
}

// ---------------------------------------------------------------------------
// A queue that carries on while the person moves around the app (#3772)
// ---------------------------------------------------------------------------
//
// The run lives in the app-level upload queue, so leaving this screen carries
// on. It does not outlive the app itself: a picked file cannot be reopened
// after a reload, so closing the tab or the app stops it, and the copy says so
// plainly rather than implying a background service there is not.

/**
 * Shown on the seeding screen while documents are going over: what moving
 * around the app does, and what closing it does.
 */
export const SEED_BACKGROUND_NOTE =
  'These carry on while you use the rest of the app, and you can add more ' +
  'whenever you like. Closing this tab or the app stops them; anything not yet ' +
  'sent stays on your device.';

/**
 * The warning a browser shows before a tab with documents still going over is
 * closed or reloaded -- the one exit that does stop the queue.
 *
 * Browsers have shown their own wording since 2016 and ignore this text; it is
 * set because the API is what arms the prompt, and kept truthful because
 * nothing is served by a string that lies where it does happen to show.
 */
export const SEED_LEAVE_BROWSER_WARNING =
  'Documents are still going over. Closing this tab stops them, and everything still waiting ' +
  'is never sent.';

/** Stops the whole queue; what is with the server already finishes. */
export const SEED_STOP_ALL_LABEL = 'Stop sending the rest';

/** Stops one batch, leaving the others queued. */
export const SEED_STOP_BATCH_LABEL = 'Stop this batch';

/** "1 file", "40 files". */
function fileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/**
 * The app-wide indicator's line: how much of the queue is still to go, and,
 * once any has, how much failed (#3771) -- the one count worth a glance from
 * elsewhere in the app. The full four are on the seeding screen it opens.
 */
export function uploadQueueIndicatorLine(remaining: number, failed = 0): string {
  const line = `Uploading${COUNT_SEPARATOR}${remaining} remaining`;
  return failed > 0 ? `${line}${COUNT_SEPARATOR}${failed} failed` : line;
}

// ---------------------------------------------------------------------------
// After the queue drains: the one vault pass over what landed (#3773)
// ---------------------------------------------------------------------------
//
// Quiet lines, said from the same place the queue's own line was, once nothing
// is left to send. The pass runs on the server whether or not this app stays
// open, so none of them asks anything of the person.

/** While the vault weaves in what the run landed. */
export const SETTLING_LINE = "Settling what you've sent…";

/** Once the pass has gone through the whole ladder. */
export const SETTLED_LINE = "What you've sent has settled into your Corpus.";

/** When the vault could not be reached for the pass; what landed stays landed. */
export const SETTLE_DEFERRED_LINE =
  'Where your Corpus is kept was out of reach just now. What you sent is saved, and will settle on a later pass.';

/** What a batch header needs to say where the batch stands. */
export interface SeedBatchHeader {
  /** The folder's import name; null for files picked one by one. */
  name: string | null;
  state: 'queued' | 'sending' | 'settled';
  total: number;
  remaining: number;
}

/**
 * The header row above one batch in the run list: its folder's name when it
 * has one, then queued, going over, or done.
 */
export function seedBatchHeaderLine(batch: SeedBatchHeader): string {
  const where =
    batch.state === 'queued'
      ? `Queued · ${fileCount(batch.total)}`
      : batch.state === 'sending'
        ? uploadQueueIndicatorLine(batch.remaining)
        : `Done · ${fileCount(batch.total)}`;
  return batch.name === null ? where : `${batch.name} · ${where}`;
}

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
