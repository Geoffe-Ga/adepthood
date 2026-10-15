import AsyncStorage from '@react-native-async-storage/async-storage';

import { getActiveUser, parseUserId } from './userScope';

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
    await AsyncStorage.removeItem(baseKey);
    return legacy;
  });
}
