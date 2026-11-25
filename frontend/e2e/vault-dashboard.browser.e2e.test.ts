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

  await page.getByTestId('seed-open-vault-dashboard').click();
  await expect(page.getByTestId('vault-dashboard-screen')).toBeVisible();

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
    "Creek doesn't fill this one on its own — it's yours to fill.",
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
    'Your vault needs an update to show this.',
  );
  await expect(page.getByTestId('vault-dashboard-shape')).toHaveCount(0);
});
