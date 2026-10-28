import { readOwnedDecline, writeOwnedDeclineKey } from './declineOwnership';
import { scopedKey } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';
// Persists a "this reflection invitation was set aside" flag, keyed per
// reflection scope so a decline is honoured across launches for that scope only
// — a later scope (a new week/stage) still surfaces its own fresh invitation.
// Mirrors ``returnOfferStorage.ts``, but scoped rather than global.

const KEY_PREFIX = '@adepthood/reflection_dismissed:';
const FLAG_TRUE = 'true';

/** The AsyncStorage key that isolates one reflection scope's dismissal flag. */
function storageKey(scopeKey: string): string {
  return scopedKey(`${KEY_PREFIX}${scopeKey}`);
}

/** Record (or clear) the dismissal for a single reflection scope. */
export async function saveReflectionDismissed(scopeKey: string, value: boolean): Promise<void> {
  await writeOwnedDeclineKey(storageKey(scopeKey), String(value));
}

/**
 * Whether the invitation for ``scopeKey`` was previously set aside. A storage
 * read failure resolves ``false`` (surface the invitation rather than crash) so
 * a flaky disk never suppresses a genuinely-due reflection.
 */
export async function loadReflectionDismissed(scopeKey: string): Promise<boolean> {
  try {
    const raw = await readOwnedDecline(`${KEY_PREFIX}${scopeKey}`);
    return raw === FLAG_TRUE;
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'reflection_dismissal' });
    return false;
  }
}
