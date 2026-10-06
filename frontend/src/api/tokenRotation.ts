/**
 * Session token rotation: one keyed refresh coalescer plus a memory of the
 * rotations this session has already performed (#3034).
 *
 * ``POST /auth/refresh`` revokes the token it was called with before it mints
 * the successor, and it is limited to one call a minute. So once ``A`` has
 * been refreshed to ``B``, ``A`` is dead on the server, and asking to refresh
 * it again earns a 401 (or the limiter's 429) that used to sign the user out.
 * Several things can ask: the resumed-session timezone backfill, both arms of
 * the proactive refresh, and every request that 401s. This module is the one
 * place they all go through, so
 *
 *  - a refresh of ``A`` that is already in flight is joined, not repeated;
 *  - a refresh of ``A`` that already happened is answered from memory, with no
 *    network call, because the client never re-sends a token it knows rotated;
 *  - a token that is neither current nor known is never sent to the server;
 *  - a failure for a token that the session has already moved past is reported
 *    as *superseded*, not as an expired session.
 *
 * It is pure and dependency-injected — it knows nothing about ``fetch`` or
 * React — so every branch is reachable from a unit test.
 */

/**
 * How many rotations a session remembers. A rotation only needs remembering
 * for as long as a request carrying the old token can still be in flight, so
 * the chain stays short; the cap bounds both the ledger and the walk along it.
 */
export const MAX_REMEMBERED_ROTATIONS = 8;

/** Minimal shape of a successful refresh: the new token is all this module reads. */
export interface RotatedToken {
  token: string;
}

/** What {@link TokenRotation.refresh} found. */
export type RefreshAttempt<R> =
  /** This call, or the in-flight one it joined, rotated the token. */
  | { kind: 'refreshed'; response: R }
  /** The token was rotated earlier; ``token`` is its latest successor. */
  | { kind: 'rotated'; token: string }
  /** The token is neither the session's current one nor a known predecessor. */
  | { kind: 'refused' }
  /** The network refresh failed, or resolved for a session that has since ended. */
  | { kind: 'failed' };

/** What a 401 on a request that carried ``sent`` should do next. */
export type SessionRecovery =
  /** Retry once with ``token`` — the current session token ``sent`` became. */
  | { kind: 'rotated'; token: string }
  /** There is no session and the request carried none: an anonymous 401. */
  | { kind: 'no-session' }
  /** The session's current token itself failed to refresh: re-auth needed. */
  | { kind: 'expired' }
  /** The request belongs to a token the session has moved past: no sign-out. */
  | { kind: 'superseded' };

/**
 * Whether recovering from a 401 may start a refresh of its own (``'refresh'``)
 * or may only ride one that is already known or underway (``'join-only'``).
 */
export type RecoveryMode = 'refresh' | 'join-only';

export interface TokenRotationDeps<R extends RotatedToken> {
  /** One network refresh of ``from``; resolves ``null`` on any failure. */
  performRefresh: (from: string) => Promise<R | null>;
  /** The token the session holds right now (before forwarding). */
  currentToken: () => string | null;
  /** Publish a rotation; called once per rotation, after it is recorded. */
  onRotated: (response: R, from: string) => void;
}

export interface TokenRotation<R extends RotatedToken> {
  /** ``token``'s latest known successor, or ``token`` itself. */
  forward: (token: string | null) => string | null;
  /** The session's current token, forwarded through known rotations. */
  current: () => string | null;
  refresh: (from: string) => Promise<RefreshAttempt<R>>;
  /**
   * Decide what a 401 on a request that carried ``sent`` should do. In
   * ``'refresh'`` mode it may start a refresh of the session's current token;
   * in ``'join-only'`` mode it only joins one already in flight or uses a
   * remembered successor, and otherwise reports the token as expired.
   */
  recover: (sent: string | null, mode?: RecoveryMode) => Promise<SessionRecovery>;
  /** Forget every rotation and orphan every in-flight refresh. */
  reset: () => void;
}

/** The mutable state one session's rotation tracking holds. */
interface RotationState<R extends RotatedToken> {
  deps: TokenRotationDeps<R>;
  /** ``old -> new``, insertion-ordered so the first key is the oldest rotation. */
  ledger: Map<string, string>;
  /** The in-flight refresh of each token, keyed by the token being refreshed. */
  inFlight: Map<string, Promise<RefreshAttempt<R>>>;
  /**
   * Bumped by ``reset``: a refresh begun under an older epoch belongs to a
   * session that has ended, so its result is neither recorded nor published.
   */
  epoch: number;
}

function forwardIn<R extends RotatedToken>(
  state: RotationState<R>,
  token: string | null,
): string | null {
  let latest = token;
  for (let hop = 0; hop < MAX_REMEMBERED_ROTATIONS && latest !== null; hop += 1) {
    const next = state.ledger.get(latest);
    if (next === undefined) break;
    latest = next;
  }
  return latest;
}

function currentIn<R extends RotatedToken>(state: RotationState<R>): string | null {
  return forwardIn(state, state.deps.currentToken());
}

function recordIn<R extends RotatedToken>(state: RotationState<R>, from: string, to: string): void {
  // A successor that is already a key would close a cycle; the server never
  // re-issues a revoked token, so refuse rather than trust it.
  if (to === from || state.ledger.has(to)) return;
  state.ledger.set(from, to);
  while (state.ledger.size > MAX_REMEMBERED_ROTATIONS) {
    const oldest = state.ledger.keys().next().value;
    if (oldest === undefined) break;
    state.ledger.delete(oldest);
  }
}

function performIn<R extends RotatedToken>(
  state: RotationState<R>,
  from: string,
): Promise<RefreshAttempt<R>> {
  const startedIn = state.epoch;
  const attempt = state.deps.performRefresh(from).then((response): RefreshAttempt<R> => {
    if (response === null || startedIn !== state.epoch) return { kind: 'failed' };
    // Record BEFORE publishing and before any awaiting caller resumes, so a
    // request built in the very next tick already carries the successor.
    recordIn(state, from, response.token);
    state.deps.onRotated(response, from);
    return { kind: 'refreshed', response };
  });
  state.inFlight.set(from, attempt);
  const settle = (): void => {
    // A reset may have let a newer refresh of the same token take the slot.
    if (state.inFlight.get(from) === attempt) state.inFlight.delete(from);
  };
  attempt.then(settle, settle);
  return attempt;
}

/**
 * What is already known or underway for ``from``: its remembered successor,
 * or the in-flight refresh of it. ``null`` when neither — nothing to join.
 */
function joinIn<R extends RotatedToken>(
  state: RotationState<R>,
  from: string,
): Promise<RefreshAttempt<R>> | null {
  const successor = forwardIn(state, from);
  if (successor !== null && successor !== from) {
    return Promise.resolve({ kind: 'rotated', token: successor });
  }
  return state.inFlight.get(from) ?? null;
}

function refreshIn<R extends RotatedToken>(
  state: RotationState<R>,
  from: string,
): Promise<RefreshAttempt<R>> {
  const known = joinIn(state, from);
  if (known !== null) return known;
  if (from !== currentIn(state)) return Promise.resolve({ kind: 'refused' });
  return performIn(state, from);
}

async function recoverIn<R extends RotatedToken>(
  state: RotationState<R>,
  sent: string | null,
  mode: RecoveryMode,
): Promise<SessionRecovery> {
  if (sent === null) {
    // An anonymous request that 401s is only "no session" while there still
    // is none; if a sign-in landed meanwhile it is simply out of date.
    return currentIn(state) === null ? { kind: 'no-session' } : { kind: 'superseded' };
  }
  const attempt =
    mode === 'refresh'
      ? await refreshIn(state, sent)
      : await (joinIn(state, sent) ?? Promise.resolve<RefreshAttempt<R>>({ kind: 'refused' }));
  const live = currentIn(state);
  if (attempt.kind === 'refreshed' || attempt.kind === 'rotated') {
    // Only a successor the session still holds may carry the retry: after a
    // sign-out and a different sign-in, ``sent``'s successor is another
    // session's token and must never be borrowed.
    const successor = forwardIn(state, sent);
    return successor !== null && successor === live
      ? { kind: 'rotated', token: successor }
      : { kind: 'superseded' };
  }
  return sent === live ? { kind: 'expired' } : { kind: 'superseded' };
}

export function createTokenRotation<R extends RotatedToken>(
  deps: TokenRotationDeps<R>,
): TokenRotation<R> {
  const state: RotationState<R> = { deps, ledger: new Map(), inFlight: new Map(), epoch: 0 };
  return {
    forward: (token) => forwardIn(state, token),
    current: () => currentIn(state),
    refresh: (from) => refreshIn(state, from),
    recover: (sent, mode = 'refresh') => recoverIn(state, sent, mode),
    reset: () => {
      state.epoch += 1;
      state.ledger.clear();
      state.inFlight.clear();
    },
  };
}
