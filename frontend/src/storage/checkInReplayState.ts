/**
 * The retry record for the head of the pending check-in queue (#2473).
 *
 * One record per account, under ``scopedKey``: which queued entry has been
 * rejected with an unclassified status, how many times, and since when. It
 * lives beside the queue rather than on each queued entry so that counting a
 * rejection never rewrites the queue — a re-queued entry stays byte-identical
 * to what the user tapped — and so the write never touches the queue key the
 * foreground appends to. Only the head is ever retried, so one record is
 * bounded by construction.
 *
 * Fails open in every direction. An unreadable or malformed record reads as
 * "no record", which restarts the count: a storage fault can only delay a
 * give-up, never cause one. Writes never throw, because the caller is the
 * replay loop's own catch block. ``wipeUserState`` clears it on logout and on a
 * change of device owner, since it names the previous user's check-in.
 *
 * Nothing here logs the record: it names a goal and a moment the user acted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

import { serialize } from './serializedWrite';
import { scopedKey } from './userScope';

const CHECKIN_REPLAY_STATE_KEY_BASE = '@adepthood/pending_checkin_replay_state';

const replayHeadStateSchema = z.object({
  identity: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  first_rejected_at: z.string(),
  last_status: z.number().int(),
});

/** How often, and since when, the queue head has been rejected unclassified. */
export type ReplayHeadState = z.infer<typeof replayHeadStateSchema>;

const WARN_READ = '[storage] could not read the check-in replay record; restarting its count';
const WARN_WRITE = '[storage] could not save the check-in replay record';
const WARN_CLEAR = '[storage] could not clear the check-in replay record';

/** This account's replay-record key — also its serialized write lane. */
function replayStateKey(): string {
  return scopedKey(CHECKIN_REPLAY_STATE_KEY_BASE);
}

function parseState(raw: string): ReplayHeadState | null {
  try {
    const parsed = replayHeadStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The head's retry record, or ``null`` when there is none or it is unreadable. */
export async function loadCheckInReplayState(): Promise<ReplayHeadState | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(replayStateKey());
  } catch {
    console.warn(WARN_READ);
    return null;
  }
  return raw === null ? null : parseState(raw);
}

/** Persist the head's retry record. Total: a failed write is logged, not thrown. */
export async function saveCheckInReplayState(state: ReplayHeadState): Promise<void> {
  const key = replayStateKey();
  try {
    await serialize(key, () => AsyncStorage.setItem(key, JSON.stringify(state)));
  } catch {
    console.warn(WARN_WRITE);
  }
}

/** Remove the retry record: the queue drained, gave up, or the user left. */
export async function clearCheckInReplayState(): Promise<void> {
  const key = replayStateKey();
  try {
    await serialize(key, () => AsyncStorage.removeItem(key));
  } catch {
    console.warn(WARN_CLEAR);
  }
}
