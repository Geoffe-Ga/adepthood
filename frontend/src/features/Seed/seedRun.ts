/**
 * The pure state machine behind a multi-document seeding run.
 *
 * A run holds every document the person picked, in the order they picked it,
 * and moves them through one upload at a time. Sequential is structural here
 * rather than incidental: {@link selectNextQueued} offers nothing while a
 * document is in flight, so a forty-file seed can never open forty requests.
 *
 * Every terminal state is its own status, including each one the two
 * destinations can answer with. A vault that cannot take files yet is not a
 * failure and does not share a status with one; a corpus waiting on a consent
 * nobody has given is not a failure either; a document past the size cap never
 * reaches the network at all. Nothing collapses into a generic "error", because
 * each of these sends the person somewhere different.
 *
 * PRIVACY: an item carries an id, a name, and a status — never the document's
 * bytes. The bytes live in the driver's local scope for exactly as long as
 * their request, so they cannot reach this state, a log, or a testID.
 */

/**
 * The six outcomes the vault itself answers with, in this run's words.
 *
 * `vault_busy` is settled only once the run has waited out a busy vault as many
 * times as it will (#3770): nothing was kept, and the cause was the vault's
 * moment rather than the document, so it can go again.
 *
 * `unsupported_source` is the vault refusing the file's type with a 415
 * (#3771): nothing was kept, and the same file is refused the same way.
 */
export type VaultSeedStatus =
  | 'ingested'
  | 'vault_unavailable'
  | 'capability_unsupported'
  | 'degraded'
  | 'vault_busy'
  | 'unsupported_source';

/**
 * The outcomes answered when no vault took the document.
 *
 * Since #3016 the server answers only `vault_required`: a corpus lives in a
 * vault (#3015), so an account the server finds no vault for has its document
 * stored nowhere. The other eight described the retired local corpus import —
 * consent, a language model placing the writing, the intimate refusal — and
 * stay because the server keeps them on the wire. A separate vocabulary from
 * the vault's rather than a translation into it, because these are things a
 * vault never says.
 */
export type CorpusSeedStatus =
  | 'in_corpus'
  | 'consent_required'
  | 'tier_refused'
  | 'format_unreadable'
  | 'not_text'
  | 'empty_document'
  | 'document_too_long'
  | 'unclassified'
  | 'vault_required';

/**
 * The outcomes decided on device, before or instead of a server answer.
 *
 * `cancelled` is the one of these that is nobody's refusal: the run was stopped
 * while the document was still waiting its turn, so it never reached the
 * network at all. It is a settled status rather than a return to `queued`
 * because the run that would have sent it is over.
 *
 * `offline`, `failed` and `unconfirmed` split what used to be one status by
 * what the device can actually know (#3239). `offline` was never sent, because
 * the platform said the device was offline before the request was made.
 * `failed` was turned away by the server with a 4xx, the answer to the only
 * attempt there was, so nothing was kept. `unconfirmed` left the device and
 * its answer was lost -- a timeout, a dropped connection, a server error, or a
 * reply the app could not read -- so it may already be stored.
 *
 * `rate_limited` is the server asking for a pause (a 429) more times than the
 * run waits one out, or for a longer wait than it will sit through (#3556).
 * Nothing was kept, and it is not the document's fault, so it is neither
 * `failed` nor a refusal of the file.
 *
 * The {@link SeedSkipStatus} members are files a chosen folder held that were
 * never going to be sent (#3771), each with the reason it stayed behind.
 */
export type LocalSeedStatus =
  | SeedSkipStatus
  | 'managed_too_large'
  | 'unreadable'
  | 'offline'
  | 'failed'
  | 'rate_limited'
  | 'unconfirmed'
  | 'cancelled';

/**
 * Why a file was skipped before anything was sent (#3771): decided on the
 * device from its name, place and size alone, so not a byte of it left.
 *
 *  - `unsupported_format` — a type the vault has no ingestor for, or refuses.
 *  - `attachments_off`    — a type the vault reads, left out because the
 *                           folder's attachments were not switched on.
 *  - `too_large`          — past the one-document size cap.
 *  - `app_settings`       — inside an app's settings folder (`.obsidian`, `.git`).
 *  - `hidden_file`        — hidden, or inside a hidden folder.
 *  - `unsafe_name`        — a name or path the server would refuse.
 *  - `name_collision`     — one of two spellings of the same path.
 *  - `subscriber_data`    — a Substack export's list of who received or opened
 *                           a post, or of its subscribers (#3798).
 */
export type SeedSkipStatus =
  | 'unsupported_format'
  | 'attachments_off'
  | 'too_large'
  | 'app_settings'
  | 'hidden_file'
  | 'unsafe_name'
  | 'name_collision'
  | 'subscriber_data';

/**
 * A settled document's outcome: what its destination said, or what the device
 * found before there was a request to make.
 *
 * Two server vocabularies rather than one, because a document reaches exactly
 * one of two destinations and the server says which. Collapsing them would
 * require this app to decide what a corpus answer "means in vault terms",
 * which is a second answer to a question already answered.
 */
export type SettledSeedStatus = VaultSeedStatus | CorpusSeedStatus | LocalSeedStatus;

/**
 * One document's lifecycle within a run.
 *
 * `waiting` is a document held for a moment before it goes (#3556): paced to
 * stay under the upload limit, or waiting out the pause a 429 asked for. Nothing
 * of it is in flight, but it holds the run, because it is the one going next.
 *
 * `vault_waiting` is the same hold for a different reason (#3770): the vault
 * answered that it was busy, so the document waits out the time it named and
 * goes again. Its own status, because "pausing for the pace" and "waiting for
 * your vault" are different things to be told.
 */
export type SeedItemStatus =
  'queued' | 'waiting' | 'vault_waiting' | 'uploading' | SettledSeedStatus;

/** What a held document is waiting on: the upload pace, or a busy vault (#3770). */
export type SeedWaitCause = 'pace' | 'vault';

/** The per-document working record. */
export interface SeedItem {
  id: string;
  name: string;
  status: SeedItemStatus;
}

/** The whole run: pick order and the keyed items. */
export interface SeedRunState {
  order: string[];
  items: Record<string, SeedItem>;
}

/** A document entering the run, already settled when the device refused it. */
export interface SeedEntry {
  id: string;
  name: string;
  status: 'queued' | SettledSeedStatus;
}

/**
 * How many of each kind of outcome a run currently holds (#3771).
 *
 * `landed + failed + remaining + skipped + stopped === total`; `unconfirmed`
 * is the part of `failed` nobody could confirm either way, never a bucket of
 * its own.
 */
export interface SeedRunTally {
  total: number;
  /** Durably kept, wherever this account's writing lives. */
  landed: number;
  /** Settled without landing, or without anyone able to say it landed. */
  failed: number;
  /** Still to go: queued, held for a moment, or in flight. */
  remaining: number;
  /** Never sent: a type nobody here reads, attachments off, and the like. */
  skipped: number;
  /** Never sent because the person stopped the run before its turn. */
  stopped: number;
  /** Of `failed`, those that may have been kept: nobody could confirm (#3239). */
  unconfirmed: number;
}

/**
 * The two ways a document is durably kept: the vault's `accepted`, and the
 * corpus's `stored`. Counted together because the tally answers "how much of
 * what I chose is in", which is one question whichever destination answered
 * it — the per-document line is where the destination is named.
 */
const LANDED_STATUSES: readonly SeedItemStatus[] = ['ingested', 'in_corpus'];

/**
 * The two ways a document may have been kept without anyone being able to say
 * so: the vault's `degraded`, answered after the document went over, and a
 * request whose own answer was lost. Counted apart from the refusals because
 * "didn't go over" would be a claim about these that nothing can check.
 */
const UNCONFIRMED_STATUSES: readonly SeedItemStatus[] = ['degraded', 'unconfirmed'];

/**
 * Every outcome counted as skipped rather than failed (#3771): the files a
 * folder held that were never sent, and the one the vault turned away for its
 * type alone (`unsupported_source`, a 415). Nothing about any of them is the
 * moment's fault, so none is offered again.
 */
const SKIPPED_STATUSES: readonly SeedItemStatus[] = [
  'unsupported_format',
  'attachments_off',
  'too_large',
  'app_settings',
  'hidden_file',
  'unsafe_name',
  'name_collision',
  'subscriber_data',
  'unsupported_source',
];

/** Whether a document was skipped rather than sent and refused (#3771). */
export function isSkippedSeedStatus(status: SeedItemStatus): boolean {
  return SKIPPED_STATUSES.includes(status);
}

/**
 * The outcomes worth sending the same document again for (#3556): nothing was
 * kept, or nobody can say it was, and the cause was the moment rather than the
 * document. A retry sends it under the same identity, which updates in place
 * rather than copying. A refusal of the document itself (too large, a tier, a
 * format) is not here, because sending it again would be answered the same way;
 * nor is `cancelled`, which the person chose.
 */
const RETRYABLE_STATUSES: readonly SeedItemStatus[] = [
  'failed',
  'rate_limited',
  'vault_busy',
  'offline',
  'unconfirmed',
  'degraded',
  'vault_unavailable',
];

/** Whether a document that settled this way may be sent again by a retry. */
export function isRetryableSeedStatus(status: SeedItemStatus): boolean {
  return RETRYABLE_STATUSES.includes(status);
}

/** A run with nothing in it — the state before the first pick. */
export const EMPTY_SEED_RUN: SeedRunState = { order: [], items: {} };

/**
 * The transitions a run accepts:
 *
 *  - `add`    — append a pick's documents, each with its starting status.
 *  - `start`  — mark a `queued` document in flight.
 *  - `settle` — record a document's terminal outcome.
 *  - `wait`   — hold a queued or in-flight document for a moment (#3556), for
 *               the pace or, with `cause: 'vault'`, for a busy vault (#3770).
 *  - `cancel` — stop the run: everything still queued or waiting settles as never
 *               sent; with `ids`, only those documents (one batch, #3772).
 *  - `requeue` — queue settled documents again, only those a retry may send.
 *  - `clear`  — empty the run (the person starting over).
 */
export type SeedRunAction =
  | { type: 'add'; entries: readonly SeedEntry[] }
  | { type: 'start'; id: string }
  | { type: 'wait'; id: string; cause?: SeedWaitCause }
  | { type: 'requeue'; ids: readonly string[] }
  | { type: 'settle'; id: string; status: SettledSeedStatus }
  | { type: 'cancel'; ids?: readonly string[] }
  | { type: 'clear' };

/** The statuses of a document the run still holds: not yet settled. */
const UNSETTLED_STATUSES: readonly SeedItemStatus[] = [
  'queued',
  'waiting',
  'vault_waiting',
  'uploading',
];

/** The two holds: a document between attempts, waiting on the pace or the vault. */
function isHeld(status: SeedItemStatus | undefined): boolean {
  return status === 'waiting' || status === 'vault_waiting';
}

/** Whether a status is terminal — nothing further will happen to the document. */
function isSettled(status: SeedItemStatus): boolean {
  return !UNSETTLED_STATUSES.includes(status);
}

/** Whether a document is done with: nothing further will happen to it (#3772). */
export function isSettledSeedStatus(status: SeedItemStatus): boolean {
  return isSettled(status);
}

/** Whether a document is durably kept, wherever this account's writing lives (#3772). */
export function isLandedSeedStatus(status: SeedItemStatus): boolean {
  return LANDED_STATUSES.includes(status);
}

/** Return a new state with one item replaced (order untouched). */
function withItem(state: SeedRunState, item: SeedItem): SeedRunState {
  return { order: state.order, items: { ...state.items, [item.id]: item } };
}

/** `add`: append each entry in pick order, keeping any already-settled reason. */
function applyAdd(state: SeedRunState, entries: readonly SeedEntry[]): SeedRunState {
  const items = { ...state.items };
  const order = [...state.order];
  for (const entry of entries) {
    items[entry.id] = { id: entry.id, name: entry.name, status: entry.status };
    order.push(entry.id);
  }
  return { order, items };
}

/** `start`: only a `queued` or held document may go in flight. */
function applyStart(state: SeedRunState, id: string): SeedRunState {
  const item = state.items[id];
  if (!item || (item.status !== 'queued' && !isHeld(item.status))) return state;
  return withItem(state, { ...item, status: 'uploading' });
}

/** `wait`: a document not yet settled is held for a moment, for the pace or the vault. */
function applyWait(state: SeedRunState, id: string, cause: SeedWaitCause): SeedRunState {
  const item = state.items[id];
  if (!item || isSettled(item.status)) return state;
  return withItem(state, { ...item, status: cause === 'vault' ? 'vault_waiting' : 'waiting' });
}

/** `requeue`: settled documents a retry may send go back in line; nothing else moves. */
function applyRequeue(state: SeedRunState, ids: readonly string[]): SeedRunState {
  let next = state;
  for (const id of ids) {
    const item = next.items[id];
    if (item && isRetryableSeedStatus(item.status)) {
      next = withItem(next, { ...item, status: 'queued' });
    }
  }
  return next;
}

/** `settle`: record the terminal outcome of a document the run still holds. */
function applySettle(state: SeedRunState, id: string, status: SettledSeedStatus): SeedRunState {
  const item = state.items[id];
  if (!item) return state;
  return withItem(state, { ...item, status });
}

/**
 * `cancel`: settle every document still queued or waiting as one that never
 * went. A waiting document has nothing in flight: it is between attempts, and
 * the attempt a 429 or a busy vault answered kept nothing.
 *
 * A document already in flight is left `uploading` on purpose. Its request is
 * with the server, and the server will answer it; calling it cancelled here
 * would be this screen saying one thing while the corpus holds another, which
 * is the divergence the whole cancel path exists to close.
 */
function applyCancel(state: SeedRunState, ids: readonly string[]): SeedRunState {
  const items = { ...state.items };
  for (const id of ids) {
    const item = items[id];
    if (item && (item.status === 'queued' || isHeld(item.status))) {
      items[id] = { ...item, status: 'cancelled' };
    }
  }
  return { order: state.order, items };
}

/** Advance a run by one action. */
export function seedRunReducer(state: SeedRunState, action: SeedRunAction): SeedRunState {
  switch (action.type) {
    case 'add':
      return applyAdd(state, action.entries);
    case 'start':
      return applyStart(state, action.id);
    case 'wait':
      return applyWait(state, action.id, action.cause ?? 'pace');
    case 'requeue':
      return applyRequeue(state, action.ids);
    case 'settle':
      return applySettle(state, action.id, action.status);
    case 'cancel':
      return applyCancel(state, action.ids ?? state.order);
    case 'clear':
      return EMPTY_SEED_RUN;
    default:
      return state;
  }
}

/** Whether any document is in flight or about to be — the sequential gate. */
function hasInFlight(state: SeedRunState): boolean {
  return state.order.some((id) => {
    const status = state.items[id]?.status;
    return status === 'uploading' || isHeld(status);
  });
}

/**
 * The document to upload next: the first still `queued`, and only while nothing
 * is in flight. Returns null when the run is waiting on a request or has none
 * left to send.
 */
export function selectNextQueued(state: SeedRunState): SeedItem | null {
  if (hasInFlight(state)) return null;
  for (const id of state.order) {
    const item = state.items[id];
    if (item && item.status === 'queued') return item;
  }
  return null;
}

/** The bucket one status is counted in; `unconfirmed` is counted again apart. */
type TallyBucket = 'landed' | 'failed' | 'remaining' | 'skipped' | 'stopped';

/**
 * Which of the five counts a status belongs to. A cancelled document is
 * `stopped` rather than failed or skipped: nobody refused it, and it was not
 * its type -- the person stopped the run before its turn.
 */
function bucketOf(status: SeedItemStatus): TallyBucket {
  if (LANDED_STATUSES.includes(status)) return 'landed';
  if (SKIPPED_STATUSES.includes(status)) return 'skipped';
  if (status === 'cancelled') return 'stopped';
  return isSettled(status) ? 'failed' : 'remaining';
}

/** A tally of nothing. */
function emptyTally(): SeedRunTally {
  return { total: 0, landed: 0, failed: 0, remaining: 0, skipped: 0, stopped: 0, unconfirmed: 0 };
}

/** Count a set of documents into landed, failed, remaining, skipped and stopped (#3771). */
export function tallySeedItems(items: readonly Pick<SeedItem, 'status'>[]): SeedRunTally {
  const tally = emptyTally();
  for (const { status } of items) {
    tally.total += 1;
    tally[bucketOf(status)] += 1;
    if (UNCONFIRMED_STATUSES.includes(status)) tally.unconfirmed += 1;
  }
  return tally;
}

/** What the whole run currently holds, counted as {@link tallySeedItems} counts. */
export function seedRunTally(state: SeedRunState): SeedRunTally {
  const items: SeedItem[] = [];
  for (const id of state.order) {
    const item = state.items[id];
    if (item !== undefined) items.push(item);
  }
  return tallySeedItems(items);
}
