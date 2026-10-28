import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';
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

/**
 * The device-owner stamp. Deliberately NOT itself scoped — it is the thing
 * that decides what the scope is — and deliberately not cleared on logout: a
 * stamp that survives the sign-out lets the *next* sign-in still recognise a
 * change of owner and re-run the wipe, which is the safety net for a logout
 * whose storage clears partly failed.
 */
export const DEVICE_OWNER_KEY = '@adepthood/device_owner';

/**
 * Separator between a cache key and its owner. ``#`` cannot appear in the
 * ``@adepthood/...`` keys this codebase writes, so a scoped key can never
 * collide with an unscoped one — including the legacy unscoped rows written
 * before this module existed.
 */
const SCOPE_MARKER = '#u';

let activeUserId: number | null = null;
let activeUserGeneration = 0;
let activeUserTransitioning = false;

export function getActiveUserGeneration(): number {
  return activeUserGeneration;
}
const activeUserListeners = new Set<() => void>();

export function subscribeActiveUser(listener: () => void): () => void {
  activeUserListeners.add(listener);
  return () => {
    activeUserListeners.delete(listener);
  };
}

function notifyActiveUserListeners(): void {
  activeUserListeners.forEach((listener) => listener());
}

/**
 * Point the device-local caches at ``userId``'s namespace, or at the legacy
 * unscoped namespace when ``null`` (anonymous, and on a device whose owner
 * was never recorded).
 *
 * Committing the scope that ends a cleanup always moves the generation and
 * notifies, even when the owner did not change: mounted consumers spent the
 * cleanup unresolved (#3368), and the final notification is what tells them
 * to read again. A same-owner set with no cleanup in flight stays silent.
 */
export function setActiveUser(userId: number | null): void {
  const endingTransition = activeUserTransitioning;
  activeUserTransitioning = false;
  if (activeUserId === userId && !endingTransition) return;
  activeUserId = userId;
  activeUserGeneration += 1;
  notifyActiveUserListeners();
}

/**
 * Reject old and newly-started authenticated work until cleanup commits its scope.
 *
 * The namespace deliberately stays on the departing account so the clears
 * still running reach its rows; only the generation moves. Subscribers are
 * told at once (#3368), so mounted UI drops the outgoing account's answers
 * and shows itself unresolved instead of offering controls whose taps the new
 * generation would silently refuse.
 */
export function beginActiveUserTransition(): void {
  activeUserTransitioning = true;
  activeUserGeneration += 1;
  notifyActiveUserListeners();
}

export function isActiveUserTransitioning(): boolean {
  return activeUserTransitioning;
}

/** The account the cache keys currently resolve to, or ``null`` when anonymous. */
export function getActiveUser(): number | null {
  return activeUserId;
}

/**
 * Whether work captured under ``owner`` at ``epoch`` may still land.
 *
 * The owner alone is not enough: an A to B to A switch puts A back in charge,
 * and A's old read must still be refused, so the generation is checked too.
 * Nothing is current while cleanup runs: the namespace still names the
 * departing account, so work captured at the cleanup generation would read or
 * write rows that are being wiped.
 */
export function isAccountScopeCurrent(owner: number | null, epoch: number): boolean {
  return !activeUserTransitioning && activeUserId === owner && activeUserGeneration === epoch;
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
 * The single definition of "this value names an account".
 *
 * Two independent sources claim to name the device's owner — the persisted
 * stamp and the ``sub`` claim of the session's own JWT — and they must agree
 * on what counts as a usable id, or a value one accepts and the other rejects
 * becomes a namespace mismatch. ``unknown`` in, because a decoded JWT claim is
 * whatever the payload happened to hold.
 */
export function parseUserId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The outcome of reading the device-owner stamp: either the stamp was read
 * (and ``owner`` is what it positively names, ``null`` for an unstamped or
 * corrupt device), or the read itself failed and nothing is known (#3367).
 */
export type DeviceOwnerLookup =
  { readonly ok: true; readonly owner: number | null } | { readonly ok: false };

/**
 * Read the stamp, keeping a failed read apart from an unstamped device.
 *
 * The two mean different things to anything that persists what it learns: an
 * unstamped device positively has no recorded owner, while a failed read says
 * nothing at all, and recording it as "no owner" would make a transient disk
 * error permanent.
 */
export async function lookupDeviceOwner(): Promise<DeviceOwnerLookup> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(DEVICE_OWNER_KEY);
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'user_scope' });
    return { ok: false };
  }
  return { ok: true, owner: parseUserId(raw) };
}

/**
 * Read the recorded owner of this device's caches.
 *
 * Returns ``null`` for "no owner positively established" — an unstamped
 * device, a corrupt value, or a transient read failure alike. Callers must
 * treat ``null`` as *not* a match for the incoming user: a read blip that
 * reported the wrong owner would otherwise skip the wipe, which is the whole
 * failure this module exists to prevent. Anything that persists the answer
 * must use ``lookupDeviceOwner`` instead, which keeps a failed read apart.
 *
 * This is the input to the *wipe decision* only. It is deliberately not the
 * input to the namespace decision for a session already in hand: the stamp is
 * a second persisted value that can fall out of step with the token, and a
 * session must take its namespace from the credential it is actually holding.
 */
export async function loadDeviceOwner(): Promise<number | null> {
  const lookup = await lookupDeviceOwner();
  return lookup.ok ? lookup.owner : null;
}

/** Record ``userId`` as the owner of this device's caches. */
export async function saveDeviceOwner(userId: number): Promise<void> {
  await AsyncStorage.setItem(DEVICE_OWNER_KEY, String(userId));
}
