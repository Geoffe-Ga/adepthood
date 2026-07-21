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
 * Failure kinds no per-page gesture can clear: the configured model simply cannot
 * read images at all, so a retry would only re-charge the wallet to fail again.
 * The screen offers a hand-typed offramp instead of a per-block retry for these.
 */
export const TERMINAL_ERROR_KINDS: ReadonlySet<TranscriptionErrorKind> =
  new Set<TranscriptionErrorKind>(['model_lacks_vision']);

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

/** The whole run: the session's start-priority order and the keyed blocks. */
export interface TranscriptionRunState {
  order: string[];
  blocks: Record<string, TranscriptionBlock>;
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
 *                    page that leaves the session (its late reply becomes inert).
 */
export type TranscriptionRunAction =
  | { type: 'start'; id: string; attempt: number }
  | { type: 'resolve'; id: string; attempt: number; text: string }
  | { type: 'reject'; id: string; attempt: number; error: TranscriptionErrorKind }
  | { type: 'edit'; id: string; text: string }
  | { type: 'retry'; id: string }
  | { type: 'pagesSynced'; orderedIds: readonly string[] };

/** A brand-new page, waiting its turn. */
function pendingBlock(id: string): TranscriptionBlock {
  return { id, status: 'pending', text: '', edited: false, attempt: FIRST_ATTEMPT, error: null };
}

/** Return a new state with one block replaced (order untouched). */
function withBlock(
  state: TranscriptionRunState,
  id: string,
  next: TranscriptionBlock,
): TranscriptionRunState {
  return { order: state.order, blocks: { ...state.blocks, [id]: next } };
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
 * `pagesSynced`: make the session's page list authoritative for order and
 * membership. Existing blocks are preserved as-is (a `done` page stays done), ids
 * new to the run enter `pending`, and ids no longer present are dropped — which is
 * exactly what a fresh run (from the empty state), a retake (an id swapped in place),
 * or an in-run removal each need. A dropped page's late reply is inert (no block).
 */
function applyPagesSynced(
  state: TranscriptionRunState,
  orderedIds: readonly string[],
): TranscriptionRunState {
  const blocks: Record<string, TranscriptionBlock> = {};
  for (const id of orderedIds) {
    blocks[id] = state.blocks[id] ?? pendingBlock(id);
  }
  return { order: [...orderedIds], blocks };
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

/** Count the pages a run currently has in flight (each is one live charge). */
function inFlightCount(state: TranscriptionRunState): number {
  let count = 0;
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
 */
export function selectStartable(state: TranscriptionRunState): string[] {
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
