import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { bearer, frontendUrl } from './journalHabitsBrowserSupport';
import {
  expectLanded,
  lane,
  loginVaultOwner,
  registerSeedSpec,
  runRow,
} from './seedBrowserSupport';

/**
 * "Your vault" (#3776): a seeded file says where it landed, and the dashboard it
 * opens shows the folder and the stages Creek ran it through.
 *
 * Nothing on adepthood's side is stubbed. The lane's Creek vault -- the process
 * the server's production `CREEK_VAULT_URL` names -- is armed with
 * `POST /__lane/advertise-pipeline-status`, which lists contracts 0.34 and 0.37
 * and serves Creek's published pipeline-status success cell with its one
 * document re-addressed to every upload the vault holds. The upload goes through the
 * real Seed screen and `POST /corpus/import`, which writes the receipt; the
 * dashboard reads the real `GET /vault/pipeline`, which matches that receipt to
 * Creek's document by the external id it addressed the upload by. So the folder
 * the row and the dashboard name is the one Creek reported for this upload.
 *
 * Disarmed after each test: the lane vault is shared, and every other journey
 * expects a vault that predates 0.34.
 */

const HTTP_OK = 200;

/** Where Creek's published success cell puts its document, in the screen's words. */
const LANDED_LINE = 'Landed in Writing · Substack';
const SUBSTACK_FOLDER = '01-Fragments/Writing/Substack';
/** The published cell's stages for that document, as the dashboard words them. */
const STAGE_TRAIL = 'Brought in ✓ · Classified ✓ · Read for praxis ✓ · Eddies partly';

/** How the screen groups digits, in the lane browser's locale. */
const GROUPED = new Intl.NumberFormat('en-US');
/** Every stage row of "Everything you sent in" (#3796), in pipeline order. */
const STAGE_ROW_LABELS = [
  'Brought in',
  'Classified',
  'Read for praxis',
  'Linked by meaning',
  'Linked in time',
  'Eddies',
  'Threads',
];
/** Rows the published cell's trail stamped ok, so they cover every file and carry the tick. */
const FINISHED_ROWS = [0, 1, 2];
const EDDIES_ROW = 5;
/** Sub-pixel slack when comparing where two boxes end. */
const EDGE_TOLERANCE_PX = 0.5;

interface PipelineTotalsAnswer {
  totals: { sent: Record<string, number> };
  vault: {
    stage_totals: {
      documents: number;
      stages: { stage: string; covered: number; partial: number; failed: number }[];
    } | null;
  } | null;
}

function filesOf(count: number, outOf: number): string {
  return `${GROUPED.format(count)} of ${GROUPED.format(outOf)} ${outOf === 1 ? 'file' : 'files'}`;
}

async function rightEdge(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return box.x + box.width;
}

type StageTotalsAnswer = NonNullable<NonNullable<PipelineTotalsAnswer['vault']>['stage_totals']>;

/** One stage row against Creek's count for it; answers where its count ends. */
async function expectStageRow(
  page: Page,
  index: number,
  label: string,
  totals: StageTotalsAnswer,
): Promise<number> {
  const at = String(index);
  const row = totals.stages[index];
  if (row === undefined) throw new Error(`Creek answered no stage ${at}`);
  await expect(page.getByTestId(`corpus-stage-label-${at}`)).toHaveText(label);
  await expect(page.getByTestId(`corpus-stage-count-${at}`)).toHaveText(
    filesOf(row.covered, totals.documents),
  );
  await expect(page.getByTestId(`corpus-stage-done-${at}`)).toHaveCount(
    FINISHED_ROWS.includes(index) ? 1 : 0,
  );
  return rightEdge(page, `corpus-stage-count-${at}`);
}

/** The section is first on the screen and in words only: no wire token, no share, no bar. */
async function expectQuietAndFirst(page: Page): Promise<void> {
  const section = page.getByTestId('corpus-totals');
  const top = await section.boundingBox();
  const uploads = await page.getByTestId('vault-dashboard-uploads').boundingBox();
  if (top === null || uploads === null) throw new Error('a dashboard section has no box');
  expect(top.y).toBeLessThan(uploads.y);
  const words = await section.innerText();
  for (const token of ['praxis_scanned', 'linked:', 'ingested', 'accepted', '%']) {
    expect(words).not.toContain(token);
  }
  await expect(section.getByRole('progressbar')).toHaveCount(0);
}

/**
 * "Everything you sent in" (#3796) against the answer the screen itself read:
 * the sent line counts every receipt, each stage reads "x of y files" over
 * Creek's whole-corpus totals in the screen's words, a stage that covered
 * everything is ticked, one that left files says so, and the counts share one
 * right edge.
 */
async function expectCorpusTotals(page: Page, answer: PipelineTotalsAnswer): Promise<void> {
  const sent = Object.values(answer.totals.sent).reduce((sum, count) => sum + count, 0);
  const landed = answer.totals.sent.accepted;
  if (landed === undefined || landed === 0) throw new Error('no receipt of this account landed');
  await expect(page.getByTestId('corpus-totals-sent')).toHaveText(
    `${filesOf(landed, sent)} landed`,
  );

  const totals = answer.vault?.stage_totals;
  if (!totals) throw new Error('the lane vault answered no whole-corpus totals');
  expect(totals.documents).toBeGreaterThan(0);
  expect(totals.stages).toHaveLength(STAGE_ROW_LABELS.length);
  const edges: number[] = [];
  for (const [index, label] of STAGE_ROW_LABELS.entries()) {
    edges.push(await expectStageRow(page, index, label, totals));
  }
  const [first] = edges;
  for (const edge of edges) {
    expect(Math.abs(edge - Number(first))).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
  }
  await expect(page.getByTestId(`corpus-stage-left-${String(EDDIES_ROW)}`)).toHaveText(
    `${GROUPED.format(totals.documents)} partly done`,
  );
  await expect(page.getByTestId('corpus-stage-count-0')).toHaveCSS(
    'font-variant-numeric',
    'tabular-nums',
  );
  await expectQuietAndFirst(page);
}

const { root: scratch } = registerSeedSpec('adepthood-vault-dashboard-');

async function setPipelineStatus(
  page: Page,
  control: 'advertise-pipeline-status' | 'withdraw-pipeline-status',
): Promise<void> {
  const response = await page.request.post(`${lane().vaultUrl}/__lane/${control}`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(HTTP_OK);
}

test.afterEach(async ({ page }) => {
  await setPipelineStatus(page, 'withdraw-pipeline-status');
});

test('a seeded file says where it landed, and "Your vault" shows its folder and stages', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const name = 'vault-dashboard-3776.md';
  const path = join(scratch(), name);
  writeFileSync(path, 'dashboard sentinel 3776: where did this land?\n');
  await loginVaultOwner(page);
  await setPipelineStatus(page, 'advertise-pipeline-status');
  // Opened directly rather than through `openSeedScreen`, whose read of the
  // Settings vault body can race the page it replaced (fixed on #3771's branch).
  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-seed-corpus').click();
  await expect(page.getByTestId('seed-choose-button')).toBeEnabled();

  // The finished run reads the receipts, and the row names the folder Creek
  // reported for this upload -- matched by the server, not by the screen.
  const dashboardRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/vault/pipeline' &&
      response.request().method() === 'GET',
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('seed-choose-button').click();
  await (await chooser).setFiles(path);
  await expectLanded(page, name);

  await expect(runRow(page, name)).toContainText(LANDED_LINE);
  const answer = (await (await dashboardRead).json()) as {
    vault_status: string;
    recent_uploads: { filename: string; landed_in: string | null }[];
  };
  expect(answer.vault_status).toBe('ok');
  expect(answer.recent_uploads.find((receipt) => receipt.filename === name)?.landed_in).toBe(
    SUBSTACK_FOLDER,
  );

  const screenRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/vault/pipeline' &&
      response.request().method() === 'GET',
  );
  await page.getByTestId('seed-open-vault-dashboard').click();
  await expect(page.getByTestId('vault-dashboard-screen')).toBeVisible();

  // Everything sent in: every receipt, and each stage over the whole corpus.
  await expectCorpusTotals(page, (await (await screenRead).json()) as PipelineTotalsAnswer);

  // What came in: this file, and where it went.
  const uploads = page.getByTestId('vault-dashboard-uploads');
  await expect(uploads.getByText(name).first()).toBeVisible();
  await expect(uploads.getByText(LANDED_LINE).first()).toBeVisible();

  // What Creek has done: the stages it stamped on the upload, in words.
  await expect(page.getByTestId('vault-document-0')).toContainText(STAGE_TRAIL);

  // The vault's shape, by area and folded: Fragments carries the upload's
  // folder in its one-line summary; an empty area says once what fills it; the
  // frequency folders are said once rather than listed.
  await expect(page.getByTestId('vault-area-count-01-Fragments')).toHaveText('212');
  await expect(page.getByTestId('vault-area-summary-01-Fragments')).toHaveText(
    'Writing · Substack 212',
  );
  await expect(page.getByTestId('vault-area-note-04-Praxis')).toHaveText(
    'Nothing here yet — fills as practices surface in your writing.',
  );
  await expect(page.getByTestId('vault-area-indexed-06-Frequencies')).toHaveText(
    'Notes for all 10 of its folders are kept together here.',
  );
  await expect(page.getByTestId(`vault-folder-${SUBSTACK_FOLDER}`)).toHaveCount(0);

  // Opening an area shows its folders, and a folder Creek leaves to you says why.
  const fragments = page.getByTestId('vault-area-toggle-01-Fragments');
  await expect(fragments).toHaveAttribute('aria-expanded', 'false');
  await fragments.click();
  await expect(fragments).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`vault-folder-count-${SUBSTACK_FOLDER}`)).toHaveText('212');
  await page.getByTestId('vault-area-toggle-09-Reference').click();
  await expect(page.getByTestId('vault-folder-09-Reference/External-Sources')).toContainText(
    "This one doesn't fill on its own — it's yours to fill.",
  );
  const shape = await page.getByTestId('vault-dashboard-shape').innerText();
  for (const token of ['owner_curated', 'container', 'link.eddies', 'linked:eddies']) {
    expect(shape).not.toContain(token);
  }
  expect(shape).not.toContain('holds the folders beneath it');
});

test('a vault that predates the status read says it needs an update', async ({ page }) => {
  await loginVaultOwner(page);
  await setPipelineStatus(page, 'withdraw-pipeline-status');
  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-vault').click();
  await page.getByTestId('vault-open-dashboard').click();

  await expect(page.getByTestId('vault-dashboard-update-needed')).toContainText(
    'Your Corpus needs an update to show this.',
  );
  await expect(page.getByTestId('vault-dashboard-shape')).toHaveCount(0);
  // What was sent is adepthood's own record, so it still shows; the stages do not.
  await expect(page.getByTestId('corpus-totals-sent')).toBeVisible();
  await expect(page.getByTestId('corpus-totals-stages')).toHaveCount(0);
  await expect(page.getByTestId('corpus-totals-update-needed')).toHaveCount(0);
});
