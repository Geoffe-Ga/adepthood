/**
 * Which account the device-local caches belong to.
 *
 * BUG-FE-STATE-001 was originally armed on one door only: ``wipeUserState``
 * ran on logout, so a device whose owner changed *without* an explicit logout
 * — a password reset, or any path that reaches the login screen with a live
 * cache on disk — handed the incoming user the previous user's habits, unsent
 * check-in queue and BYOK key. This module supplies the two halves of the
 * other door:
 *
 *   1. **Identity.** ``loadDeviceOwner`` / ``saveDeviceOwner`` persist the id
 *      of the account whose rows are currently on this device, so a sign-in
 *      can tell "a different person is arriving" from "the same person is
 *      re-authenticating". The distinction matters: the pending check-in
 *      queue is unsent work, and dropping it on every sign-in would lose data
 *      the user believes they logged.
 *   2. **Namespacing.** ``scopedKey`` suffixes each cache key with the active
 *      account, so a wipe that a future code path forgets to run still cannot
 *      surface one account's rows to another — the incoming session simply
 *      reads a different key.
 *
 * The scope is process-local module state rather than React state on purpose:
 * the storage modules are plain async functions called from services and
 * hooks alike, and threading a user id through every one of them would put
 * the burden of remembering on exactly the call sites that already forgot.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The device-owner stamp. Deliberately NOT itself scoped — it is the thing
 * that decides what the scope is — and deliberately not cleared on logout: a
 * stamp that survives the sign-out lets the *next* sign-in still recognise a
 * change of owner and re-run the wipe, which is the safety net for a logout
 * whose storage clears partly failed.
 */
const DEVICE_OWNER_KEY = '@adepthood/device_owner';

/**
 * Separator between a cache key and its owner. ``#`` cannot appear in the
 * ``@adepthood/...`` keys this codebase writes, so a scoped key can never
 * collide with an unscoped one — including the legacy unscoped rows written
 * before this module existed.
 */
const SCOPE_MARKER = '#u';

let activeUserId: number | null = null;

/**
 * Point the device-local caches at ``userId``'s namespace, or at the legacy
 * unscoped namespace when ``null`` (anonymous, and on a device whose owner
 * was never recorded).
 */
export function setActiveUser(userId: number | null): void {
  activeUserId = userId;
}

/** The account the cache keys currently resolve to, or ``null`` when anonymous. */
export function getActiveUser(): number | null {
  return activeUserId;
}

/**
 * Resolve ``base`` against the active account.
 *
 * Anonymous callers get ``base`` verbatim. That is not an oversight: no
 * user-scoped read happens while anonymous, so the bare key is a namespace
 * no signed-in session ever reads — which is precisely the isolation we want
 * for a stray anonymous write, and for the pre-namespacing rows already on
 * upgraded devices.
 */
export function scopedKey(base: string): string {
  return activeUserId === null ? base : `${base}${SCOPE_MARKER}${activeUserId}`;
}

/**
 * Read the recorded owner of this device's caches.
 *
 * Returns ``null`` for "no owner positively established" — an unstamped
 * device, a corrupt value, or a transient read failure alike. Callers must
 * treat ``null`` as *not* a match for the incoming user: a read blip that
 * reported the wrong owner would otherwise skip the wipe, which is the whole
 * failure this module exists to prevent.
 */
export async function loadDeviceOwner(): Promise<number | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(DEVICE_OWNER_KEY);
  } catch (err: unknown) {
    console.warn('[userScope] could not read the device-owner stamp', err);
    return null;
  }
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Record ``userId`` as the owner of this device's caches. */
export async function saveDeviceOwner(userId: number): Promise<void> {
  await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(userId));
}
