/**
 * The pure state machine behind a multi-page transcription run.
 *
 * A run reads several handwritten pages at once under a small concurrency bound,
 * lands each page's text under its own stable id (out of order is fine), lets the
 * writer hand-edit or explicitly redo any page, and finally merges the pages, in
 * session order, into one editable entry.
 *
 * WALLET INTEGRITY: every transcription is a real-money charge, so a page that has
 * already been read must never be re-read on its own. That guarantee is structural
 * here, not incidental: {@link selectStartable} only ever offers `pending` pages,
 * `start` is inert on anything that is not `pending`, and the only path back to
 * `pending` from a settled page (`done` or `failed`) is an explicit `retry` — a
 * user gesture, never the loop's own doing.
 *
 * COST EXPOSURE: {@link TRANSCRIBE_CONCURRENCY} is a hard bound on live charges,
 * not a rendering convenience, so a slot is held by the *request* rather than by
 * the page it was reading. Trimming a page mid-read leaves its request in flight
 * whatever the page list now says, so the run keeps counting it — as an
 * {@link OrphanedRequest} — until it settles. See {@link applyPagesSynced}.
 *
 * PRIVACY: a block carries status/text/edit/error only — never the page image. The
 * driver hook cross-references the live {@link CapturePage} by id at call time, so
 * no base64 ever lands in this state (and thus never in a log, error, or testID).
 */
import type { TranscriptionErrorKind } from '@/api';

/** How many pages a run may have in flight at once — each slot is one live charge. */
export const TRANSCRIBE_CONCURRENCY = 2;

/** The attempt token a freshly-seeded (or synced-in) page starts life on. */
const FIRST_ATTEMPT = 1;

/** How merged pages are joined: a blank line between pages, no page markers. */
const BLOCK_SEPARATOR = '\n\n';

/**
 * Failure kinds no per-page gesture can clear: the configured model cannot read
 * images at all, or the balance behind the key is spent. Either way a retry only
 * re-charges the wallet to fail again, so the screen offers a hand-typed offramp
 * instead of a per-block retry. Offering one here would contradict the copy,
 * which says in words that waiting cannot help.
 */
export const TERMINAL_ERROR_KINDS: ReadonlySet<TranscriptionErrorKind> =
  new Set<TranscriptionErrorKind>([
    'model_lacks_vision',
    'credit_exhausted',
    'service_credit_exhausted',
  ]);

/** One page's lifecycle within a run. */
export type TranscriptionBlockStatus = 'pending' | 'inFlight' | 'done' | 'failed';

/**
 * The per-page working record. `attempt` is the token that pairs a `start` with
 * its eventual `resolve`/`reject`, so a late reply from a superseded attempt is
 * dropped rather than clobbering a newer read.
 */
export interface TranscriptionBlock {
  id: string;
  status: TranscriptionBlockStatus;
  text: string;
  edited: boolean;
  attempt: number;
  error: TranscriptionErrorKind | null;
}

/**
 * A charged request that outlived the page it was reading: the writer trimmed the
 * page while it was `inFlight`. It is not a block — it has no text, no status the
 * screen can render, and no way back into the run — it is just the bookkeeping that
 * remembers a slot is still spent, keyed by the same `(id, attempt)` pair that will
 * identify its reply.
 */
export interface OrphanedRequest {
  id: string;
  attempt: number;
}

/**
 * The whole run: the session's start-priority order, the keyed blocks, and the
 * requests still outstanding for pages that have left (see {@link OrphanedRequest}).
 */
export interface TranscriptionRunState {
  order: string[];
  blocks: Record<string, TranscriptionBlock>;
  orphans: OrphanedRequest[];
}

/** The minimal shape the `pages`-taking selectors need: a page is just its id. */
export interface PageRef {
  id: string;
}

/**
 * The transitions a run accepts:
 *
 *  - `start`       — mark a `pending` page in flight, stamping its attempt token.
 *  - `resolve`     — land a page's transcribed text (→ `done`).
 *  - `reject`      — record a page's failure kind (→ `failed`).
 *  - `edit`        — replace a `done` page's text by hand (edits then win).
 *  - `retry`       — an explicit re-read of a settled page (→ `pending`, attempt++).
 *  - `pagesSynced` — reconcile order + additions/removals from the session's pages;
 *                    this alone seeds a fresh run (from the empty state) and drops a
 *                    page that leaves the session (its late reply lands nowhere,
 *                    though a read still running for it keeps holding its slot).
 */
export type TranscriptionRunAction =
  | { type: 'start'; id: string; attempt: number }
  | { type: 'resolve'; id: string; attempt: number; text: string }
  | { type: 'reject'; id: string; attempt: number; error: TranscriptionErrorKind }
  | { type: 'edit'; id: string; text: string }
  | { type: 'retry'; id: string }
  | { type: 'pagesSynced'; orderedIds: readonly string[] };

/** A brand-new page, waiting its turn. */
function pendingBlock(id: string, attempt: number = FIRST_ATTEMPT): TranscriptionBlock {
  return { id, status: 'pending', text: '', edited: false, attempt, error: null };
}

/** Return a new state with one block replaced (order and orphans untouched). */
function withBlock(
  state: TranscriptionRunState,
  id: string,
  next: TranscriptionBlock,
): TranscriptionRunState {
  return {
    order: state.order,
    blocks: { ...state.blocks, [id]: next },
    orphans: state.orphans,
  };
}

/** Whether this reply belongs to a request whose page has left the run. */
function isOrphanReply(state: TranscriptionRunState, id: string, attempt: number): boolean {
  return state.orphans.some((orphan) => orphan.id === id && orphan.attempt === attempt);
}

/**
 * Settle one orphaned request: forget it, releasing the concurrency slot it was
 * holding. The reply itself is discarded — its page is gone, so there is nothing
 * to land it on and nothing to show. Both a resolve and a reject arrive here, or a
 * failed read would strand its slot for the rest of the session.
 */
function releaseOrphan(
  state: TranscriptionRunState,
  id: string,
  attempt: number,
): TranscriptionRunState {
  return {
    order: state.order,
    blocks: state.blocks,
    orphans: state.orphans.filter((orphan) => orphan.id !== id || orphan.attempt !== attempt),
  };
}

/** `start`: only a `pending` page may go in flight — the first double-charge guard. */
function applyStart(
  state: TranscriptionRunState,
  id: string,
  attempt: number,
): TranscriptionRunState {
  const block = state.blocks[id];
  if (!block || block.status !== 'pending') return state;
  return withBlock(state, id, { ...block, status: 'inFlight', attempt });
}

/** `resolve`: land text unless the page is gone, the attempt is stale, or edited. */
function applyResolve(
  state: TranscriptionRunState,
  id: string,
  attempt: number,
  text: string,
): TranscriptionRunState {
  if (isOrphanReply(state, id, attempt)) return releaseOrphan(state, id, attempt);
  const block = state.blocks[id];
  if (!block || block.attempt !== attempt || block.edited) return state;
  return withBlock(state, id, { ...block, status: 'done', text });
}

/** `reject`: record the failure kind under the same freshness rules as `resolve`. */
function applyReject(
  state: TranscriptionRunState,
  id: string,
  attempt: number,
  error: TranscriptionErrorKind,
): TranscriptionRunState {
  if (isOrphanReply(state, id, attempt)) return releaseOrphan(state, id, attempt);
  const block = state.blocks[id];
  if (!block || block.attempt !== attempt || block.edited) return state;
  return withBlock(state, id, { ...block, status: 'failed', error });
}

/** `edit`: a hand edit only applies to a `done` page, and marks it edited. */
function applyEdit(state: TranscriptionRunState, id: string, text: string): TranscriptionRunState {
  const block = state.blocks[id];
  if (!block || block.status !== 'done') return state;
  return withBlock(state, id, { ...block, text, edited: true });
}

/**
 * `retry`: the ONLY path back to `pending` from a settled page — always an explicit
 * user gesture. Returns a failed OR done page to `pending`, clearing its text, edit
 * flag, and error, and bumping the attempt so any late reply from the old read is
 * dropped. Inert while the page is still `pending` or `inFlight`.
 */
function applyRetry(state: TranscriptionRunState, id: string): TranscriptionRunState {
  const block = state.blocks[id];
  if (!block || (block.status !== 'failed' && block.status !== 'done')) return state;
  return withBlock(state, id, {
    ...block,
    status: 'pending',
    text: '',
    edited: false,
    error: null,
    attempt: block.attempt + 1,
  });
}

/**
 * The requests left holding a slot after a sync: whatever was already orphaned,
 * plus every page that was mid-read when it left the session. Nothing else is
 * orphaned — a `pending` page never started a request, and a settled one has no
 * reply left to come — so neither can strand capacity the run would never get back.
 *
 * The set cannot grow without bound, and needs no cap to say so: an orphan only
 * ever replaces an in-flight page one-for-one, and {@link selectStartable} counts
 * both against the same {@link TRANSCRIBE_CONCURRENCY}, so there are never more
 * orphans outstanding than slots — and each is dropped the moment its reply lands.
 */
function orphansAfterSync(
  state: TranscriptionRunState,
  kept: ReadonlySet<string>,
): OrphanedRequest[] {
  const orphans = [...state.orphans];
  for (const id of state.order) {
    const block = state.blocks[id];
    if (block?.status === 'inFlight' && !kept.has(id)) {
      orphans.push({ id, attempt: block.attempt });
    }
  }
  return orphans;
}

/**
 * The attempt token a page entering the run starts on: past any orphan still
 * outstanding under the same id. Session ids are unique today, so this is
 * belt-and-braces — but were one ever reused, sharing a token with a request
 * already in the air would let that old reply land on the new page's block.
 */
function seedAttempt(id: string, orphans: readonly OrphanedRequest[]): number {
  let attempt = FIRST_ATTEMPT;
  for (const orphan of orphans) {
    if (orphan.id === id && orphan.attempt >= attempt) attempt = orphan.attempt + 1;
  }
  return attempt;
}

/**
 * `pagesSynced`: make the session's page list authoritative for order and
 * membership. Existing blocks are preserved as-is (a `done` page stays done), ids
 * new to the run enter `pending`, and ids no longer present are dropped — which is
 * exactly what a fresh run (from the empty state), a retake (an id swapped in place),
 * or an in-run removal each need. A dropped page's late reply lands nowhere.
 *
 * What survives the drop is the *request*, not the page: a page trimmed mid-read is
 * recorded as an {@link OrphanedRequest} so its live charge keeps holding its slot
 * until it settles. Dropping the block alone would tell the run a slot came free
 * while the wallet was still paying for it, and a third read would start.
 */
function applyPagesSynced(
  state: TranscriptionRunState,
  orderedIds: readonly string[],
): TranscriptionRunState {
  const orphans = orphansAfterSync(state, new Set(orderedIds));
  const blocks: Record<string, TranscriptionBlock> = {};
  for (const id of orderedIds) {
    blocks[id] = state.blocks[id] ?? pendingBlock(id, seedAttempt(id, orphans));
  }
  return { order: [...orderedIds], blocks, orphans };
}

/** Advance a run by one action. */
export function transcriptionRunReducer(
  state: TranscriptionRunState,
  action: TranscriptionRunAction,
): TranscriptionRunState {
  switch (action.type) {
    case 'start':
      return applyStart(state, action.id, action.attempt);
    case 'resolve':
      return applyResolve(state, action.id, action.attempt, action.text);
    case 'reject':
      return applyReject(state, action.id, action.attempt, action.error);
    case 'edit':
      return applyEdit(state, action.id, action.text);
    case 'retry':
      return applyRetry(state, action.id);
    case 'pagesSynced':
      return applyPagesSynced(state, action.orderedIds);
    default:
      return state;
  }
}

/**
 * Count the reads a run currently has outstanding — each is one live charge. That
 * is per *request*, not per visible page: a read whose page was trimmed mid-flight
 * (an {@link OrphanedRequest}) is still costing money and still counts, right up
 * until its reply lands.
 */
export function inFlightCount(state: TranscriptionRunState): number {
  let count = state.orphans.length;
  for (const id of state.order) {
    const block = state.blocks[id];
    if (block && block.status === 'inFlight') count += 1;
  }
  return count;
}

/**
 * The ids to start reading right now: `pending` pages in session order, capped so
 * the run never exceeds {@link TRANSCRIBE_CONCURRENCY} in flight. Because it only
 * ever returns `pending` ids, the loop can never recharge a `done` page.
 *
 * A terminal failure stops the fan-out as well as the retry button. The kinds in
 * {@link TERMINAL_ERROR_KINDS} are properties of the key or the model, not of the
 * page that happened to hit them first, so every page still queued behind one is
 * already doomed — and each would cost its own charge and rollback to prove it.
 * Closing only the per-page Retry would leave a five-page run firing four more
 * calls the moment page one came back with a spent balance.
 */
export function selectStartable(state: TranscriptionRunState): string[] {
  if (hasTerminalError(state)) return [];
  const capacity = TRANSCRIBE_CONCURRENCY - inFlightCount(state);
  if (capacity <= 0) return [];
  const startable: string[] = [];
  for (const id of state.order) {
    if (startable.length >= capacity) break;
    const block = state.blocks[id];
    if (block && block.status === 'pending') startable.push(id);
  }
  return startable;
}

/** How many of `pages` have landed their text (a failed page does not count). */
function doneCount(state: TranscriptionRunState, pages: readonly PageRef[]): number {
  let count = 0;
  for (const page of pages) {
    const block = state.blocks[page.id];
    if (block && block.status === 'done') count += 1;
  }
  return count;
}

/**
 * Whether every remaining page has settled into `done`. `pages` is authoritative:
 * a page trimmed from the session no longer holds the run back. An empty session
 * is never "complete" — there is nothing to save.
 */
export function isRunComplete(state: TranscriptionRunState, pages: readonly PageRef[]): boolean {
  if (pages.length === 0) return false;
  return doneCount(state, pages) === pages.length;
}

/** The running progress line, e.g. `Transcribing 2 of 5…` (the ellipsis is copy). */
export function progressLabel(state: TranscriptionRunState, pages: readonly PageRef[]): string {
  return `Transcribing ${doneCount(state, pages)} of ${pages.length}…`;
}

/**
 * Whether any page has failed with a terminal, config-level kind (see
 * {@link TERMINAL_ERROR_KINDS}). When true, the screen surfaces a hand-typed
 * offramp rather than leaving the writer to retry a call that cannot succeed.
 */
export function hasTerminalError(state: TranscriptionRunState): boolean {
  return state.order.some((id) => {
    const block = state.blocks[id];
    return (
      block?.status === 'failed' && block.error !== null && TERMINAL_ERROR_KINDS.has(block.error)
    );
  });
}

/**
 * The one editable entry: every `done` page's text, in session order, joined by a
 * blank line. Hand edits win (they live in the block's text), and pages without a
 * landed read are simply skipped — no placeholders, no page markers.
 */
export function mergeBlocks(state: TranscriptionRunState, pages: readonly PageRef[]): string {
  const texts: string[] = [];
  for (const page of pages) {
    const block = state.blocks[page.id];
    if (block && block.status === 'done') texts.push(block.text);
  }
  return texts.join(BLOCK_SEPARATOR);
}
