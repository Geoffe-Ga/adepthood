import { expect, test } from '@playwright/test';

import { bearer } from './journalHabitsBrowserSupport';
import {
  chooseFolder,
  digestOf,
  expectLanded,
  importPosts,
  lane,
  loginVaultOwner,
  openSeedScreen,
  recordRequests,
  registerSeedSpec,
  reviewedPaths,
  startImport,
  uploadCount,
  uploadOf,
  uploadsSince,
  vaultLedger,
  type SentRequest,
} from './seedBrowserSupport';

/**
 * One vault pass when a bulk upload drains, in a real browser (#3773).
 *
 * Documents sent as part of an upload run no longer drive the vault's
 * ontologization ladder inside their own requests. When the app-level queue
 * drains with something landed, the app presses `POST /corpus/import/complete`
 * once with the run's own id, and the server hands one full pass to the vault
 * in its background: classification, then temporal, embeddings, eddies and
 * threads -- past every stage's window. Jest pins the drain calling the route
 * and the backend suite pins the ladder against doubles; what only the seam
 * can prove is that a real folder's uploads reach the lane's Creek vault with
 * no classification among them, that exactly one classification and every
 * linker stage follow once the run drains, and that the screen says
 * "Settling what you've sent…" while it goes and that it settled after.
 *
 * The lane's vault does not advertise the batch pipeline by default; the spec
 * switches it on through the vault's own lane control, with its durable jobs
 * held so the settling line can be seen, then releases them. Nothing between
 * the browser and the vault is stubbed.
 *
 * The stored outcome is asserted first, then the wire, then the screen.
 */

const { writeFolder } = registerSeedSpec('adepthood-seed-settle-');

const CLASSIFY_PATH = '/v1/classifications';
const LINKS_PATH = '/v1/links';
const COMPLETE_ROUTE = '/corpus/import/complete';
const SETTLING = "Settling what you've sent…";
const SETTLED = "What you've sent has settled into your vault.";
/** Generous: the app's reads back off to thirty seconds while the pass runs. */
const SETTLE_TIMEOUT_MS = 90_000;

interface PipelineEntry {
  method: string;
  path: string;
  linkMethod?: string;
}

async function control(name: string): Promise<void> {
  const state = lane();
  const response = await fetch(`${state.vaultUrl}/__lane/${name}`, {
    method: 'POST',
    headers: bearer(state.vaultApiKey),
  });
  expect(response.status).toBe(200);
}

function pipelineCalls(received: readonly PipelineEntry[]): PipelineEntry[] {
  return received.filter((entry) => [CLASSIFY_PATH, LINKS_PATH].includes(entry.path));
}

function completePosts(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter(
    (entry) => entry.method === 'POST' && new URL(entry.url).pathname === COMPLETE_ROUTE,
  );
}

test.afterEach(async () => {
  await control('disable-pipeline');
});

test('a drained folder is woven into the vault once: one classification, every link stage, then settled', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const notes: Record<string, string> = {
    'a.md': 'settle sentinel 3773 a: the first note of a bulk upload.\n',
    'b.md': 'settle sentinel 3773 b: the second note of the same run.\n',
  };
  const folder = writeFolder('Settle After Drain 3773', notes);
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  // Advertise the pipeline, with its durable jobs held so the pass stays going.
  await control('enable-pipeline');
  await openSeedScreen(page);

  const before = await vaultLedger(page);
  const pipelineBefore = pipelineCalls(before.received as PipelineEntry[]).length;
  await chooseFolder(page, folder);
  expect(await reviewedPaths(page)).toEqual(['a.md', 'b.md']);
  await startImport(page);
  for (const path of Object.keys(notes)) {
    await expectLanded(page, path);
  }

  // While the classification job is held, the line says the run is settling.
  await expect(page.getByTestId('vault-settle-line')).toHaveText(SETTLING, {
    timeout: SETTLE_TIMEOUT_MS,
  });
  await expect
    .poll(
      async () =>
        pipelineCalls((await vaultLedger(page)).received as PipelineEntry[]).slice(pipelineBefore)
          .length,
      { timeout: SETTLE_TIMEOUT_MS },
    )
    .toBe(1);
  await control('release-pipeline-jobs');
  await expect(page.getByTestId('vault-settle-line')).toHaveText(SETTLED, {
    timeout: SETTLE_TIMEOUT_MS,
  });

  // Stored outcome first: both notes landed once, and after the last of them the
  // vault was asked for one classification and then each linker stage, once.
  const after = await vaultLedger(page);
  const uploads = uploadsSince(after, uploadCount(before));
  expect(uploads).toHaveLength(2);
  for (const content of Object.values(notes)) {
    expect(uploadOf(uploads, digestOf(content)).action).toBe('created');
  }
  const received = after.received as PipelineEntry[];
  const fresh = received.slice(before.received.length);
  const lastUpload = fresh.map((entry) => entry.path).lastIndexOf('/v1/uploads');
  const firstPipeline = fresh.findIndex((entry) =>
    [CLASSIFY_PATH, LINKS_PATH].includes(entry.path),
  );
  expect(firstPipeline).toBeGreaterThan(lastUpload);
  expect(
    pipelineCalls(fresh).map((entry) =>
      entry.path === CLASSIFY_PATH ? 'classify' : entry.linkMethod,
    ),
  ).toEqual(['classify', 'temporal', 'embeddings', 'eddies', 'threads']);

  // Then the wire: one press, for the run every document was sent under.
  const posts = importPosts(sent);
  expect(posts).toHaveLength(2);
  const runs = new Set(
    posts.map((entry) => (JSON.parse(entry.body ?? '{}') as { upload_run?: string }).upload_run),
  );
  expect(runs.size).toBe(1);
  const presses = completePosts(sent);
  expect(presses).toHaveLength(1);
  expect(JSON.parse(presses[0]?.body ?? '{}')).toEqual({ batch_id: [...runs][0], landed: 2 });

  // Then the screen: the queue's own line is gone; only the settled line stays.
  await expect(page.getByTestId('upload-queue-indicator')).toHaveCount(0);
});
