import { expect, test } from '@playwright/test';

import { bearer } from './journalHabitsBrowserSupport';
import {
  chooseFolder,
  countsLine,
  digestOf,
  expectLanded,
  importPosts,
  IMPORT_ROUTE,
  lane,
  loginVaultOwner,
  openSeedScreen,
  recordRequests,
  registerSeedSpec,
  runRow,
  startImport,
  uploadCount,
  uploadFragments,
  uploadsSince,
  vaultLedger,
} from './seedBrowserSupport';

/**
 * A busy vault is a wait, not twenty failed documents (#3770).
 *
 * Creek refuses `POST /v1/uploads` with `503 temporarily_unavailable` while a
 * classify or link pass holds its content-mutation lock. Until #3770 adepthood
 * answered that as `degraded`, the run charged it against its 20/minute pace and
 * never sent it again, so about one file in twenty landed.
 *
 * Nothing is faked on adepthood's side of the seam. The lane's Creek vault --
 * the process the server's production `CREEK_VAULT_URL` names -- is made busy
 * for its next 19 uploads with `POST /__lane/busy-uploads`, each refusal naming
 * `Retry-After: 1`. Twenty notes then go through Chromium's own directory input
 * and the production run. The real HTTP adapter reads the wait, the real route
 * answers `vault_busy`, the screen shows the row waiting for the vault, and the
 * run sends the same document again once the wait is over.
 *
 * Stored outcome first: the vault's ledger holds 19 busy refusals and then 20
 * created uploads, one fragment per note at the digest the spec computes. Then
 * the wire and the screen.
 */

const NOTE_COUNT = 20;
const BUSY_CALLS = NOTE_COUNT - 1;
const RETRY_AFTER_SECONDS = 1;
const HTTP_ACCEPTED = 202;

/** The row while the vault is busy: the issue's own words open it. */
const VAULT_WAITING_START = 'Waiting for your vault…';

const { writeFolder } = registerSeedSpec('adepthood-seed-vault-busy-');

/** Twenty small, distinct notes under one folder. */
function busyFolderNotes(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    files[`Notes/busy-${String(index).padStart(2, '0')}.md`] =
      `busy vault sentinel 3770 note ${index}: sent while the vault sorted.\n`;
  }
  return files;
}

test('twenty notes sent while the vault is busy for nineteen calls all land', async ({ page }) => {
  test.setTimeout(180_000);
  const files = busyFolderNotes();
  const folder = writeFolder('Busy Vault 3770', files);
  const sent = recordRequests(page);
  await loginVaultOwner(page);
  await openSeedScreen(page);
  const state = lane();
  const armed = await page.request.post(`${state.vaultUrl}/__lane/busy-uploads`, {
    headers: bearer(state.vaultApiKey),
    data: { count: BUSY_CALLS, retry_after_seconds: RETRY_AFTER_SECONDS },
  });
  expect(armed.status()).toBe(200);
  const before = await vaultLedger(page);

  const firstAnswer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === IMPORT_ROUTE && response.request().method() === 'POST',
  );
  await chooseFolder(page, folder);
  await startImport(page);

  // The wire: the first answer is the busy vault, as a wait with its own seconds.
  const answer = await firstAnswer;
  expect(answer.status()).toBe(HTTP_ACCEPTED);
  const body = (await answer.json()) as {
    vault_status: string;
    stored: boolean;
    retry_after_seconds: number | null;
  };
  expect(body).toMatchObject({
    vault_status: 'vault_busy',
    stored: false,
    retry_after_seconds: RETRY_AFTER_SECONDS,
  });

  // The screen: the first note waits for the vault rather than failing.
  const first = Object.keys(files).sort()[0] ?? '';
  await expect(runRow(page, first)).toContainText(VAULT_WAITING_START);

  await expect(page.getByTestId('seed-summary')).toHaveText(countsLine({ landed: NOTE_COUNT }), {
    timeout: 120_000,
  });

  // Stored outcome: 19 refusals that kept nothing, then every note created once.
  const arrived = uploadsSince(await vaultLedger(page), uploadCount(before));
  expect(arrived.filter((entry) => entry.action === 'busy')).toHaveLength(BUSY_CALLS);
  const created = arrived.filter((entry) => entry.action === 'created');
  expect(created).toHaveLength(NOTE_COUNT);
  const expectedDigests = Object.values(files).map((text) => digestOf(text));
  expect(created.map((entry) => entry.digest).sort()).toEqual([...expectedDigests].sort());
  const ids = new Set(created.map((entry) => entry.externalId));
  expect(ids.size).toBe(NOTE_COUNT);
  const ledger = await vaultLedger(page);
  for (const digest of expectedDigests) {
    expect(uploadFragments(ledger).filter((fragment) => fragment.digest === digest)).toHaveLength(
      1,
    );
  }

  // Every busy refusal was the same document sent again, under one identity.
  const busyIds = new Set(
    arrived.filter((entry) => entry.action === 'busy').map((entry) => entry.externalId),
  );
  expect(busyIds.size).toBe(1);

  // The screen: every row landed, none is offered again.
  for (const path of Object.keys(files)) await expectLanded(page, path);
  await expect(page.getByTestId('seed-retry-button')).toHaveCount(0);

  // One run id rode every request, so the server could probe the vault once.
  const runIds = new Set(
    importPosts(sent).map(
      (entry) => (JSON.parse(entry.body ?? '{}') as { upload_run?: string }).upload_run,
    ),
  );
  expect(runIds.size).toBe(1);
  expect([...runIds][0]).toMatch(/^[0-9a-f]{32}$/u);
});
