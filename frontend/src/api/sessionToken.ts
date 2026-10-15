import { isActiveUserTransitioning } from '../storage/userScope';

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
