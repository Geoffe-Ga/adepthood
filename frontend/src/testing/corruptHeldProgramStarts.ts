import AsyncStorage from '@react-native-async-storage/async-storage';

import { savePendingProgramStart, type HeldProgramStart } from '../storage/pendingProgramStart';

/**
 * Held program-start records this device never wrote -- a crash mid-write, an
 * older build's shape, someone else's key -- one row per guard in
 * ``parseHeld`` (#3708). Kept as the raw strings on disk, not objects, so a
 * missing field is exactly missing and invalid JSON is exactly invalid.
 *
 * Shared by the storage module's own suite, which pins that each one reads
 * back as nothing, and the reconcile suite, which pins that none of them is
 * ever sent to the server as the person's pick.
 */
export interface CorruptHeldProgramStart {
  /** Which guard the row stands for, as the test title names it. */
  readonly label: string;
  /** Exactly what is on disk under the held-pick key. */
  readonly raw: string;
  /** Whether reading it is a failure worth a diagnostic, not merely a foreign shape. */
  readonly unreadable: boolean;
}

const DAY = '2026-06-01';
const PRIOR_DAY = '2026-03-01';
const OWNER = 7;

const record = (fields: Record<string, unknown>): string => JSON.stringify(fields);

/** Every shape ``loadPendingProgramStart`` must read back as null. */
export const CORRUPT_HELD_PROGRAM_STARTS: ReadonlyArray<CorruptHeldProgramStart> = [
  { label: 'invalid JSON', raw: '{not json', unreadable: true },
  { label: 'JSON null', raw: 'null', unreadable: false },
  { label: 'a bare number', raw: '42', unreadable: false },
  { label: 'an array', raw: '[]', unreadable: false },
  {
    label: 'an owner written as a string',
    raw: record({ owner: '7', day: DAY, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'an owner of zero',
    raw: record({ owner: 0, day: DAY, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a negative owner',
    raw: record({ owner: -3, day: DAY, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a fractional owner',
    raw: record({ owner: 1.5, day: DAY, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'no owner at all',
    raw: record({ day: DAY, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'an unpadded day',
    raw: record({ owner: OWNER, day: '2026-6-1', priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a day written as a number',
    raw: record({ owner: OWNER, day: 20260601, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'no day at all',
    raw: record({ owner: OWNER, priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a day with a time attached',
    raw: record({ owner: OWNER, day: '2026-06-01T00:00:00Z', priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a day with leading junk',
    raw: record({ owner: OWNER, day: 'x2026-06-01', priorServerDay: null }),
    unreadable: false,
  },
  {
    label: 'a prior server day with a time attached',
    raw: record({ owner: OWNER, day: DAY, priorServerDay: '2026-03-01T00:00:00Z' }),
    unreadable: false,
  },
  {
    label: 'a prior server day in another format',
    raw: record({ owner: OWNER, day: DAY, priorServerDay: '03/10/2026' }),
    unreadable: false,
  },
  {
    label: 'a prior server day written as a number',
    raw: record({ owner: OWNER, day: DAY, priorServerDay: 5 }),
    unreadable: false,
  },
  {
    label: 'no prior server day at all',
    raw: record({ owner: OWNER, day: DAY }),
    unreadable: false,
  },
];

/** Records the module wrote itself, including both nullable fields left null. */
export const VALID_HELD_PROGRAM_STARTS: ReadonlyArray<{ label: string; held: HeldProgramStart }> = [
  { label: 'an anonymous first pick', held: { owner: null, day: DAY, priorServerDay: null } },
  {
    label: "an account's pick made against a server day",
    held: { owner: OWNER, day: DAY, priorServerDay: PRIOR_DAY },
  },
];

/**
 * Put ``raw`` on disk under the held-pick key, exactly as written.
 *
 * The key is private to ``pendingProgramStart``. Rather than copy it, this
 * saves a valid record through the module and overwrites whichever key now
 * holds it, so a renamed key cannot leave these tests seeding a key nothing
 * reads.
 */
export async function writeRawHeldProgramStart(raw: string): Promise<void> {
  const sentinel = VALID_HELD_PROGRAM_STARTS[0]!.held;
  await savePendingProgramStart(sentinel);
  const written = JSON.stringify(sentinel);
  const entries = await AsyncStorage.multiGet(await AsyncStorage.getAllKeys());
  const keys = entries.filter(([, value]) => value === written).map(([key]) => key);
  if (keys.length !== 1) {
    throw new Error(`expected one held-pick key on disk, found ${keys.length}`);
  }
  await AsyncStorage.setItem(keys[0]!, raw);
}
