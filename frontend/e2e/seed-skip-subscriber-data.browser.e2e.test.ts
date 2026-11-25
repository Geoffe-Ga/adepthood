import { expect, test, type Route } from '@playwright/test';

import { backendUrl } from './journalHabitsBrowserSupport';
import {
  chooseFolder,
  countsLine,
  digestOf,
  expectLanded,
  fileReads,
  importPosts,
  IMPORT_ROUTE,
  loginVaultOwner,
  openSeedScreen,
  recordFileReads,
  recordRequests,
  registerSeedSpec,
  runRow,
  sourcePathOf,
  startImport,
  uploadCount,
  uploadOf,
  uploadsSince,
  vaultLedger,
} from './seedBrowserSupport';

/**
 * An unpacked Substack export, in a real browser (#3798): the per-post stat
 * CSVs and the subscriber roster list other people, so they stay on the device
 * even with the attachments switched on.
 *
 * The folder goes through Chromium's own directory input, exactly as in
 * `seed-folder-import.browser.e2e.test.ts`, and the outcome is read back from
 * the lane's Creek vault through its own ledger. The first upload is held at
 * the browser -- the one harness seam, as in
 * `seed-skip-unsupported.browser.e2e.test.ts` -- so the rows are read while no
 * request has returned: the device decided them, not a server's answer. The
 * request is then released unaltered to the real server.
 *
 * Stored outcomes are asserted before absences, so a vault the lane never
 * reached cannot make an absence pass.
 */

/** How a stat or subscriber file's row opens. */
const SUBSCRIBER_DATA_LINE = 'Skipped · a list of who received or opened a post';

/** What the review says of the three before anything is sent. */
const REVIEW_LINE = 'Left out 3 files: 3 listing who received or opened a post.';

/** Spec-wide scratch space; the folder below lives here and goes with it. */
const { writeFolder } = registerSeedSpec('adepthood-seed-subscriber-');

test("a Substack export's stat and subscriber CSVs stay on the device, attachments on (#3798)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Substack 3798';
  const kept = {
    'essay.md': 'substack sentinel 3798: an essay.\n',
    'posts.csv': 'post_id,post_date,title\n141234,2026-01-01,substack sentinel 3798\n',
    'notes/budget.csv': 'item,cost\nsubstack sentinel 3798,4\n',
  };
  const statFiles = {
    'posts/141234.my-post.delivers.csv': 'email,delivered_at\nreader3798@example.com,2026-01-01\n',
    'posts/141234.my-post.opens.csv': 'email,opened_at\nreader3798@example.com,2026-01-02\n',
    'email_list.my-publication.csv': 'email,active\nreader3798@example.com,true\n',
  };
  const folder = writeFolder(namespace, { ...kept, ...statFiles });
  const sent = recordRequests(page);
  await recordFileReads(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  const before = await vaultLedger(page);

  await chooseFolder(page, folder);
  // Counted in the review, before anything is sent, and with the attachments on.
  await page.getByTestId('seed-folder-attachments').click();
  await expect(page.getByTestId('seed-folder-skipped')).toHaveText(REVIEW_LINE);

  // Hold the first upload at the browser, so the rows can be read before any
  // request has returned.
  let releaseFirst = (): void => undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let held = false;
  await page.route(`${backendUrl()}${IMPORT_ROUTE}`, async (route: Route) => {
    if (!held && route.request().method() === 'POST') {
      held = true;
      await firstHeld;
    }
    await route.continue();
  });
  await startImport(page);

  // Nothing has gone over yet: three skipped with their reason, three to go.
  await expect(page.getByTestId('seed-summary')).toHaveText(
    countsLine({ remaining: 3, skipped: 3 }),
  );
  for (const path of Object.keys(statFiles)) {
    await expect(runRow(page, path)).toContainText(SUBSCRIBER_DATA_LINE);
  }
  expect(importPosts(sent)).toHaveLength(1);
  releaseFirst();

  for (const path of Object.keys(kept)) await expectLanded(page, path);
  await expect(page.getByTestId('seed-summary')).toHaveText(countsLine({ landed: 3, skipped: 3 }));
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  // Stored outcomes first: the essay, the manifest and the ordinary spreadsheet.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(3);
  for (const text of Object.values(kept)) {
    expect(uploadOf(uploads, digestOf(text)).action).toBe('created');
  }
  // Then the absences: no stat file was read, posted, or reached the vault.
  expect(importPosts(sent).map(sourcePathOf).sort()).toEqual(Object.keys(kept).sort());
  const reads = await fileReads(page);
  expect([...reads].sort()).toEqual(
    Object.keys(kept)
      .map((path) => `${namespace}/${path}`)
      .sort(),
  );
  const received = after.received.map((entry) => entry.digest);
  for (const stat of Object.values(statFiles)) {
    expect(received).not.toContain(digestOf(stat));
  }
});
