/**
 * Secure single-string store — native keychain on iOS/Android, localStorage
 * on web. Shared factory behind the auth-token and BYOK LLM-key stores; each
 * previously carried a byte-identical copy of this SecureStore/AsyncStorage
 * fallback, trim/reject-empty guard, and dedicated Empty*Error.
 *
 * SECURITY NOTE — BUG-FE-AUTH-007 (web XSS-window risk).
 * --------------------------------------------------------
 * On the web platform this module persists the secret in ``localStorage``
 * (via ``AsyncStorage``).  ``localStorage`` is fully readable by any
 * JavaScript that runs on the same origin — including injected XSS — so a
 * single successful XSS exploit on the web build can exfiltrate the stored
 * secret (e.g. the JWT copied and replayed from anywhere until the user logs
 * out or it expires).  This is a deliberate, audited tradeoff:
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
 *   1. The ``isWeb`` branch keeps the localStorage path strictly OFF on
 *      native (where Keychain works).
 *   2. Each web call site carries an inline ``BUG-FE-AUTH-007`` marker
 *      comment so ``git grep BUG-FE-AUTH-007`` enumerates every
 *      accepted-risk site for audit.  Any new web persistence path that
 *      bypasses this file is grounds for review rejection (see
 *      ``frontend/SECURITY.md``).
 *   3. ``frontend/SECURITY.md`` documents the threat model and the
 *      migration plan; reviewers should reject changes that move web
 *      secrets *out* of ``AsyncStorage`` into something even more
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

// ``expo-secure-store`` v55 has no web implementation — its web module is
// literally ``export default {}``, so calling ``SecureStore.setItemAsync``
// throws ``TypeError: … is not a function``. On web we fall back to
// ``AsyncStorage`` (which resolves to ``localStorage``) so the flow works
// end-to-end; native keeps using Keychain/Keystore. Evaluated once at module
// scope to match the original per-store semantics.
//
// SECURITY: see the file-header note above for the XSS risk this fallback
// accepts and the long-term migration plan (httpOnly session cookie).
const isWeb = Platform.OS === 'web';

/** A device-local store for a single trimmed, non-empty secret string. */
export interface SecureStringStore {
  save(value: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}

/**
 * Build a {@link SecureStringStore} for ``storageKey``, throwing an instance of
 * ``EmptyErrorCtor`` when asked to save empty / whitespace-only input.
 */
export function createSecureStringStore(
  storageKey: string,
  EmptyErrorCtor: new () => Error,
): SecureStringStore {
  return {
    async save(value: string): Promise<void> {
      // BUG-FE-STORAGE-004: trim and reject empty / whitespace-only input at
      // the boundary. Without this, an accidental save (e.g. a stale ``''`` or
      // a paste of ``"  sk-...  "``) would silently clear the previous valid
      // value — bouncing the user to login, or producing a 401-guaranteed
      // empty Bearer header on the next call. Defence in depth at the store.
      const trimmed = value.trim();
      if (!trimmed) throw new EmptyErrorCtor();
      if (isWeb) {
        // BUG-FE-AUTH-007: web persists to localStorage — XSS risk accepted
        // until the backend httpOnly-cookie session migration ships. See the
        // file-header note. Reviewers: any new web persistence path MUST go
        // through this same ``isWeb`` branch (or be replaced by a cookie).
        await AsyncStorage.setItem(storageKey, trimmed);
        return;
      }
      await SecureStore.setItemAsync(storageKey, trimmed);
    },

    async load(): Promise<string | null> {
      // BUG-FE-AUTH-007: web reads from localStorage — see the file-header
      // note. No try/catch: a read rejection propagates unchanged so callers
      // (and the store's own consumers) see the true failure.
      if (isWeb) return AsyncStorage.getItem(storageKey);
      return SecureStore.getItemAsync(storageKey);
    },

    async clear(): Promise<void> {
      if (isWeb) {
        // BUG-FE-AUTH-007: web clears localStorage — see the file-header note.
        await AsyncStorage.removeItem(storageKey);
        return;
      }
      await SecureStore.deleteItemAsync(storageKey);
    },
  };
}
