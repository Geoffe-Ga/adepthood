import {
  getActiveUser,
  getActiveUserGeneration,
  isAccountScopeCurrent,
  isActiveUserTransitioning,
} from '../storage/userScope';

let tokenGetter: (() => string | null) | null = null;

export function installSessionTokenGetter(getter: (() => string | null) | null): void {
  tokenGetter = getter;
}

/** Keep every request in a multi-step mutation on its initiating credential. */
export function captureSessionToken(): string | undefined {
  if (isActiveUserTransitioning()) return undefined;
  return tokenGetter?.() ?? undefined;
}

/**
 * Which authentication session is live (#3326). It moves when a session ends
 * or begins (reauthentication entry, sign-out, every fresh sign-in) and never
 * on a token refresh, so a value captured with a mutation tells "the same
 * session, renewed" apart from "a new session of the same account", which the
 * account generation cannot: the same account signing back in leaves it alone.
 */
let authSession = 0;

/** Mark a session boundary: work captured before it belongs to no live session. */
export function beginAuthSession(): void {
  authSession += 1;
}

export function getAuthSession(): number {
  return authSession;
}

/** The account and authentication session a piece of work was captured under (#3423). */
export interface AuthScope {
  readonly owner: number | null;
  readonly generation: number;
  readonly session: number;
}

export function captureAuthScope(): AuthScope {
  return { owner: getActiveUser(), generation: getActiveUserGeneration(), session: authSession };
}

/**
 * Whether work captured as ``scope`` may still land: the account scope holds
 * (``isAccountScopeCurrent``) and no session boundary has passed since. The
 * same account signing back in after a 401 leaves the account scope alone, so
 * only the session term refuses the ended session's late answers; a token
 * refresh moves neither and keeps them.
 */
export function isAuthScopeCurrent({ owner, generation, session }: AuthScope): boolean {
  return isAccountScopeCurrent(owner, generation) && session === authSession;
}

/**
 * Whether ``scope`` is refused only because its session ended: the same
 * account is still live in a later session. Its answer must not land, but the
 * surface that issued it still belongs to that account and is still on
 * screen, so it may let go of its spinner or pending mark and offer a retry.
 */
export function hasOnlySessionEnded({ owner, generation, session }: AuthScope): boolean {
  return isAccountScopeCurrent(owner, generation) && session !== authSession;
}

/**
 * Capture, at dispatch, the scope a credential-less request is sent under, and
 * return whether a 401 on it may still speak for "there is no session" (#3366).
 *
 * During an account transition ``captureSessionToken`` answers ``undefined``
 * for everyone, so a default-token request goes out anonymous because the
 * transition made it so, not because nobody is signed in. Its 401 is about no
 * session at all, and once the scope has moved (a wipe began or ended, another
 * account was adopted) it is not about the session that holds the device now
 * either. Only an anonymous request sent and failed in one settled scope may
 * report ``not_authenticated``.
 */
export function captureAnonymousScope(): () => boolean {
  const generation = getActiveUserGeneration();
  const synthetic = isActiveUserTransitioning();
  return () =>
    !synthetic && !isActiveUserTransitioning() && generation === getActiveUserGeneration();
}
