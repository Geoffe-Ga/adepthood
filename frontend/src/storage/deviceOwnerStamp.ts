import { preserveLegacyDeclineOwner } from './declineOwnership';
import { lookupDeviceOwner, saveDeviceOwner } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';

/**
 * The device-owner stamp's write path, and what this process knows when the
 * stamp could not be written (#3333).
 *
 * A sign-in records legacy decline provenance before it may replace the
 * stamp, and leaves the stamp alone when that write rejects: provenance has to
 * name the account that owned the unscoped legacy rows, and once the stamp
 * moves, that account is forgotten. The session still proceeds in its own
 * credential's namespace, so the only casualty is the stamp, which now names
 * the previous account while the live state belongs to the new one.
 *
 * The stamp is the input to the NEXT sign-in's wipe decision. Read alone, a
 * stale stamp turns the same person signing back in into an "account
 * replacement", and ``wipeUserState`` deletes their unscoped BYOK key and
 * resets their in-memory stores; it also lets the account the stamp names
 * sign in over the live session without wiping it. So this module remembers,
 * in process memory, which account the live state belongs to whenever the
 * stamp could not be brought into step, and retries the provenance write (and
 * then the stamp) at every later sign-in and cold start until both land.
 *
 * Provenance is retried with the stamp's own value, never with the live
 * owner's: unattributed legacy rows must stay unattributed, and rows the stale
 * stamp's account wrote must not be handed to whoever happens to be signed in.
 */

/**
 * The account whose state is live in this process but whose stamp has not
 * landed, or ``null`` when the stamp on disk is current. Process memory on
 * purpose: a restart rebuilds it from the resumed token, which is the
 * authority for a session's owner, rather than from a second persisted value
 * that could tear the same way the stamp did.
 */
let unstampedOwner: number | null = null;

/** What a sign-in needs to decide whether the device is changing hands. */
export interface OwnerReading {
  /** The persisted stamp, possibly stale. */
  stamp: number | null;
  /** The account whose state is actually on this device: the wipe decision's input. */
  liveOwner: number | null;
  /** Whether legacy provenance is now recorded, so the stamp may be replaced. */
  provenanceSaved: boolean;
}

/**
 * Read the stamp and make sure legacy provenance is recorded against it.
 *
 * ``liveOwner`` prefers an account this process could not stamp over the
 * stamp itself. A failed read still yields ``null``, which callers treat as
 * "not a match" so a read blip errs toward the wipe.
 *
 * A failed read records no provenance and reports it unsaved (#3367).
 * Provenance is written once and never revisited, so recording the blip as
 * ``owner: null`` would permanently strand the legacy choices of the account
 * the intact stamp names. Reporting it unsaved also keeps the stamp from being
 * replaced, so the retry at the next sign-in or cold start still reads the
 * account that owned the legacy rows -- and no unattributed row is handed to
 * the incoming user meanwhile.
 */
export async function readDeviceOwner(): Promise<OwnerReading> {
  const lookup = await lookupDeviceOwner();
  const stamp = lookup.ok ? lookup.owner : null;
  const provenanceSaved = lookup.ok && (await preserveLegacyDeclineOwner(stamp));
  return { stamp, liveOwner: unstampedOwner ?? stamp, provenanceSaved };
}

/**
 * Record ``userId`` as the owner of this device's caches — and never before
 * that user's token is on disk.
 *
 * A sign-in persists two things, and nothing makes the pair atomic. Stamping
 * first meant a kill (or a rejected write) between them left the device
 * holding one account's JWT under another account's stamp, and because the
 * stamp is what the *next* sign-in compares against, that sign-in then took
 * the "same owner, nothing to wipe" branch. Ordering the token write first
 * makes every torn interleaving safe: the stamp may lag the token.
 *
 * A lag is no longer silent. When provenance has not landed (so the stamp must
 * not move) or the stamp write itself rejects, ``userId`` is remembered as the
 * live owner until a later stamp lands, so the next wipe decision compares
 * against the account that is actually signed in.
 */
export async function stampDeviceOwner(userId: number, provenanceSaved: boolean): Promise<void> {
  unstampedOwner = userId;
  if (!provenanceSaved) return;
  try {
    await saveDeviceOwner(userId);
  } catch {
    reportDiagnostic('auth_storage_failed');
    return;
  }
  // A newer sign-in may have claimed the device while this write was held.
  if (unstampedOwner === userId) unstampedOwner = null;
}

/** Forget the process-local owner, as a real restart does. Tests only. */
export function _resetDeviceOwnerStampForTests(): void {
  unstampedOwner = null;
}
