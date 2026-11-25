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
 * A folder of mixed files, in a real browser (#3771): what will not be sent is
 * skipped before anything is sent, counted, and never read or sent.
 *
 * The folder goes through Chromium's own directory input, exactly as in
 * `seed-folder-import.browser.e2e.test.ts`, and the outcome is read back from
 * the lane's Creek vault through its own ledger. The first upload is held at
 * the browser -- the one harness seam, used only to freeze a moment the lane
 * moves through too quickly to read: the screen is read while nothing has gone
 * over yet, so the skips are proven counted before any request returns. The
 * request is then released unaltered to the real server.
 *
 * Stored outcomes are asserted before absences, so a vault the lane never
 * reached cannot make an absence pass.
 */

/** How each kind of skipped row opens. */
const APP_SETTINGS_LINE = "Skipped · an app's own settings rather than your writing";
const ATTACHMENTS_OFF_LINE = 'Skipped · attachments are off';
const UNSUPPORTED_LINE = "Skipped · your vault doesn't read this type";

/** Settings an Obsidian vault keeps beside the notes, which must never leave. */
const OBSIDIAN_CONFIG = '{"lane3771": "must stay local"}\n';

/** Spec-wide scratch space; every folder below lives here and goes with it. */
const { writeFolder } = registerSeedSpec('adepthood-seed-skip-');

test('unsupported files are skipped before anything is sent, counted, and never read or sent (#3771)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Mixed 3771';
  const notes = {
    'a.md': 'mixed sentinel 3771: the first note.\n',
    'b.md': 'mixed sentinel 3771: the second note.\n',
    'c.md': 'mixed sentinel 3771: the third note.\n',
  };
  const csv = 'date,words\n2024-01-01,mixed sentinel 3771 csv\n';
  // `.jsonl`, not `.json`: since #3797 a `.json` is sent for the vault to
  // decide, and stays behind here only as an attachment left switched off.
  const json = '{"mixed": "sentinel 3771 json"}\n';
  const folder = writeFolder(namespace, {
    ...notes,
    'data/2024.csv': csv,
    'data/2025.csv': csv.replace('2024', '2025'),
    'export.jsonl': json,
    '.obsidian/app.json': OBSIDIAN_CONFIG,
  });
  const sent = recordRequests(page);
  await recordFileReads(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  const before = await vaultLedger(page);

  // Hold the first upload at the browser, so the screen can be read while
  // nothing has gone over yet: the skips must already be counted then.
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

  await chooseFolder(page, folder);
  await expect(page.getByTestId('seed-folder-notes')).toHaveText('3 notes selected');
  await startImport(page);

  // Before the first document has gone over: four skipped, three to go.
  await expect(page.getByTestId('seed-summary')).toHaveText(
    countsLine({ remaining: 3, skipped: 4 }),
  );
  await expect(page.getByTestId('seed-batch-counts-batch-0')).toHaveText(
    countsLine({ remaining: 3, skipped: 4 }),
  );
  await expect(page.getByTestId('upload-queue-indicator-line')).toHaveText(
    'Uploading · 3 remaining',
  );
  await expect(runRow(page, 'data/2024.csv')).toContainText(ATTACHMENTS_OFF_LINE);
  await expect(runRow(page, 'data/2025.csv')).toContainText(ATTACHMENTS_OFF_LINE);
  await expect(runRow(page, 'export.jsonl')).toContainText(UNSUPPORTED_LINE);
  await expect(runRow(page, '.obsidian/app.json')).toContainText(APP_SETTINGS_LINE);
  expect(importPosts(sent)).toHaveLength(1);
  releaseFirst();

  for (const path of Object.keys(notes)) await expectLanded(page, path);
  await expect(page.getByTestId('seed-summary')).toHaveText(countsLine({ landed: 3, skipped: 4 }));
  await expect(page.getByTestId('seed-batch-counts-batch-0')).toHaveText(
    countsLine({ landed: 3, skipped: 4 }),
  );
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  // Stored outcomes first: exactly the three notes, by digest.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(3);
  for (const text of Object.values(notes)) {
    expect(uploadOf(uploads, digestOf(text)).action).toBe('created');
  }
  // Then the absences: no skipped file was read, posted, or reached the vault.
  expect(importPosts(sent).map(sourcePathOf).sort()).toEqual(['a.md', 'b.md', 'c.md']);
  const reads = await fileReads(page);
  expect([...reads].sort()).toEqual([
    `${namespace}/a.md`,
    `${namespace}/b.md`,
    `${namespace}/c.md`,
  ]);
  const received = after.received.map((entry) => entry.digest);
  for (const skipped of [csv, csv.replace('2024', '2025'), json, OBSIDIAN_CONFIG]) {
    expect(received).not.toContain(digestOf(skipped));
  }
});
