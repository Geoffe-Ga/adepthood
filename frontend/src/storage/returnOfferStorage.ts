import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';

export interface ReturnOfferIdentity {
  readonly userId: number;
  /** Opaque identity observed on the server; never reconstructed from a stage. */
  readonly episode: string;
}

const KEY_BASE = '@adepthood/return_offer_dismissed';
const MAX_EPISODE_LENGTH = 128;

function storageKey(identity: ReturnOfferIdentity): string {
  const { userId, episode } = identity;
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Return account is unknown');
  if (typeof episode !== 'string' || episode.length === 0 || episode.length > MAX_EPISODE_LENGTH) {
    throw new Error('Return offer episode is unknown');
  }
  return `${KEY_BASE}#u${userId}#e${encodeURIComponent(episode)}`;
}

/** Capture both fields before awaiting storage. The old global boolean is
 * deliberately untouched: even a known prior account cannot prove its episode. */
export async function saveReturnOfferDismissed(
  identity: ReturnOfferIdentity,
  value: boolean,
): Promise<void> {
  const key = storageKey(identity);
  try {
    await AsyncStorage.setItem(key, String(value));
  } catch (error) {
    reportDiagnostic('storage_write_failed', { storage: 'return_offer' });
    throw error;
  }
}

export async function loadReturnOfferDismissed(identity: ReturnOfferIdentity): Promise<boolean> {
  const key = storageKey(identity);
  try {
    return (await AsyncStorage.getItem(key)) === 'true';
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'return_offer' });
    return false;
  }
}
