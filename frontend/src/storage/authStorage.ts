/**
 * Auth token persistence — a thin wrapper over the shared secure-string store.
 *
 * The native-Keychain / web-localStorage fallback, the trim/reject-empty guard,
 * and the web XSS-window tradeoff (BUG-FE-AUTH-007) all live in
 * ``secureStringStore.ts`` — read that file's header for the security rationale
 * and the httpOnly-cookie migration plan before touching the web path.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createSecureStringStore } from './secureStringStore';

// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so we cannot use the `@adepthood/...` namespace prefix here.
const TOKEN_KEY = 'adepthood_auth_token';

export class EmptyAuthTokenError extends Error {
  constructor() {
    super('auth token cannot be empty');
    this.name = 'EmptyAuthTokenError';
  }
}

// BUG-FE-AUTH-007: the auth token's web-fallback accepted-risk site. The
// localStorage persistence physically lives in secureStringStore.ts; this
// marker keeps ``git grep BUG-FE-AUTH-007`` pointing at the auth store.
const tokenStore = createSecureStringStore(TOKEN_KEY, EmptyAuthTokenError);

export async function saveToken(token: string): Promise<void> {
  await tokenStore.save(token);
}

export async function loadToken(): Promise<string | null> {
  return tokenStore.load();
}

export async function clearToken(): Promise<void> {
  await tokenStore.clear();
}

// BUG-FE-STATE-001: a logout-pending marker, always AsyncStorage-backed on
// both platforms. It is deliberately independent of the SecureStore JWT store
// so a SecureStore delete outage can't also strand the marker on native; it
// holds no secret, so it adds no BUG-FE-AUTH-007 XSS surface.
const LOGOUT_PENDING_KEY = '@adepthood/logout_pending';
const FLAG_TRUE = 'true';

/** Arm the marker so a failed ``clearToken`` is retried on the next launch. */
export async function markLogoutPending(): Promise<void> {
  await AsyncStorage.setItem(LOGOUT_PENDING_KEY, FLAG_TRUE);
}

/** Read the marker; non-throwing so a transient read blip never logs out a legit user. */
export async function isLogoutPending(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LOGOUT_PENDING_KEY);
    return raw === FLAG_TRUE;
  } catch (err) {
    console.warn('[authStorage] failed to read logout-pending marker', err);
    return false;
  }
}

/** Disarm the marker once the stale token clears or a fresh auth supersedes it. */
export async function clearLogoutPending(): Promise<void> {
  await AsyncStorage.removeItem(LOGOUT_PENDING_KEY);
}

/**
 * The IANA zone the server last confirmed for the signed-in user (#2847).
 *
 * A session is not resumable from the token alone. Every "today" the app shows
 * -- a habit's done state, its streak chip, the journal shelf's done-count --
 * is bucketed in the user's own calendar, and the JWT carries no ``timezone``
 * claim (see ``_create_token`` in ``backend/src/routers/auth.py``). Before this
 * slot existed, a cold start from a stored token ran on the ``"UTC"`` default
 * until something refreshed the token -- for a 30-day token renewed at its
 * half-life, up to fifteen days. West of UTC that buckets yesterday evening's
 * completion into today, so the tile reads "ACHIEVED TODAY!" and the star tap
 * refuses a further log; the only remedy a user could find was to log out and
 * back in, which is the one path that carried the zone.
 *
 * What is cached here is the *server's* record, not a reading of the device
 * clock, so the rule that the stored zone is the only source (#261) still
 * holds: this reads back what the server said, it does not guess.
 *
 * AsyncStorage rather than the secure store, like the logout-pending marker:
 * a zone is not a secret, so it adds no BUG-FE-AUTH-007 XSS surface. Both
 * sides are non-throwing, because a cache that fails to write must never break
 * a sign-in and a cache that fails to read must never break a resume.
 */
const USER_TIMEZONE_KEY = '@adepthood/user_timezone';

/** Cache a server-confirmed zone. Never rejects; a failed write only costs a backfill. */
export async function saveUserTimezone(timezone: string): Promise<void> {
  try {
    await AsyncStorage.setItem(USER_TIMEZONE_KEY, timezone);
  } catch (err) {
    console.warn('[authStorage] failed to cache the user timezone', err);
  }
}

/**
 * Read the cached zone, or ``null`` when there is none to trust.
 *
 * Blank input is ``null`` rather than ``""``: an empty string is not a zone,
 * and handing one to the date helpers would silently fall back to the
 * runtime's own calendar -- the source #261 forbids.
 */
export async function loadUserTimezone(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_TIMEZONE_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  } catch (err) {
    console.warn('[authStorage] failed to read the cached user timezone', err);
    return null;
  }
}

/** Drop the cached zone — the device changing hands must not hand over a calendar. */
export async function clearUserTimezone(): Promise<void> {
  await AsyncStorage.removeItem(USER_TIMEZONE_KEY);
}
