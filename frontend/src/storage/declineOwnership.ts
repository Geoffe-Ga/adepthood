import AsyncStorage from '@react-native-async-storage/async-storage';

import { getActiveUser, parseUserId } from './userScope';

import { reportDiagnostic } from '@/observability/diagnostics';

/** Persist before replacing the old owner stamp. Null quarantines unknown
 * legacy ownership even after a later successful account sign-in. */
export const LEGACY_DECLINE_OWNER_KEY = '@adepthood/legacy_decline_owner';

export async function preserveLegacyDeclineOwner(previousOwner: number | null): Promise<boolean> {
  try {
    if ((await AsyncStorage.getItem(LEGACY_DECLINE_OWNER_KEY)) === null) {
      await AsyncStorage.setItem(
        LEGACY_DECLINE_OWNER_KEY,
        JSON.stringify({ version: 1, owner: previousOwner }),
      );
    }
    return true;
  } catch {
    // Keep the old device stamp if provenance cannot land. Authentication can
    // still proceed using the credential's own account namespace.
    return false;
  }
}

const keyOperations = new Map<string, Promise<unknown>>();

function serializeKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  keyOperations.set(key, current);
  void current
    .finally(() => {
      if (keyOperations.get(key) === current) keyOperations.delete(key);
    })
    .catch(() => undefined);
  return current;
}

/** Captured key keeps delayed writes in their original account. Sharing the
 * queue with migration means a confirmed restore cannot be overwritten by it. */
export function writeOwnedDeclineKey(
  key: string,
  value: string,
  onlyIfAbsent = false,
): Promise<void> {
  return serializeKey(key, async () => {
    if (onlyIfAbsent && (await AsyncStorage.getItem(key)) !== null) return;
    await AsyncStorage.setItem(key, value);
  });
}

function matchesLegacyOwner(raw: string, owner: number): boolean {
  let provenance: unknown;
  try {
    provenance = JSON.parse(raw);
  } catch {
    return false;
  }
  return (
    typeof provenance === 'object' &&
    provenance !== null &&
    'version' in provenance &&
    provenance.version === 1 &&
    'owner' in provenance &&
    parseUserId(provenance.owner) === owner
  );
}

/** Drop a migrated legacy row, best-effort. Once the scoped copy has landed
 * the row is inert: provenance attributes it to this owner alone, and the
 * scoped value now wins every read, so a failed removal must not cost the
 * decline it just carried over. The bytes simply stay where they were. */
async function discardMigratedLegacy(baseKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(baseKey);
  } catch {
    // Leaving the legacy row is harmless; losing the copied decline is not.
    reportDiagnostic('storage_clear_failed', { storage: 'user_scope' });
  }
}

/**
 * Read ``owner``'s decline, carrying a legacy device-global row over to the
 * owner's scoped key when provenance positively attributes it to them.
 *
 * Recovery contract: any failure BEFORE the scoped copy lands rejects and
 * leaves the legacy row untouched, so the next read retries the migration.
 * Once the copy lands, the decline is durable and is returned even if the
 * legacy row cannot be removed (see ``discardMigratedLegacy``).
 */
export async function readOwnedDecline(
  baseKey: string,
  owner: number | null = getActiveUser(),
): Promise<string | null> {
  const key = owner === null ? baseKey : `${baseKey}#u${owner}`;
  return serializeKey(key, async () => {
    const existing = await AsyncStorage.getItem(key);
    if (existing !== null || owner === null) return existing;
    const rawOwner = await AsyncStorage.getItem(LEGACY_DECLINE_OWNER_KEY);
    if (rawOwner === null) return null;
    if (!matchesLegacyOwner(rawOwner, owner)) return null;
    const legacy = await AsyncStorage.getItem(baseKey);
    if (legacy === null) return null;
    const latest = await AsyncStorage.getItem(key);
    if (latest !== null) return latest;
    await AsyncStorage.setItem(key, legacy);
    await discardMigratedLegacy(baseKey);
    return legacy;
  });
}
