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
 */
import { fireEvent, render, waitFor, type RenderAPI } from '@testing-library/react-native';
import React from 'react';

import DeleteAccountScreen from '../DeleteAccountScreen';

import { users, type AccountDeletionReceipt } from '@/api';
import { OLDEST_LIVE_BACKUP_DAYS } from '@/constants/backupSchedule';
import { useAuth } from '@/context/AuthContext';

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

// CROSS-STACK CONTRACT: the backend pins `OLDEST_LIVE_BACKUP_DAYS` in
// `backend/src/domain/retention_stores.py` to this literal too, by reading
// `frontend/src/constants/backupSchedule.ts`. Changing the figure on either
// side fails a test until both move together.
const PINNED_OLDEST_LIVE_BACKUP_DAYS = 97;

// Mirrors `_SCHEDULE_FRAMINGS` and `_FRAMING_WINDOW_CHARS` in
// backend/tests/test_deletion_backup_copy.py: one of these phrases must sit in
// the same sentence as each statement of the bound, before it, and no further
// back than the window.
const SCHEDULE_FRAMINGS = ['on our backup schedule', 'on that schedule'];
const FRAMING_WINDOW_CHARS = 160;

// Mirrors `_OVERCLAIMS` there: deletion as total and instant, or the backup
// bound as something enforced. The backend test checks each of its phrases is
// listed here.
const OVERCLAIMS = [
  'immediate and irreversible',
  'immediate and total',
  'everything of yours goes',
  'nothing left to restore',
  'each is deleted when its retention runs out',
  'is gone within about',
  'we guarantee',
  'guaranteed',
  'is deleted within',
  'are deleted within',
];

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

const BOUND = `about ${PINNED_OLDEST_LIVE_BACKUP_DAYS} days`;

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
  test('the shared backup figure is the literal the backend pins', () => {
    expect(OLDEST_LIVE_BACKUP_DAYS).toBe(PINNED_OLDEST_LIVE_BACKUP_DAYS);
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
