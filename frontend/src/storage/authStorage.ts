/**
 * Auth token persistence — native keychain on iOS/Android, localStorage on web.
 *
 * SECURITY NOTE — BUG-FE-AUTH-007 (web XSS-window risk).
 * --------------------------------------------------------
 * On the web platform this module persists the JWT in ``localStorage``
 * (via ``AsyncStorage``).  ``localStorage`` is fully readable by any
 * JavaScript that runs on the same origin — including injected XSS — so a
 * single successful XSS exploit on the web build yields full account
 * takeover (the attacker copies the token and replays it from anywhere
 * until the user logs out or it expires).  This is a deliberate, audited
 * tradeoff:
 *
 *   * ``expo-secure-store`` v55 ships no web implementation (its web
 *     module is literally ``export default {}``), so the secure path
 *     simply does not exist on web.
 *   * The native build is unaffected: iOS uses Keychain, Android uses
 *     Keystore, both isolated from RN JS context.
 *   * The proper long-term fix is moving the web build to an
 *     httpOnly + SameSite=Strict session cookie issued by the backend so
 *     the JWT never touches JS at all.  That requires backend cookie/CSRF
 *     wiring and a session refresh endpoint and is tracked as a separate
 *     post-MVP epic.
 *
 * Mitigations IN this file — KEEP these together so a future contributor
 * who removes one immediately sees the others:
 *
 *   1. ``isWeb`` branches keep the localStorage path strictly OFF on
 *      native (where Keychain works).
 *   2. Each web call site carries an inline ``BUG-FE-AUTH-007`` marker
 *      comment so ``git grep BUG-FE-AUTH-007`` enumerates every
 *      accepted-risk site for audit.  Any new web persistence path that
 *      bypasses this file is grounds for review rejection (see
 *      ``frontend/SECURITY.md``).
 *   3. ``frontend/SECURITY.md`` documents the threat model and the
 *      migration plan; reviewers should reject changes that move web
 *      tokens *out* of ``AsyncStorage`` into something even more
 *      JS-readable (e.g. a global window prop) without raising the
 *      concern there.
 *
 * DO NOT remove this comment block when refactoring this file.  If the
 * web build moves to cookies, delete the ``isWeb`` branch entirely; do
 * not silently switch to a different JS-readable store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so we cannot use the `@adepthood/...` namespace prefix here.
const TOKEN_KEY = 'adepthood_auth_token';

// ``expo-secure-store`` v55 has no web implementation — its web module is
// literally ``export default {}``, so calling ``SecureStore.setItemAsync``
// throws ``TypeError: … is not a function`` and every auth attempt in the
// Expo Web build fails with the generic signup fallback copy. On web we
// fall back to ``AsyncStorage`` (which resolves to ``localStorage``) so
// the flow works end-to-end. Native keeps using Keychain/Keystore.
//
// SECURITY: see the file-header note above for the XSS risk this fallback
// accepts and the long-term migration plan (httpOnly session cookie).
const isWeb = Platform.OS === 'web';

export class EmptyAuthTokenError extends Error {
  constructor() {
    super('auth token cannot be empty');
    this.name = 'EmptyAuthTokenError';
  }
}

export async function saveToken(token: string): Promise<void> {
  // BUG-FE-STORAGE-004: trim and reject empty / whitespace-only tokens
  // at the boundary.  Without this, an accidental save (e.g. a stale
  // ``''`` returned by a malformed refresh response that slipped past
  // the Zod gate -- BUG-API-007 closed it, this is defence in depth)
  // would silently clear the previous valid token and bounce the user
  // to the login screen.
  const trimmed = token.trim();
  if (!trimmed) throw new EmptyAuthTokenError();
  if (isWeb) {
    // BUG-FE-AUTH-007: web persists to localStorage — XSS risk accepted
    // until the backend httpOnly-cookie session migration ships.  See the
    // file-header note for context.  Reviewers: any new web persistence
    // path here MUST go through the same ``isWeb`` branch (or be replaced
    // by a cookie-based session).
    await AsyncStorage.setItem(TOKEN_KEY, trimmed);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, trimmed);
}

export async function loadToken(): Promise<string | null> {
  // BUG-FE-AUTH-007: web reads from localStorage — see the file-header note.
  if (isWeb) return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  if (isWeb) {
    // BUG-FE-AUTH-007: web clears localStorage — see the file-header note.
    await AsyncStorage.removeItem(TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
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
