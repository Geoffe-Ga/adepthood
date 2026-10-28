import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Response } from '@playwright/test';

import { bearer } from './journalHabitsBrowserSupport';
import {
  DEGRADED_LINE_START,
  digestOf,
  expectLanded,
  expectNoneIn,
  importPosts,
  IMPORT_ROUTE,
  lane,
  loginVaultOwner,
  occurrences,
  openSeedScreen,
  recordRequests,
  registerSeedSpec,
  runRow,
  sensitiveNeedles,
  serverLogSince,
  serverLogSize,
  uploadCount,
  uploadFragments,
  uploadsSince,
  vaultLedger,
  type VaultLedger,
} from './seedBrowserSupport';

/**
 * A document the vault kept, whose reply was lost on the way back (#3229, #3052).
 *
 * A vault can commit an upload and then answer something adepthood cannot read
 * -- a proxy error page served as 200, say. Nothing about that lets adepthood
 * say the vault was unchanged, so the server answers `202 degraded` with a
 * message that the upload is *unconfirmed*, and the screen offers to send it
 * again, which is safe because the upload's external id is stable.
 *
 * Nothing is faked on adepthood's side of the seam. The lane's Creek vault --
 * the process the server's production `CREEK_VAULT_URL` names -- is armed with
 * `POST /__lane/lose-upload-reply` for one document by digest: it stores that
 * upload in its ledger exactly as it would any other, then answers a 200 whose
 * body is not JSON. The real HTTP adapter meets that unreadable 2xx, and
 * everything after it -- the route's answer, the screen's row, the retry -- is
 * the production path. The vault's ledger is read first, so the "couldn't
 * confirm" the person sees is measured against a vault that demonstrably has
 * the document.
 */

/**
 * The server's exact `degraded` message, `UPLOAD_MESSAGES[DEGRADED]` in
 * `backend/src/schemas/journal_upload.py`. Spelled out rather than imported:
 * the lane reads the answer off the wire, and a change to these words is a
 * change to what a person is told, which should have to touch this spec.
 */
const DEGRADED_MESSAGE =
  "We couldn't confirm whether the upload finished — your vault may or may " +
  'not have the document. Please try again; sending the same file again ' +
  'updates it in place rather than adding a second copy.';

/** Every way of saying the vault was left untouched, which this outcome has no evidence for. */
const UNCHANGED_CLAIMS =
  /wasn't stored|was not stored|nothing was|nothing in your vault|wasn't sent|unchanged/iu;

const DEGRADED_EVENT = 'creek vault upload degraded';
const HTTP_ACCEPTED = 202;

/** What `DocumentImportResponse` carries for a vault answer. */
interface ImportAnswer {
  destination: string;
  stored: boolean;
  vault_status: string | null;
  vault_ref: string | null;
  message: string;
}

/** The one fragment the vault holds for a lost-reply upload, as the ledger first saw it. */
interface KeptUpload {
  externalId: string;
  fragmentId: string;
}

/**
 * Assert the vault has the document although its reply never made it back:
 * exactly one upload since `from`, created at `digest` and recorded as the one
 * whose reply was spoiled, and exactly one fragment under its identity.
 */
function expectKeptDespiteLostReply(ledger: VaultLedger, from: number, digest: string): KeptUpload {
  const lost = uploadsSince(ledger, from);
  expect(lost).toHaveLength(1);
  const [upload] = lost;
  expect(upload?.digest).toBe(digest);
  expect(upload?.action).toBe('created');
  expect(upload?.reply).toBe('unreadable');
  const externalId = upload?.externalId ?? '';
  expect(externalId).not.toBe('');
  const kept = uploadFragments(ledger).filter((f) => f.externalId === externalId);
  expect(kept).toHaveLength(1);
  expect(kept[0]?.digest).toBe(digest);
  return { externalId, fragmentId: kept[0]?.fragmentId ?? '' };
}

/** Assert the server answered accepted and degraded, claiming only that it could not confirm. */
async function expectUnconfirmedAnswer(answer: Response): Promise<void> {
  expect(answer.status()).toBe(HTTP_ACCEPTED);
  const body = (await answer.json()) as ImportAnswer;
  expect(body.destination).toBe('vault');
  expect(body.stored).toBe(false);
  expect(body.vault_status).toBe('degraded');
  expect(body.vault_ref).toBeNull();
  expect(body.message).toBe(DEGRADED_MESSAGE);
  expect(body.message).not.toMatch(UNCHANGED_CLAIMS);
}

/**
 * Assert the retry addressed the same identity and the vault updated what it
 * already had: two attempts at one digest, the second `unchanged` and answered
 * normally, and still one fragment -- the same one -- now written twice.
 */
function expectUpdatedInPlace(
  ledger: VaultLedger,
  from: number,
  digest: string,
  kept: KeptUpload,
): void {
  const attempts = uploadsSince(ledger, from);
  expect(attempts.map((entry) => entry.action)).toEqual(['created', 'unchanged']);
  expect(attempts.map((entry) => entry.digest)).toEqual([digest, digest]);
  expect(attempts.map((entry) => entry.externalId)).toEqual([kept.externalId, kept.externalId]);
  expect(attempts[1]?.reply).toBeUndefined();
  const fragments = uploadFragments(ledger).filter((f) => f.externalId === kept.externalId);
  expect(fragments).toHaveLength(1);
  expect(fragments[0]?.fragmentId).toBe(kept.fragmentId);
  expect(fragments[0]?.writes).toBe(2);
}

const { root: scratch } = registerSeedSpec('adepthood-seed-unconfirmed-');

test('an upload the vault kept but whose reply was lost is unconfirmed, and a retry updates it in place', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const name = 'lost-reply-3229.md';
  const text = 'unconfirmed sentinel 3229: kept by the vault, its answer lost.\n';
  const path = join(scratch(), name);
  writeFileSync(path, text);
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  const state = lane();
  const armed = await page.request.post(`${state.vaultUrl}/__lane/lose-upload-reply`, {
    headers: bearer(state.vaultApiKey),
    data: { digest: digestOf(text) },
  });
  expect(armed.status()).toBe(200);
  const logOffset = serverLogSize();
  const before = await vaultLedger(page);

  const firstAnswer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === IMPORT_ROUTE && response.request().method() === 'POST',
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('seed-choose-button').click();
  await (await chooser).setFiles(path);
  const answer = await firstAnswer;
  await expect(page.getByTestId('seed-retry-button')).toHaveText('Try that one again');

  // Stored outcome first: the vault has the document, under the identity the
  // server derived, although its reply never made it back.
  const kept = expectKeptDespiteLostReply(
    await vaultLedger(page),
    uploadCount(before),
    digestOf(text),
  );

  // Then the server's answer: accepted, degraded, and saying only that it
  // could not confirm -- never that nothing was stored.
  await expectUnconfirmedAnswer(answer);

  // And the screen: the row says it couldn't confirm, and the run counts it
  // apart from what landed and from what didn't go over.
  await expect(runRow(page, name)).toContainText(DEGRADED_LINE_START);
  await expect(page.getByTestId('seed-summary')).toHaveText(
    "0 of 1 landed. 1 couldn't be confirmed.",
  );

  // Trying again re-sends the same document under the same identity; the
  // vault updates the fragment it already had rather than adding a second.
  await page.getByTestId('seed-retry-button').click();
  await expectLanded(page, name);
  await expect(page.getByTestId('seed-summary')).toHaveText('All 1 have landed.');
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  expectUpdatedInPlace(await vaultLedger(page), uploadCount(before), digestOf(text), kept);
  const posts = importPosts(sent);
  expect(posts).toHaveLength(2);
  expect(posts[1]?.body).toBe(posts[0]?.body);

  // The server logged the lost reply without naming the document.
  await expect
    .poll(() => occurrences(serverLogSince(logOffset), DEGRADED_EVENT))
    .toBeGreaterThanOrEqual(1);
  expectNoneIn([serverLogSince(logOffset)], sensitiveNeedles(name, [text]));
});
