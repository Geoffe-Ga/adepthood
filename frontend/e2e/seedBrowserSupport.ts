import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import { readLaneState, type LaneState } from './laneState';

/**
 * Shared drivers for the browser journeys that seed a vault from
 * "Bring in what you've written" (#3557, #2423, #3229).
 *
 * Every one of them logs in as the lane's vault-bound account, opens the
 * seeding screen through Settings, hands Chromium's own file inputs real files
 * on disk, and reads the outcome back from the lane's Creek vault -- the
 * process the server's production `CREEK_VAULT_URL` names -- through its own
 * ledger of what arrived, keyed by the opaque external id the server derives
 * and a digest of the bytes. Those drivers live here so each journey is its own
 * spec (the journey ledger credits one spec to one journey) without a second
 * copy of any of them.
 *
 * Deliberately does NOT re-export the signup driver: the lane guard requires
 * each spec to import from the literal './journalHabitsBrowserSupport'.
 */

/** Where the fake records what arrived, and the fragments it holds. */
export interface LedgerUpload {
  method: string;
  path: string;
  externalId: string | null;
  tier: string | null;
  digest?: string | null;
  action?: string;
  /** Set only when the vault kept the upload and then spoiled its own reply. */
  reply?: string;
}

export interface LedgerFragment {
  kind: string;
  externalId: string;
  fragmentId: string;
  digest: string;
  writes: number;
}

export interface VaultLedger {
  received: LedgerUpload[];
  fragments: LedgerFragment[];
}

/** One request the page made, as the browser sent it. */
export interface SentRequest {
  method: string;
  url: string;
  body: string | null;
  at: number;
}

const UPLOAD_PATH = '/v1/uploads';
export const IMPORT_ROUTE = '/corpus/import';
const SETTINGS_ROW = 'settings-row-seed-corpus';

/** The run's own words, read from the screen. */
const LANDED_LINE = 'In your vault. It will show up in reflections from here on.';
export const DEGRADED_LINE_START = "We couldn't confirm this reached your vault.";

/** A spec's scratch space: folders written under it go with it. */
export interface ScratchSpace {
  /** The scratch directory itself, once the spec's `beforeAll` has made it. */
  root: () => string;
  /** Write a folder of synthetic files under the scratch space; answers its path. */
  writeFolder: (name: string, files: Readonly<Record<string, string | Buffer>>) => string;
}

/**
 * Register a spec's lifecycle: a scratch directory made before its tests and
 * removed after them, and every route a test held or fulfilled dropped as it
 * ends (one can still be pending when a test finishes). Call once, at the top
 * level of the spec.
 */
export function registerSeedSpec(prefix: string): ScratchSpace {
  let scratch = '';
  test.beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), prefix));
  });
  test.afterAll(() => {
    if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
  return {
    root: () => scratch,
    writeFolder: (name, files) => {
      const root = join(scratch, name);
      for (const [relative, content] of Object.entries(files)) {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      return root;
    },
  };
}

export function lane(): LaneState {
  const state = readLaneState();
  if (!state) throw new Error('the lane recorded no state, so there is no vault to read');
  if (state.vaultOwnerEmail === '') throw new Error('the lane recorded no vault owner');
  return state;
}

/**
 * The fingerprint the vault records, computed independently: a sha256 over the
 * base64 that travels, exactly the field the vault digests.
 */
export function digestOf(content: string | Buffer): string {
  const base64 = (typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString(
    'base64',
  );
  return createHash('sha256').update(base64, 'utf8').digest('hex');
}

export function base64Of(content: string | Buffer): string {
  return (typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64');
}

export async function vaultLedger(page: Page): Promise<VaultLedger> {
  const state = lane();
  const response = await page.request.get(`${state.vaultUrl}/__lane/uploads`, {
    headers: bearer(state.vaultApiKey),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as VaultLedger;
}

/** The uploads that arrived since `from` uploads had. */
export function uploadsSince(ledger: VaultLedger, from: number): LedgerUpload[] {
  return ledger.received.filter((entry) => entry.path === UPLOAD_PATH).slice(from);
}

export function uploadCount(ledger: VaultLedger): number {
  return ledger.received.filter((entry) => entry.path === UPLOAD_PATH).length;
}

export function uploadFragments(ledger: VaultLedger): LedgerFragment[] {
  return ledger.fragments.filter((fragment) => fragment.kind === 'upload');
}

/** The one upload in `uploads` carrying `digest`. */
export function uploadOf(uploads: readonly LedgerUpload[], digest: string): LedgerUpload {
  const matching = uploads.filter((entry) => entry.digest === digest);
  expect(matching).toHaveLength(1);
  return matching[0] as LedgerUpload;
}

function serverLog(): string {
  return readFileSync(lane().serverLogFile, 'utf8');
}

export function serverLogSize(): number {
  return statSync(lane().serverLogFile).size;
}

export function serverLogSince(offset: number): string {
  return serverLog().slice(offset);
}

export function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every request the page sends, recorded as the browser sent it. */
export function recordRequests(page: Page): SentRequest[] {
  const sent: SentRequest[] = [];
  page.on('request', (request: Request) => {
    sent.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
      at: Date.now(),
    });
  });
  return sent;
}

export function importPosts(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter(
    (entry) => entry.method === 'POST' && new URL(entry.url).pathname === IMPORT_ROUTE,
  );
}

export function sourcePathOf(entry: SentRequest): string | null {
  if (entry.body === null) return null;
  const body = JSON.parse(entry.body) as { source_relative_path?: string };
  return body.source_relative_path ?? null;
}

/** What the server said to each page's connection reads, before the rewrite. */
const connectionReads = new WeakMap<Page, { serverSaid: boolean | null }>();

/** Log the bound vault owner in through the real login screen. */
export async function loginVaultOwner(page: Page): Promise<void> {
  connectionReads.set(page, await showDeploymentVault(page));
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(200);
  const token = ((await response.json()) as { token: string }).token;
  const flags = await page.request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  expect(flags.status()).toBe(200);
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
}

/**
 * Let the seeding screen see the vault the server will actually use.
 *
 * The lane's one vault-bound account is bound by the deployment-wide
 * `CREEK_VAULT_OWNER_USER_ID` (the pre-per-user path), and `GET
 * /vault/connection` reads only per-user connections, so for this account it
 * answers `connected: false` even though `POST /corpus/import` forwards its
 * documents to the lane vault. A per-user connection cannot stand in: a
 * user-supplied vault URL must be globally routable, and the lane vault is
 * loopback. So the real answer is fetched from the server and only its
 * `connected` bit is rewritten for the screen's vault-first gate (#3017);
 * every upload still goes to the real server and lands in the real vault
 * double. Answers what the server itself said, for the spec to pin.
 */
async function showDeploymentVault(page: Page): Promise<{ serverSaid: boolean | null }> {
  const observed: { serverSaid: boolean | null } = { serverSaid: null };
  await page.route(`${backendUrl()}/vault/connection`, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
    } else {
      const response = await route.fetch();
      const body = (await response.json()) as { connected: boolean };
      observed.serverSaid = body.connected;
      await route.fulfill({ response, json: { ...body, connected: true } });
    }
  });
  return observed;
}

/** Open "Bring in what you've written" from Settings, as a person would. */
export async function openSeedScreen(page: Page): Promise<void> {
  const observed = connectionReads.get(page);
  if (observed === undefined) throw new Error('log in before opening the seeding screen');
  const vaultRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/vault/connection') && response.request().method() === 'GET',
  );
  await page.goto(`${frontendUrl()}/settings`);
  await vaultRead;
  // Pinned so the rewrite above cannot outlive the gap it bridges: the day the
  // server reports the deployment binding itself, this fails and it goes.
  expect(observed.serverSaid).toBe(false);
  await page.getByTestId(SETTINGS_ROW).click();
  await expect(page.getByTestId('seed-corpus-screen')).toBeVisible();
  await expect(page.getByTestId('seed-choose-folder-button')).toBeEnabled();
}

/**
 * Choose `folder` through the app's own directory input, and answer what the
 * browser handed the app: each file's `webkitRelativePath`, sorted.
 */
export async function chooseFolder(page: Page, folder: string): Promise<string[]> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('seed-choose-folder-button').click();
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(true);
  await fileChooser.setFiles(folder);
  const relativePaths = await fileChooser
    .element()
    .evaluate((input) =>
      [...((input as HTMLInputElement).files ?? [])].map((file) => file.webkitRelativePath),
    );
  await expect(page.getByTestId('seed-folder-review')).toBeVisible();
  return relativePaths.sort();
}

/** The relative paths the review lists, in order. */
export async function reviewedPaths(page: Page): Promise<string[]> {
  return page.getByTestId(/^seed-folder-path-\d+$/u).allTextContents();
}

export async function startImport(page: Page): Promise<void> {
  const start = page.getByTestId('seed-folder-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('seed-folder-review')).toHaveCount(0);
}

/** The run row naming `relativePath`; rows are named by path, so two Index.md differ. */
export function runRow(page: Page, relativePath: string): Locator {
  return page
    .getByTestId(/^seed-item-seed-\d+$/u)
    .filter({ hasText: relativePath })
    .last();
}

export async function expectLanded(page: Page, relativePath: string): Promise<void> {
  await expect(runRow(page, relativePath)).toContainText(LANDED_LINE);
}

/** Strings that name the folder or carry its bytes, none of which may surface. */
export function sensitiveNeedles(
  namespace: string,
  contents: ReadonlyArray<string | Buffer>,
): string[] {
  const needles = [namespace, encodeURIComponent(namespace), 'Index.md', '.obsidian', 'app.json'];
  for (const content of contents) {
    needles.push(base64Of(content));
    if (typeof content === 'string') needles.push(content.split('\n')[0] ?? content);
  }
  needles.push(lane().vaultApiKey);
  return needles;
}

export function expectNoneIn(haystack: readonly string[], needles: readonly string[]): void {
  for (const text of haystack) {
    for (const needle of needles) {
      expect(text.includes(needle), `"${needle}" surfaced in ${text.slice(0, 80)}`).toBe(false);
    }
  }
}
