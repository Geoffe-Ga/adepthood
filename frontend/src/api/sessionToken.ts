import { getActiveUserGeneration, isActiveUserTransitioning } from '../storage/userScope';

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
