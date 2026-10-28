import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import {
  base64Of,
  chooseFolder,
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
  reviewedPaths,
  runRow,
  sensitiveNeedles,
  serverLogSince,
  serverLogSize,
  sourcePathOf,
  startImport,
  uploadCount,
  uploadFragments,
  uploadOf,
  uploadsSince,
  registerSeedSpec,
  vaultLedger,
  type LedgerFragment,
  type VaultLedger,
} from './seedBrowserSupport';

/**
 * Bringing a whole Obsidian folder into the vault, in a real browser (#3557).
 *
 * The folder goes through Chromium's own directory input: the app builds its
 * hidden `<input type=file webkitdirectory>` and clicks it, and the harness
 * answers the file chooser with a real directory on disk, so every `File`
 * carries the `webkitRelativePath` the browser itself assigned. Nothing about
 * the picker, the manifest, the reader or the sender is replaced. What reads
 * the outcome is the lane's Creek vault -- the process the server's production
 * `CREEK_VAULT_URL` names -- through its own ledger of what arrived, keyed by
 * the opaque external id the server derives and a digest of the bytes.
 *
 * One harness-side seam is used, and only where the lane cannot produce the
 * condition itself. The lane server disarms its rate limiter for every journey,
 * so the 429 the run must wait out is fulfilled by the harness for one request
 * (the envelope `rate_limit.rate_limit_exceeded_response` builds, with its
 * CORS-exposed `Retry-After`); the document still reaches the real server once
 * the wait is over. The forced failure is real: the vault refuses one upload
 * by digest, and the server answers it as it would. Leaving a run mid-flight is
 * its own journey, in `seed-leave-mid-run.browser.e2e.test.ts` (#2423).
 *
 * Stored outcomes are asserted before absences in every test, so a vault the
 * lane never reached cannot make an absence pass.
 */

const UPLOADED_EVENT = 'creek vault upload stored';
const DEGRADED_EVENT = 'creek vault upload degraded';

const WAITING_LINE = 'Pausing a moment so everything goes over at a steady pace. This one is next.';

/** What `rate_limit_exceeded_response` answers, and how long it asks to wait. */
const RATE_LIMIT_BODY = JSON.stringify({ detail: 'rate_limit_exceeded' });
const RETRY_AFTER_SECONDS = 2;
const MS_PER_SECOND = 1_000;
/** Timer slack: a resend this early would mean the wait was not honoured. */
const RETRY_AFTER_TOLERANCE_MS = 100;

/** A one-pixel PNG: a synthetic attachment, a few dozen bytes long. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Settings an Obsidian vault keeps beside the notes, which must never leave. */
const OBSIDIAN_CONFIG = '{"lane3557": "must stay local", "promptDelete": false}\n';

/** Spec-wide scratch space; every folder below lives here and goes with it. */
const { root: scratch, writeFolder } = registerSeedSpec('adepthood-seed-folder-');

/**
 * Record, in the page, every `File` the app reads, by the path the browser gave
 * it. Installed before the app loads, over every way a script can read a Blob.
 */
async function recordFileReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const reads: string[] = [];
    (window as unknown as { __seedReads: string[] }).__seedReads = reads;
    const note = (blob: unknown): void => {
      if (blob instanceof File) reads.push(blob.webkitRelativePath || blob.name);
    };
    const blobMethods = ['arrayBuffer', 'text', 'stream', 'slice', 'bytes'] as const;
    for (const method of blobMethods) {
      const original = (Blob.prototype as unknown as Record<string, unknown>)[method];
      if (typeof original !== 'function') continue;
      Object.defineProperty(Blob.prototype, method, {
        configurable: true,
        writable: true,
        value(this: Blob, ...args: unknown[]) {
          note(this);
          return (original as (...rest: unknown[]) => unknown).apply(this, args);
        },
      });
    }
    const readerMethods = [
      'readAsArrayBuffer',
      'readAsText',
      'readAsDataURL',
      'readAsBinaryString',
    ] as const;
    for (const method of readerMethods) {
      const original = FileReader.prototype[method] as (...rest: unknown[]) => void;
      Object.defineProperty(FileReader.prototype, method, {
        configurable: true,
        writable: true,
        value(this: FileReader, blob: Blob, ...args: unknown[]) {
          note(blob);
          original.call(this, blob, ...args);
        },
      });
    }
  });
}

async function fileReads(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __seedReads: string[] }).__seedReads]);
}

test('a nested folder is reviewed before anything is sent, and its notes land as distinct fragments', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Field Notes 3557';
  const work = '# Work\n\nwork sentinel 3557: the standing meeting moved to Thursdays.\n';
  const home = '# Home\n\nhome sentinel 3557: the fig tree finally fruited.\n';
  const folder = writeFolder(namespace, {
    'Work/Index.md': work,
    'Home/Index.md': home,
    'Attachments/diagram.png': PIXEL_PNG,
    '.obsidian/app.json': OBSIDIAN_CONFIG,
  });
  const sent = recordRequests(page);
  await recordFileReads(page);
  await loginVaultOwner(page);
  const before = await vaultLedger(page);
  const logOffset = serverLogSize();
  await openSeedScreen(page);

  // The browser hands the app the folder with every file's place in it.
  const handed = await chooseFolder(page, folder);
  expect(handed).toEqual([
    `${namespace}/.obsidian/app.json`,
    `${namespace}/Attachments/diagram.png`,
    `${namespace}/Home/Index.md`,
    `${namespace}/Work/Index.md`,
  ]);

  // The review, before anything is sent: two notes, an offered attachment,
  // the settings counted out, and the folder's own name as the import name.
  await expect(page.getByTestId('seed-folder-namespace')).toHaveValue(namespace);
  await expect(page.getByTestId('seed-folder-notes')).toHaveText('2 notes selected');
  await expect(page.getByTestId('seed-folder-skipped')).toContainText('1 app settings');
  expect(await reviewedPaths(page)).toEqual(['Home/Index.md', 'Work/Index.md']);
  await expect(page.getByTestId('seed-folder-attachments')).toBeVisible();
  const readsAtReview = await fileReads(page);
  const postsAtReview = importPosts(sent).length;

  // Put aside: the review closes and the folder is forgotten.
  await page.getByTestId('seed-folder-dismiss').click();
  await expect(page.getByTestId('seed-folder-review')).toHaveCount(0);
  await expect(page.getByTestId('seed-run-list')).toHaveCount(0);
  const afterDismiss = await vaultLedger(page);
  const readsAfterDismiss = await fileReads(page);
  const postsAfterDismiss = importPosts(sent).length;

  // Chosen again and started, with the attachment switched in.
  await chooseFolder(page, folder);
  await page.getByTestId('seed-folder-attachments').click();
  expect(await reviewedPaths(page)).toEqual([
    'Attachments/diagram.png',
    'Home/Index.md',
    'Work/Index.md',
  ]);
  await startImport(page);
  await expect(page.getByTestId('seed-summary')).toHaveText('All 3 have landed.');
  for (const path of ['Attachments/diagram.png', 'Home/Index.md', 'Work/Index.md']) {
    await expectLanded(page, path);
  }

  // Stored outcomes first: three uploads, one per document, by digest.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(afterDismiss));
  expect(uploads).toHaveLength(3);
  const workUpload = uploadOf(uploads, digestOf(work));
  const homeUpload = uploadOf(uploads, digestOf(home));
  const pngUpload = uploadOf(uploads, digestOf(PIXEL_PNG));
  for (const upload of [workUpload, homeUpload, pngUpload]) {
    expect(upload.action).toBe('created');
    expect(upload.tier).toBe('personal');
  }
  // Same basename, different folders: two identities, two fragments.
  const ids = [workUpload.externalId, homeUpload.externalId, pngUpload.externalId];
  expect(new Set(ids).size).toBe(3);
  const fragments = uploadFragments(after).filter((fragment) => ids.includes(fragment.externalId));
  expect(fragments).toHaveLength(3);
  expect(new Set(fragments.map((fragment) => fragment.fragmentId)).size).toBe(3);
  expect(fragments.find((f) => f.externalId === workUpload.externalId)?.digest).toBe(
    digestOf(work),
  );
  expect(fragments.find((f) => f.externalId === homeUpload.externalId)?.digest).toBe(
    digestOf(home),
  );
  const posts = importPosts(sent);
  expect(posts.map(sourcePathOf).sort()).toEqual([
    'Attachments/diagram.png',
    'Home/Index.md',
    'Work/Index.md',
  ]);
  const reads = await fileReads(page);
  expect([...reads].sort()).toEqual([
    `${namespace}/Attachments/diagram.png`,
    `${namespace}/Home/Index.md`,
    `${namespace}/Work/Index.md`,
  ]);
  // The server's output reaches the file through the runner, so wait for it.
  await expect
    .poll(() => occurrences(serverLogSince(logOffset), UPLOADED_EVENT))
    .toBeGreaterThanOrEqual(3);
  const log = serverLogSince(logOffset);

  // Then the absences, now that arrival is proven. Review and putting aside
  // read nothing and sent nothing.
  expect(readsAtReview).toEqual([]);
  expect(readsAfterDismiss).toEqual([]);
  expect(postsAtReview).toBe(0);
  expect(postsAfterDismiss).toBe(0);
  expect(uploadCount(afterDismiss)).toBe(uploadCount(before));
  // The settings file was never read, never sent, and never reached the vault.
  expect(reads.some((path) => path.includes('.obsidian'))).toBe(false);
  expect(posts.some((entry) => entry.body?.includes('.obsidian') ?? false)).toBe(false);
  expect(posts.some((entry) => entry.body?.includes(base64Of(OBSIDIAN_CONFIG)) ?? false)).toBe(
    false,
  );
  expect(after.received.map((entry) => entry.digest)).not.toContain(digestOf(OBSIDIAN_CONFIG));
  // No request line and no server log line names the folder or carries its bytes.
  const needles = sensitiveNeedles(namespace, [work, home, PIXEL_PNG, OBSIDIAN_CONFIG]);
  expectNoneIn(
    sent.map((entry) => entry.url),
    needles,
  );
  expectNoneIn([log], needles);
});

test('importing the same folder again updates its notes in place, and an edit moves only its own', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Reimported 3557';
  const work = '# Work\n\nreimport work sentinel 3557: first draft.\n';
  const home = '# Home\n\nreimport home sentinel 3557: unchanged throughout.\n';
  const editedWork = '# Work\n\nreimport work sentinel 3557: second draft, edited.\n';
  const folder = writeFolder(namespace, { 'Work/Index.md': work, 'Home/Index.md': home });
  await loginVaultOwner(page);
  await openSeedScreen(page);

  const start = await vaultLedger(page);
  await chooseFolder(page, folder);
  await startImport(page);
  await expect(page.getByTestId('seed-summary')).toHaveText('All 2 have landed.');
  const first = uploadsSince(await vaultLedger(page), uploadCount(start));
  expect(first).toHaveLength(2);
  const workId = uploadOf(first, digestOf(work)).externalId;
  const homeId = uploadOf(first, digestOf(home)).externalId;
  expect(workId).not.toBe(homeId);

  // The same folder, under the same name: the same two identities, unchanged.
  const beforeRepeat = await vaultLedger(page);
  await chooseFolder(page, folder);
  await expect(page.getByTestId('seed-folder-namespace')).toHaveValue(namespace);
  await startImport(page);
  await expect(page.getByTestId('seed-summary')).toHaveText('All 4 have landed.');
  const afterRepeat = await vaultLedger(page);
  const repeat = uploadsSince(afterRepeat, uploadCount(beforeRepeat));
  expect(repeat).toHaveLength(2);
  expect(uploadOf(repeat, digestOf(work)).externalId).toBe(workId);
  expect(uploadOf(repeat, digestOf(home)).externalId).toBe(homeId);
  expect(repeat.map((entry) => entry.action)).toEqual(['unchanged', 'unchanged']);
  const ours = (ledger: VaultLedger): LedgerFragment[] =>
    uploadFragments(ledger).filter((f) => f.externalId === workId || f.externalId === homeId);
  expect(ours(afterRepeat)).toHaveLength(2);
  const workFragment = ours(afterRepeat).find((f) => f.externalId === workId)?.fragmentId;

  // Edit one note on disk and bring the folder in again: only it changes.
  writeFileSync(join(folder, 'Work', 'Index.md'), editedWork);
  const beforeEdit = await vaultLedger(page);
  await chooseFolder(page, folder);
  await startImport(page);
  await expect(page.getByTestId('seed-summary')).toHaveText('All 6 have landed.');
  const afterEdit = await vaultLedger(page);
  const edit = uploadsSince(afterEdit, uploadCount(beforeEdit));
  expect(edit).toHaveLength(2);
  const editedUpload = uploadOf(edit, digestOf(editedWork));
  expect(editedUpload.externalId).toBe(workId);
  expect(editedUpload.action).toBe('updated');
  const homeAgain = uploadOf(edit, digestOf(home));
  expect(homeAgain.externalId).toBe(homeId);
  expect(homeAgain.action).toBe('unchanged');
  // Still two fragments; the Work fragment is the same one, now at the new digest.
  expect(ours(afterEdit)).toHaveLength(2);
  const editedFragment = ours(afterEdit).find((f) => f.externalId === workId);
  expect(editedFragment?.fragmentId).toBe(workFragment);
  expect(editedFragment?.digest).toBe(digestOf(editedWork));
  expect(ours(afterEdit).find((f) => f.externalId === homeId)?.digest).toBe(digestOf(home));
});

test('one document the vault refuses is shown, and trying again sends it under the same identity', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Refused Once 3557';
  const kept = 'retry sentinel 3557: lands the first time.\n';
  const refused = 'retry sentinel 3557: refused once, then kept.\n';
  const folder = writeFolder(namespace, { 'Kept.md': kept, 'Later/Refused.md': refused });
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  const state = lane();
  const armed = await page.request.post(`${state.vaultUrl}/__lane/fail-upload`, {
    headers: bearer(state.vaultApiKey),
    data: { digest: digestOf(refused) },
  });
  expect(armed.status()).toBe(200);
  const logOffset = serverLogSize();

  const before = await vaultLedger(page);
  await chooseFolder(page, folder);
  await startImport(page);
  await expect(page.getByTestId('seed-retry-button')).toHaveText('Try that one again');
  await expectLanded(page, 'Kept.md');
  await expect(runRow(page, 'Later/Refused.md')).toContainText(DEGRADED_LINE_START);
  await expect(page.getByTestId('seed-summary')).toHaveText(
    "1 of 2 landed. 1 couldn't be confirmed.",
  );

  await page.getByTestId('seed-retry-button').click();
  await expectLanded(page, 'Later/Refused.md');
  await expect(page.getByTestId('seed-summary')).toHaveText('All 2 have landed.');
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  // The refused attempt and its retry addressed one identity; the kept note
  // went exactly once.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  const refusedAttempts = uploads.filter((entry) => entry.digest === digestOf(refused));
  expect(refusedAttempts.map((entry) => entry.action)).toEqual(['failed', 'created']);
  expect(refusedAttempts[1]?.externalId).toBe(refusedAttempts[0]?.externalId);
  const keptAttempts = uploads.filter((entry) => entry.digest === digestOf(kept));
  expect(keptAttempts).toHaveLength(1);
  expect(keptAttempts[0]?.externalId).not.toBe(refusedAttempts[0]?.externalId);
  expect(
    uploadFragments(after).filter((f) => f.externalId === refusedAttempts[0]?.externalId),
  ).toHaveLength(1);
  expect(importPosts(sent).map(sourcePathOf)).toEqual([
    'Kept.md',
    'Later/Refused.md',
    'Later/Refused.md',
  ]);
  // The server logged the refusal without naming the document.
  await expect
    .poll(() => occurrences(serverLogSince(logOffset), DEGRADED_EVENT))
    .toBeGreaterThanOrEqual(1);
  const log = serverLogSince(logOffset);
  expectNoneIn([log], sensitiveNeedles(namespace, [kept, refused]));
});

test('a 429 is waited out for its Retry-After, then the queue resumes without re-sending what landed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const namespace = 'Paced 3557';
  const first = 'paced sentinel 3557: goes straight over.\n';
  const second = 'paced sentinel 3557: asked to wait, then goes.\n';
  const folder = writeFolder(namespace, { 'First.md': first, 'Second.md': second });
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);

  // The lane's limiter is off, so the one refusal is the harness's, shaped as
  // the server's own and exposing Retry-After to the page as the server does.
  let refusedAt = 0;
  await page.route(`${backendUrl()}${IMPORT_ROUTE}`, async (route: Route) => {
    const request = route.request();
    const body = request.postData();
    const isSecond =
      request.method() === 'POST' &&
      body !== null &&
      (JSON.parse(body) as { source_relative_path?: string }).source_relative_path === 'Second.md';
    if (isSecond && refusedAt === 0) {
      refusedAt = Date.now();
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: {
          'Retry-After': String(RETRY_AFTER_SECONDS),
          'Access-Control-Allow-Origin': frontendUrl(),
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Expose-Headers': 'Retry-After',
        },
        body: RATE_LIMIT_BODY,
      });
    } else {
      await route.continue();
    }
  });

  const before = await vaultLedger(page);
  await chooseFolder(page, folder);
  await startImport(page);
  await expect(runRow(page, 'Second.md')).toContainText(WAITING_LINE);
  await expectLanded(page, 'First.md');
  await expectLanded(page, 'Second.md');
  await expect(page.getByTestId('seed-summary')).toHaveText('All 2 have landed.');

  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(2);
  expect(uploadOf(uploads, digestOf(first)).action).toBe('created');
  expect(uploadOf(uploads, digestOf(second)).action).toBe('created');

  // Second was asked again only after the wait; First was never re-sent.
  const posts = importPosts(sent);
  expect(posts.map(sourcePathOf)).toEqual(['First.md', 'Second.md', 'Second.md']);
  const resent = posts[2]?.at ?? 0;
  expect(resent - refusedAt).toBeGreaterThanOrEqual(
    RETRY_AFTER_SECONDS * MS_PER_SECOND - RETRY_AFTER_TOLERANCE_MS,
  );
});

test('a single picked document still lands, and a re-send edits the same fragment', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const name = 'single-pick-3557.md';
  const text = 'single sentinel 3557: one file, chosen on its own.\n';
  const path = join(scratch(), name);
  writeFileSync(path, text);
  await loginVaultOwner(page);
  await openSeedScreen(page);

  const pick = async (): Promise<void> => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('seed-choose-button').click();
    await (await chooser).setFiles(path);
  };

  const before = await vaultLedger(page);
  await pick();
  await expect(page.getByTestId('seed-summary')).toHaveText('All 1 have landed.');
  await pick();
  await expect(page.getByTestId('seed-summary')).toHaveText('All 2 have landed.');

  const uploads = uploadsSince(await vaultLedger(page), uploadCount(before));
  expect(uploads).toHaveLength(2);
  expect(uploads.map((entry) => entry.digest)).toEqual([digestOf(text), digestOf(text)]);
  expect(uploads.map((entry) => entry.action)).toEqual(['created', 'unchanged']);
  expect(uploads[1]?.externalId).toBe(uploads[0]?.externalId);
});
