import AsyncStorage from '@react-native-async-storage/async-storage';

import { reportDiagnostic } from '@/observability/diagnostics';

/**
 * A program start date the person picked that never reached the server (#3097).
 *
 * A first-run scaffolding pick made offline has no earlier date to fall back
 * on, so it is held here -- as the YYYY-MM-DD the person chose, in the account
 * zone -- and sent again by the next session's reconcile. Without it the
 * server's default stamp would silently replace the pick on the next launch.
 *
 * The key is device-wide, so the record names the account that made the pick
 * and the reconcile replays it only for that account (#3097 re-review): one
 * account's date is never sent to another's server. It also records the
 * server's anchor the device knew when the pick was held, so a date chosen
 * since on another device is not overwritten by a stale replay.
 */
const PENDING_PROGRAM_START_KEY = '@adepthood/pending_program_start_day';

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HeldProgramStart {
  /** The account that made the pick, as ``getActiveUser()`` named it; null when anonymous. */
  readonly owner: number | null;
  /** The day picked, ``YYYY-MM-DD`` in the account zone. */
  readonly day: string;
  /** The server's anchor day the device held when the pick was made; null for a first pick. */
  readonly priorServerDay: string | null;
}

const isDayKey = (value: unknown): value is string =>
  typeof value === 'string' && DAY_KEY_RE.test(value);

const isOwner = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0);

/** The record as written, or null for anything this module did not write. */
const parseHeld = (raw: string): HeldProgramStart | null => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { owner, day, priorServerDay } = parsed as Record<string, unknown>;
  if (!isOwner(owner) || !isDayKey(day)) return null;
  if (priorServerDay !== null && !isDayKey(priorServerDay)) return null;
  return { owner, day, priorServerDay };
};

export async function savePendingProgramStart(held: HeldProgramStart): Promise<void> {
  await AsyncStorage.setItem(PENDING_PROGRAM_START_KEY, JSON.stringify(held));
}

/** The held pick, or null when there is none (or it cannot be read). */
export async function loadPendingProgramStart(): Promise<HeldProgramStart | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_PROGRAM_START_KEY);
    return raw === null ? null : parseHeld(raw);
  } catch {
    reportDiagnostic('storage_read_failed', { storage: 'program' });
    return null;
  }
}

export async function clearPendingProgramStart(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_PROGRAM_START_KEY);
}
