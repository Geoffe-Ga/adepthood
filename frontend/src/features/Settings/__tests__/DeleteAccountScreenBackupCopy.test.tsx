/* global describe, test, expect, beforeEach, jest */
/**
 * The delete-account copy states the backup bound as the schedule's figure,
 * never as a guarantee, and never calls deletion total (#3115).
 *
 * `backend/tests/test_deletion_backup_copy.py` holds the same rules against
 * the screen's source, but a PR that touches only this screen does not run
 * the backend suite. This is the frontend half of the pin: the same bound,
 * the same framing rule and the same overclaim ban, read from what the
 * screen renders.
 *
 * Nothing here is transcribed from the backend. The bound is derived from
 * `backend/src/domain/retention_stores.py` the way the backend derives it, and
 * the framing phrases, the framing window and the overclaim ban are read from
 * the backend test. Reading them through `@/testing/backendSource` marks this
 * suite cross-boundary, so it runs on a backend-only change as well as on a
 * frontend-only one: changing the figure on either side alone fails here.
 */
import { fireEvent, render, waitFor, type RenderAPI } from '@testing-library/react-native';
import React from 'react';

import DeleteAccountScreen from '../DeleteAccountScreen';

import { users, type AccountDeletionReceipt } from '@/api';
import { OLDEST_LIVE_BACKUP_DAYS } from '@/constants/backupSchedule';
import { useAuth } from '@/context/AuthContext';
import { readBackendSource } from '@/testing/backendSource';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, users: { deleteMyAccount: jest.fn() } };
});

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockDeleteMyAccount = users.deleteMyAccount as jest.MockedFunction<
  typeof users.deleteMyAccount
>;

const RETENTION_STORES = readBackendSource('src', 'domain', 'retention_stores.py');
const BACKEND_COPY_TEST = readBackendSource('tests', 'test_deletion_backup_copy.py');

/**
 * The first capture group of `pattern`'s match in `source` (or the whole match
 * when it captures nothing), or a failure naming what moved.
 */
function matchOne(source: string, pattern: RegExp, what: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`the backend no longer declares ${what} as ${pattern}`);
  return match[1] ?? match[0];
}

/** Every double-quoted string literal in a Python snippet. */
function pythonStrings(snippet: string): string[] {
  return Array.from(snippet.matchAll(/"([^"\\]*)"/g)).flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * `OLDEST_LIVE_BACKUP_DAYS` as `retention_stores.py` computes it: the largest
 * `retention_days + interval_days` across `BACKUP_LEGS`. Each step of that
 * derivation is matched, so a backend change to its shape fails here instead of
 * being silently mis-read.
 */
function backendOldestLiveBackupDays(): number {
  matchOne(
    RETENTION_STORES,
    /^OLDEST_LIVE_BACKUP_DAYS: Final = max\(leg\.oldest_live_copy_days for leg in BACKUP_LEGS\)$/m,
    'OLDEST_LIVE_BACKUP_DAYS',
  );
  matchOne(
    RETENTION_STORES,
    /def oldest_live_copy_days\(self\) -> int:\n(?: {8}.*\n)*? {8}return self\.retention_days \+ self\.interval_days$/m,
    'oldest_live_copy_days',
  );
  const constants = new Map(
    Array.from(RETENTION_STORES.matchAll(/^([A-Z_]+): Final = (\d+)$/gm), (match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  const legs = Array.from(
    RETENTION_STORES.matchAll(
      /BackupLeg\(\s*key="[^"]+",\s*retention_days=([A-Z_]+),\s*interval_days=([A-Z_]+),/g,
    ),
    (match) => {
      const [retention, interval] = [constants.get(match[1]), constants.get(match[2])];
      if (retention === undefined || interval === undefined) {
        throw new Error(`a backup leg names ${match[1]} / ${match[2]}, not integer constants`);
      }
      return retention + interval;
    },
  );
  if (legs.length === 0) throw new Error('retention_stores.py declares no BackupLeg');
  return Math.max(...legs);
}

// One of these phrases must sit in the same sentence as each statement of the
// bound, before it, and no further back than the window -- the backend test's
// own `_SCHEDULE_FRAMINGS` and `_FRAMING_WINDOW_CHARS`.
const SCHEDULE_FRAMINGS = pythonStrings(
  matchOne(BACKEND_COPY_TEST, /^_SCHEDULE_FRAMINGS: [^=]+= \(([^)]*)\)$/m, '_SCHEDULE_FRAMINGS'),
);
const FRAMING_WINDOW_CHARS = Number(
  matchOne(BACKEND_COPY_TEST, /^_FRAMING_WINDOW_CHARS: Final = (\d+)$/m, '_FRAMING_WINDOW_CHARS'),
);

// The backend test's `_OVERCLAIMS`: deletion as total and instant, or the
// backup bound as something enforced.
const OVERCLAIMS = pythonStrings(
  matchOne(BACKEND_COPY_TEST, /^_OVERCLAIMS: [^=]+= \(\n([\s\S]*?)\n\)$/m, '_OVERCLAIMS'),
);

const RECEIPT: AccountDeletionReceipt = {
  recoverable: false,
  rows_erased: 42,
  erased: ['habit', 'journalentry'],
  anonymised: ['practice'],
  retained: ['coursestage'],
  vault: {
    configured: true,
    purged: false,
    guidance: 'Your Creek Vault is yours, not ours. Run `creek purge` against it.',
  },
};

const BOUND = `about ${OLDEST_LIVE_BACKUP_DAYS} days`;

/** The part of a `toJSON()` host element this suite reads: its children. */
interface RenderedNode {
  children: (RenderedNode | string)[] | null;
}

/** Every string the rendered tree shows, in order. */
function renderedStrings(node: RenderedNode | RenderedNode[] | null): string[] {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap(renderedStrings);
  return (node.children ?? []).flatMap((child) =>
    typeof child === 'string' ? [child] : renderedStrings(child),
  );
}

/** The screen's copy as lowercase prose with whitespace collapsed. */
function prose(screen: RenderAPI): string {
  return renderedStrings(screen.toJSON()).join(' ').toLowerCase().split(/\s+/).join(' ');
}

/** Offsets of each statement of the bound that no schedule phrase governs. */
function unframedBoundOffsets(copy: string): number[] {
  const unframed: number[] = [];
  for (let offset = copy.indexOf(BOUND); offset !== -1; offset = copy.indexOf(BOUND, offset + 1)) {
    const window = copy.slice(Math.max(0, offset - FRAMING_WINDOW_CHARS), offset);
    const sentence = window.slice(window.lastIndexOf('. ') + 1);
    if (!SCHEDULE_FRAMINGS.some((phrase) => sentence.includes(phrase))) unframed.push(offset);
  }
  return unframed;
}

async function renderReceipt(): Promise<RenderAPI> {
  mockDeleteMyAccount.mockResolvedValue(RECEIPT);
  const screen = render(<DeleteAccountScreen />);
  fireEvent.changeText(screen.getByTestId('delete-account-email-input'), 'writer@example.com');
  fireEvent.press(screen.getByTestId('delete-account-submit'));
  await waitFor(() => expect(screen.getByTestId('delete-account-receipt')).toBeTruthy());
  return screen;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ logout: jest.fn() } as unknown as ReturnType<typeof useAuth>);
});

describe('DeleteAccountScreen backup copy (#3115)', () => {
  test('the shared backup figure is the one the backend derives', () => {
    expect(OLDEST_LIVE_BACKUP_DAYS).toBe(backendOldestLiveBackupDays());
  });

  test('the rules read from the backend test are all there', () => {
    expect(SCHEDULE_FRAMINGS).toContain('on our backup schedule');
    expect(FRAMING_WINDOW_CHARS).toBeGreaterThan(0);
    expect(OVERCLAIMS).toEqual(expect.arrayContaining(['nothing left to restore', 'guaranteed']));
  });

  test('the framing check is local: a schedule phrase in another sentence does not count', () => {
    expect(
      unframedBoundOffsets(`on our backup schedule, backups age out within ${BOUND}.`),
    ).toEqual([]);
    expect(
      unframedBoundOffsets(`on our backup schedule, we copy weekly. backups are gone in ${BOUND}.`),
    ).toHaveLength(1);
  });

  test.each([
    ['the warning', async () => render(<DeleteAccountScreen />)],
    ['the receipt', renderReceipt],
  ])('%s names the bound, framed as the backup schedule', async (_name, renderState) => {
    const copy = prose(await renderState());

    expect(copy).toContain(BOUND);
    expect(unframedBoundOffsets(copy)).toEqual([]);
  });

  test.each([
    ['the warning', async () => render(<DeleteAccountScreen />)],
    ['the receipt', renderReceipt],
  ])('%s drops every overclaim', async (_name, renderState) => {
    const copy = prose(await renderState());

    expect(OVERCLAIMS.filter((claim) => copy.includes(claim))).toEqual([]);
  });
});
