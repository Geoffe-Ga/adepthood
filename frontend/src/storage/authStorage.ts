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
