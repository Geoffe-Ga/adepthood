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
