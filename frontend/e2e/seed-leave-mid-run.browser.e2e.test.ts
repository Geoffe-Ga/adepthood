import { expect, test, type Route } from '@playwright/test';

import { backendUrl } from './journalHabitsBrowserSupport';
import {
  chooseFolder,
  digestOf,
  expectLanded,
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
  uploadOf,
  registerSeedSpec,
  vaultLedger,
} from './seedBrowserSupport';

/**
 * Leaving a corpus import mid-run, in a real browser (#3772; formerly #2423).
 *
 * Since #3772 the run lives in an app-level upload queue rather than in the
 * Seed screen: leaving the screen carries on, a small indicator shows it from
 * anywhere in the app, and more folders can be queued while one is going over.
 * Jest proves the client kept calling `POST /corpus/import` after the screen
 * unmounted; what only the seam can prove is that the vault afterwards holds
 * every document of both folders -- the one queued before leaving and the one
 * queued after coming back -- each exactly once. So the folders are real ones
 * chosen through Chromium's own directory input, the leave is a real in-app
 * navigation, the way back is the indicator, and the outcome is read back from
 * the lane's Creek vault through its own ledger of what arrived.
 *
 * One harness-side seam is used, because the lane cannot produce it itself:
 * keeping the queue busy while the person leaves, comes back and queues a
 * second folder needs a request held open, so the first upload is held at the
 * browser until the second folder is queued, then released to the real server
 * unchanged.
 *
 * The stored outcome is asserted first, then the wire, then the screen.
 */

const { writeFolder } = registerSeedSpec('adepthood-seed-leave-');

test('leaving mid-run carries on; coming back, a second folder queues behind it and every note lands', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const first: Record<string, string> = {
    'a.md': 'queue sentinel 3772 a: in flight when the person leaves.\n',
    'b.md': 'queue sentinel 3772 b: queued behind it.\n',
    'c.md': 'queue sentinel 3772 c: queued behind it.\n',
  };
  const second: Record<string, string> = {
    'd.md': 'queue sentinel 3772 d: a second folder, queued mid-run.\n',
    'e.md': 'queue sentinel 3772 e: a second folder, queued mid-run.\n',
  };
  const firstFolder = writeFolder('Queued First 3772', first);
  const secondFolder = writeFolder('Queued Second 3772', second);
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);

  // Hold the first upload at the browser until the second folder is queued.
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
  await chooseFolder(page, firstFolder);
  expect(await reviewedPaths(page)).toEqual(['a.md', 'b.md', 'c.md']);
  await startImport(page);
  await held;
  await expect(page.getByTestId('seed-progress-line')).toHaveText('Sending 1 of 3…');
  await expect(page.getByTestId('seed-background-note')).toContainText(
    'Closing this tab or the app stops them',
  );

  // Leave: nothing asks, the screen goes, and the queue shows from elsewhere.
  await page.getByRole('link', { name: 'Settings, back' }).click();
  await expect(page.getByTestId('seed-corpus-screen')).toHaveCount(0);
  await expect(page.getByTestId('seed-leave-prompt')).toHaveCount(0);
  await expect(page.getByTestId('upload-queue-indicator-line')).toHaveText(
    'Uploading · 3 remaining',
  );

  // Come back through the indicator: the same rows, the same run.
  await page.getByTestId('upload-queue-indicator').click();
  await expect(page.getByTestId('seed-corpus-screen')).toBeVisible();
  await expect(page.getByTestId('seed-batch-header-batch-0')).toHaveText(
    'Queued First 3772 · Uploading · 3 remaining',
  );

  // Queue a second folder while the first is still going over.
  await chooseFolder(page, secondFolder);
  expect(await reviewedPaths(page)).toEqual(['d.md', 'e.md']);
  await startImport(page);
  await expect(page.getByTestId('seed-batch-header-batch-1')).toHaveText(
    'Queued Second 3772 · Queued · 2 files',
  );
  expect(importPosts(sent)).toHaveLength(1);

  release();
  for (const path of [...Object.keys(first), ...Object.keys(second)]) {
    await expectLanded(page, path);
  }

  // Stored outcome first: every note of both folders, each exactly once.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(5);
  for (const content of [...Object.values(first), ...Object.values(second)]) {
    expect(uploadOf(uploads, digestOf(content)).action).toBe('created');
  }

  // Then the wire: one request at a time, first folder first, one queue run.
  const posts = importPosts(sent);
  expect(posts.map(sourcePathOf)).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
  const runs = new Set(
    posts.map((entry) => (JSON.parse(entry.body ?? '{}') as { upload_run?: string }).upload_run),
  );
  expect(runs.size).toBe(1);

  // Then the screen: both batches done, and the indicator gone.
  await expect(page.getByTestId('seed-batch-header-batch-0')).toHaveText(
    'Queued First 3772 · Done · 3 files',
  );
  await expect(page.getByTestId('seed-batch-header-batch-1')).toHaveText(
    'Queued Second 3772 · Done · 2 files',
  );
  await expect(page.getByTestId('upload-queue-indicator')).toHaveCount(0);
});
