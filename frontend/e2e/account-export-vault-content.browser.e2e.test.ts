import { createHash } from 'node:crypto';

import { expect, test, type Page, type Response } from '@playwright/test';

import { exportThroughScreen } from './exportBrowserSupport';
import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import { lane, serverLogSince, serverLogSize, vaultLedger } from './seedBrowserSupport';

/**
 * "What my vault holds": a managed-vault writer takes back what only the vault
 * keeps (#3579).
 *
 * The real browser, the real server and the lane's Creek vault -- the process
 * the server's production `CREEK_VAULT_URL` names -- with nothing stubbed in
 * between. The bound owner opens Settings -> Export my data and presses the
 * vault button; the server handshakes, declares contract 0.27 on Creek's owner
 * export (`GET /v1/export`) and streams it page by page into the file the
 * browser saves. The vault's content is synthetic and fixed, and no journey
 * ever sends it there, so finding its canary document in the saved file can
 * only mean the bytes came out of the vault.
 *
 * The saved file is checked against both ends: byte-for-byte against the
 * server's own HTTP answer, and item-for-item against the pages the vault
 * served (`GET /__lane/export-pages`), with the document's bytes re-hashed
 * here rather than trusted. The vault's ledger proves both pages were asked
 * for at 0.27 with the cursor page one minted.
 *
 * A vault older than 0.27 -- one that never names `export`, and one that names
 * it while listing 0.26 at most -- is never asked: the screen says it needs an
 * update and the browser saves nothing.
 */

const EXPORT_ROUTE = '/users/me/export/vault';
const VAULT_EXPORT_PATH = '/v1/export';
const EXPORT_MINOR = '0.27';
const NEEDS_UPDATE = 'vault_export_needs_update';
const NEEDS_UPDATE_LINE =
  'Your vault needs an update before its content can be exported. Nothing was saved.';
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;

interface WireDocument {
  document_id: string;
  size_bytes: number;
  sha256: string | null;
  content_base64: string | null;
  content_included: boolean;
}

interface WireFragment {
  fragment_id: string;
  tier: string;
  markdown: string | null;
  document_id: string | null;
}

interface WirePage {
  documents: WireDocument[];
  fragments: WireFragment[];
  next_cursor: string | null;
}

interface ExportItem {
  kind: 'document' | 'fragment';
  [field: string]: unknown;
}

interface VaultExportFile {
  format: string;
  format_version: number;
  items: ExportItem[];
  skipped: number;
  content_withheld: number;
  complete: boolean;
  incomplete_reason: string | null;
}

interface ExportRead {
  path: string;
  declared?: string | null;
  cursor?: string | null;
}

test.afterEach(async ({ page }) => {
  // The lane vault is shared by every spec: no later journey may see an export.
  await setExport(page, 'withdraw-export');
});

async function setExport(
  page: Page,
  control: 'advertise-export' | 'advertise-export-unserved' | 'withdraw-export',
): Promise<void> {
  const response = await page.request.post(`${lane().vaultUrl}/__lane/${control}`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(HTTP_OK);
}

async function servedPages(page: Page): Promise<WirePage[]> {
  const response = await page.request.get(`${lane().vaultUrl}/__lane/export-pages`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(HTTP_OK);
  return ((await response.json()) as { pages: WirePage[] }).pages;
}

async function exportReads(page: Page, from: number): Promise<ExportRead[]> {
  const ledger = (await vaultLedger(page)) as { received: ExportRead[] };
  return ledger.received.slice(from).filter((entry) => entry.path === VAULT_EXPORT_PATH);
}

async function ledgerLength(page: Page): Promise<number> {
  return (await vaultLedger(page)).received.length;
}

/** Log the bound vault owner in through the real login screen; answers its token. */
async function loginVaultOwner(page: Page): Promise<string> {
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(HTTP_OK);
  const token = ((await response.json()) as { token: string }).token;
  const flags = await page.request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  expect(flags.status()).toBe(HTTP_OK);
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return token;
}

async function openExportScreen(page: Page): Promise<void> {
  await page.goto(`${frontendUrl()}/settings`);
  await page.getByTestId('settings-row-export-data').click();
  await expect(page.getByTestId('export-data-vault')).toBeEnabled();
}

function vaultExportAnswer(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === EXPORT_ROUTE,
  );
}

/** What the file must carry for one served page: documents first, each tagged by kind. */
function expectedItems(pages: readonly WirePage[]): ExportItem[] {
  return pages.flatMap((served) => [
    ...served.documents.map((document) => ({ kind: 'document' as const, ...document })),
    ...served.fragments.map((fragment) => ({ kind: 'fragment' as const, ...fragment })),
  ]);
}

/** Every included document decodes to exactly the size and digest it claims. */
function expectIntact(document: WireDocument): Buffer {
  expect(document.content_included).toBe(true);
  const raw = Buffer.from(document.content_base64 ?? '', 'base64');
  expect(raw.toString('base64')).toBe(document.content_base64);
  expect(raw.length).toBe(document.size_bytes);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(document.sha256);
  return raw;
}

test('a managed vault hands its writer everything it holds, across both pages', async ({
  page,
}) => {
  const token = await loginVaultOwner(page);
  await setExport(page, 'advertise-export');
  const pages = await servedPages(page);
  // The arrangement the claims below rest on: two pages joined by a cursor,
  // a staged document, and an Intimate fragment behind the cursor.
  expect(pages).toHaveLength(2);
  const [first, second] = pages as [WirePage, WirePage];
  expect(first.next_cursor).toMatch(/^f-[0-9a-f]{64}$/u);
  expect(second.next_cursor).toBeNull();
  const canary = first.documents[0] as WireDocument;
  const canaryText = expectIntact(canary).toString('utf8');
  const intimate = second.fragments.find((fragment) => fragment.tier === 'intimate');
  if (intimate?.markdown == null) throw new Error('the lane vault serves no Intimate fragment');
  const intimateLine = intimate.markdown.trim().split('\n').at(-1) ?? '';
  expect(intimateLine).not.toBe('');

  // Nothing adepthood keeps of its own holds the canary: only the vault can.
  const archive = await page.request.get(`${backendUrl()}/users/me/export`, {
    headers: bearer(token),
  });
  expect(archive.status()).toBe(HTTP_OK);
  const archived = await archive.text();
  expect(archived).not.toContain(canary.document_id);
  expect(archived).not.toContain(canaryText.trim());

  await openExportScreen(page);
  const ledgerFrom = await ledgerLength(page);
  const logFrom = serverLogSize();
  const answered = vaultExportAnswer(page);
  const downloaded = await exportThroughScreen(page, 'export-data-vault');
  const answer = await answered;

  // The real HTTP answer, saved verbatim.
  expect(answer.status()).toBe(HTTP_OK);
  expect(answer.headers()['content-type']).toContain('application/json');
  expect(downloaded.contents).toBe(await answer.text());
  expect(downloaded.suggestedFilename).toMatch(/^adepthood-vault-\d{4}-\d{2}-\d{2}\.json$/u);

  // Whole, and exactly what the vault served across both pages.
  const file = JSON.parse(downloaded.contents) as VaultExportFile;
  expect(file.format).toBe('adepthood-vault-export');
  expect(file.format_version).toBeGreaterThan(0);
  expect(file.complete).toBe(true);
  expect(file.incomplete_reason).toBeNull();
  expect(file.skipped).toBe(0);
  expect(file.content_withheld).toBe(0);
  expect(file.items).toEqual(expectedItems(pages));
  const saved = file.items.find(
    (item) => item.kind === 'document' && item.document_id === canary.document_id,
  ) as (ExportItem & WireDocument) | undefined;
  if (saved === undefined) throw new Error('the saved file lost the canary document');
  expect(expectIntact(saved).toString('utf8')).toBe(canaryText);
  expect(file.items).toContainEqual(
    expect.objectContaining({ kind: 'fragment', tier: 'intimate', markdown: intimate.markdown }),
  );
  for (const served of second.fragments) {
    expect(file.items).toContainEqual(expect.objectContaining({ fragment_id: served.fragment_id }));
  }

  // The vault was asked twice, at 0.27, the second time at page one's cursor.
  const reads = await exportReads(page, ledgerFrom);
  expect(reads.map((read) => [read.declared, read.cursor])).toEqual([
    [EXPORT_MINOR, null],
    [EXPORT_MINOR, first.next_cursor],
  ]);

  // The receipt reports it whole, and the server logged none of it.
  await expect(page.getByTestId('export-data-receipt-saved')).toHaveText(
    `Saved ${file.items.length} items from your vault to ${downloaded.suggestedFilename}.`,
  );
  await expect(page.getByTestId('export-data-receipt-incomplete')).toHaveCount(0);
  await expect(page.getByTestId('export-data-error')).toHaveCount(0);
  const logged = serverLogSince(logFrom);
  for (const needle of [canaryText.trim(), intimateLine, canary.document_id]) {
    expect(logged).not.toContain(needle);
  }
});

test('a vault older than 0.27 is never asked, and nothing is saved', async ({ page }) => {
  await loginVaultOwner(page);
  await openExportScreen(page);
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const ledgerFrom = await ledgerLength(page);

  // First a vault on an image that never named `export`, then one that names it
  // while listing 0.26 at most: both are a vault that needs an update.
  for (const control of ['withdraw-export', 'advertise-export-unserved'] as const) {
    await setExport(page, control);
    const answered = vaultExportAnswer(page);
    await page.getByTestId('export-data-vault').click();
    const answer = await answered;
    expect(answer.status()).toBe(HTTP_CONFLICT);
    expect(((await answer.json()) as { detail: string }).detail).toBe(NEEDS_UPDATE);
    await expect(page.getByTestId('export-data-error')).toHaveText(NEEDS_UPDATE_LINE);
    await expect(page.getByTestId('export-data-receipt')).toHaveCount(0);
    await expect(page.getByTestId('export-data-vault')).toBeEnabled();
  }

  // Asserted after the refusals, which prove the vault was reached for its
  // handshake: the export read itself never left the server.
  const handshakes = (await vaultLedger(page)).received
    .slice(ledgerFrom)
    .filter((entry) => entry.path === '/v1/capabilities');
  expect(handshakes.length).toBeGreaterThanOrEqual(2);
  expect(await exportReads(page, ledgerFrom)).toEqual([]);
  expect(downloads).toEqual([]);
});
