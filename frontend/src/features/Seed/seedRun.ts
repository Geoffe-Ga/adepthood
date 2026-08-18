/**
 * The pure state machine behind a multi-document seeding run.
 *
 * A run holds every document the person picked, in the order they picked it,
 * and moves them through one upload at a time. Sequential is structural here
 * rather than incidental: {@link selectNextQueued} offers nothing while a
 * document is in flight, so a forty-file seed can never open forty requests.
 *
 * Every terminal state is its own status, including the three the vault can
 * answer with. A vault that cannot take files yet is not a failure and does not
 * share a status with one; a document past the size cap never reaches the
 * network at all. Nothing collapses into a generic "error", because each of
 * these sends the person somewhere different.
 *
 * PRIVACY: an item carries an id, a name, and a status — never the document's
 * bytes. The bytes live in the driver's local scope for exactly as long as
 * their request, so they cannot reach this state, a log, or a testID.
 */

/** The four outcomes the vault itself answers with, in this run's words. */
export type VaultSeedStatus =
  'ingested' | 'vault_unavailable' | 'capability_unsupported' | 'degraded';

/** The outcomes decided on device, before or instead of a request. */
export type LocalSeedStatus = 'unsupported_format' | 'too_large' | 'unreadable' | 'failed';

/** A settled document's outcome: what the vault said, or what the device found. */
export type SettledSeedStatus = VaultSeedStatus | LocalSeedStatus;

/** One document's lifecycle within a run. */
export type SeedItemStatus = 'queued' | 'uploading' | SettledSeedStatus;

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

/** How many of each kind of outcome a run currently holds. */
export interface SeedRunTally {
  total: number;
  ingested: number;
  waiting: number;
  refused: number;
}

/** A run with nothing in it — the state before the first pick. */
export const EMPTY_SEED_RUN: SeedRunState = { order: [], items: {} };

/**
 * The transitions a run accepts:
 *
 *  - `add`    — append a pick's documents, each with its starting status.
 *  - `start`  — mark a `queued` document in flight.
 *  - `settle` — record a document's terminal outcome.
 *  - `clear`  — empty the run (the person starting over).
 */
export type SeedRunAction =
  | { type: 'add'; entries: readonly SeedEntry[] }
  | { type: 'start'; id: string }
  | { type: 'settle'; id: string; status: SettledSeedStatus }
  | { type: 'clear' };

/** Whether a status is terminal — nothing further will happen to the document. */
function isSettled(status: SeedItemStatus): boolean {
  return status !== 'queued' && status !== 'uploading';
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

/** `start`: only a `queued` document may go in flight. */
function applyStart(state: SeedRunState, id: string): SeedRunState {
  const item = state.items[id];
  if (!item || item.status !== 'queued') return state;
  return withItem(state, { ...item, status: 'uploading' });
}

/** `settle`: record the terminal outcome of a document the run still holds. */
function applySettle(state: SeedRunState, id: string, status: SettledSeedStatus): SeedRunState {
  const item = state.items[id];
  if (!item) return state;
  return withItem(state, { ...item, status });
}

/** Advance a run by one action. */
export function seedRunReducer(state: SeedRunState, action: SeedRunAction): SeedRunState {
  switch (action.type) {
    case 'add':
      return applyAdd(state, action.entries);
    case 'start':
      return applyStart(state, action.id);
    case 'settle':
      return applySettle(state, action.id, action.status);
    case 'clear':
      return EMPTY_SEED_RUN;
    default:
      return state;
  }
}

/** Whether any document is currently in flight — the sequential gate. */
function hasInFlight(state: SeedRunState): boolean {
  return state.order.some((id) => state.items[id]?.status === 'uploading');
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

/** What the run currently holds: how much landed, waits, or did not land. */
export function seedRunTally(state: SeedRunState): SeedRunTally {
  const tally: SeedRunTally = { total: state.order.length, ingested: 0, waiting: 0, refused: 0 };
  for (const id of state.order) {
    const status = state.items[id]?.status;
    if (status === undefined) continue;
    if (status === 'ingested') tally.ingested += 1;
    else if (isSettled(status)) tally.refused += 1;
    else tally.waiting += 1;
  }
  return tally;
}
