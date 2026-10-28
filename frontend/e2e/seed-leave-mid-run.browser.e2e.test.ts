import { expect, test, type Route } from '@playwright/test';

import { backendUrl } from './journalHabitsBrowserSupport';
import {
  chooseFolder,
  digestOf,
  importPosts,
  IMPORT_ROUTE,
  loginVaultOwner,
  openSeedScreen,
  recordRequests,
  reviewedPaths,
  sourcePathOf,
  startImport,
  uploadCount,
  uploadsSince,
  registerSeedSpec,
  vaultLedger,
} from './seedBrowserSupport';

/**
 * Leaving a corpus import mid-run, in a real browser (#2423, #2410).
 *
 * The defect this journey closes was a run that kept uploading in the
 * background while the person saw an empty screen. Jest proves the client
 * stopped calling `POST /corpus/import`; what only the seam can prove is that
 * the vault afterwards holds exactly the document that was in flight when the
 * person left, and none of those queued behind it. So the run is a real folder
 * chosen through Chromium's own directory input, the leave goes through the
 * real leave prompt, and the outcome is read back from the lane's Creek vault
 * -- the process the server's production `CREEK_VAULT_URL` names -- through
 * its own ledger of what arrived.
 *
 * One harness-side seam is used, because the lane cannot produce it itself:
 * stopping a run mid-flight needs a request held open, so the first upload is
 * held at the browser until the leave prompt has been answered, then released
 * to the real server unchanged.
 *
 * The stored outcome is asserted before the absences, so a vault the lane
 * never reached cannot make an absence pass.
 */

/** Long enough for a run to send a document that was never going to go. */
const QUIET_PERIOD_MS = 1_500;

const { writeFolder } = registerSeedSpec('adepthood-seed-leave-');

test('leaving mid-run stops the queue: the document in flight lands and nothing after it is sent', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Stopped 3557';
  const notes: Record<string, string> = {
    'a.md': 'stop sentinel 3557 a: in flight when the run stops.\n',
    'b.md': 'stop sentinel 3557 b: queued behind it.\n',
    'c.md': 'stop sentinel 3557 c: queued behind it.\n',
    'd.md': 'stop sentinel 3557 d: queued behind it.\n',
  };
  const folder = writeFolder(namespace, notes);
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);

  // Hold the first upload at the browser until the person has chosen to leave.
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => {
    markHeld = resolveHeld;
  });
  let holds = 0;
  await page.route(`${backendUrl()}${IMPORT_ROUTE}`, async (route: Route) => {
    if (route.request().method() !== 'POST' || holds > 0) {
      await route.continue();
    } else {
      holds += 1;
      markHeld();
      await released;
      await route.continue();
    }
  });

  const before = await vaultLedger(page);
  await chooseFolder(page, folder);
  expect(await reviewedPaths(page)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  await startImport(page);
  await held;
  await expect(page.getByTestId('seed-progress-line')).toHaveText('Sending 1 of 4…');

  // Leave: the screen asks, and confirming stops the run.
  await page.getByRole('link', { name: 'Settings, back' }).click();
  await expect(page.getByTestId('seed-leave-prompt')).toBeVisible();
  await page.getByTestId('seed-leave-confirm').click();
  await expect(page.getByTestId('seed-corpus-screen')).toHaveCount(0);
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === IMPORT_ROUTE && response.request().method() === 'POST',
  );
  release();
  expect((await answered).status()).toBe(202);
  await page.waitForTimeout(QUIET_PERIOD_MS);

  // The one in flight landed, as its request was already with the server.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.digest).toBe(digestOf(notes['a.md'] ?? ''));
  expect(uploads[0]?.action).toBe('created');
  // Nothing queued behind it was ever sent.
  expect(importPosts(sent).map(sourcePathOf)).toEqual(['a.md']);
  const digests = after.received.map((entry) => entry.digest);
  for (const name of ['b.md', 'c.md', 'd.md']) {
    expect(digests).not.toContain(digestOf(notes[name] ?? ''));
  }
});
