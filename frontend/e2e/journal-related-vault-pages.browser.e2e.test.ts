import { expect, test, type APIResponse, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

/**
 * The writer's own related vault pages, beside the page, after a reflection
 * (#2408).
 *
 * The lane's one vault-bound account is bound by the deployment-wide
 * `CREEK_VAULT_OWNER_USER_ID`, so its resonance pass is answered by the lane's
 * Creek vault over the real `/v1/reflections` wire and by nothing else. That
 * vault is armed, through its authenticated lane control, to publish beside its
 * one anchored note the `related_praxis` and `related_eddies` of Creek's own
 * vendored `reflections` success cell -- one compiled praxis page and one
 * recurring eddy. Everything between that answer and the pixels is production:
 * the adapter's projection, the route's response, the Zod schema, the hook and
 * the band. Nothing is routed or rewritten at the browser: the journal screen
 * never reads `GET /vault/connection` (which answers `connected: false` for a
 * deployment-bound owner, #3608), so the band has no gate for the lane to fake.
 *
 * The band is collapsed and display-only: one toggle, page titles with their
 * lifecycle and fragment context and excerpts once expanded, and no control
 * that would turn a pattern into a task. A reflection whose answer names no
 * pages leaves no band -- including after a pass that did.
 */

// A routed read can still be awaiting `route.fetch()` when the test ends (#3481).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

interface OwnerWallet {
  monthly_messages_used: number;
  offering_balance: number;
}

/** The bound owner's real wallet, read out of band (`tests.e2e.wallet_audit`). */
function ownerWallet(): OwnerWallet {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', lane().vaultOwnerEmail]),
  ) as OwnerWallet;
}

/**
 * The lane's one vault owner is shared with every other vault journey, and each
 * pass here is charged to that owner's real monthly allowance. Record the wallet
 * before the test and give back what it spent afterwards (on failure too), so
 * these passes cannot leave a later spec facing a 402 it never earned. The
 * restore only undoes spending; it never grants more than was recorded.
 */
let recordedWallet: OwnerWallet | undefined;

test.beforeEach(() => {
  recordedWallet = ownerWallet();
});

test.afterEach(() => {
  const recorded = recordedWallet;
  recordedWallet = undefined;
  // A beforeEach that failed recorded nothing, so there is nothing to give back.
  if (recorded !== undefined) {
    runBackendModule('tests.e2e.restore_allowance', [
      'restore',
      '--email',
      lane().vaultOwnerEmail,
      '--monthly-messages-used',
      String(recorded.monthly_messages_used),
      '--offering-balance',
      String(recorded.offering_balance),
    ]);
    const restored = ownerWallet();
    expect(restored.monthly_messages_used).toBeLessThanOrEqual(recorded.monthly_messages_used);
    expect(restored.offering_balance).toBeGreaterThanOrEqual(recorded.offering_balance);
  }
});

const BAND = 'from-your-creek';
/** The toggle's accessible name says which way it will move the band. */
const COLLAPSED_LABEL = 'Expand related pages from your creek';
const EXPANDED_LABEL = 'Collapse related pages from your creek';
const HTTP_OK = 200;
const HTTP_CREATED = 201;
/** Long enough for a completed pass's response to have rendered whatever it carries. */
const QUIET_PERIOD_MS = 1_500;
const FIRST_BODY =
  'I said yes again to a week I knew would empty me. The pattern is older than this job.';
const SECOND_BODY =
  'The garden needed nothing from me today. I sat with the beans and let them climb.';

interface RelatedPraxisPage {
  title: string;
  praxis_type: string;
  status: string;
  excerpt: string;
}

interface RelatedEddyPage {
  title: string;
  description: string;
  fragment_count: number;
  formed: string;
}

interface RelatedPages {
  related_praxis: RelatedPraxisPage[];
  related_eddies: RelatedEddyPage[];
}

interface ReflectionCall {
  method: string;
  path: string;
  related?: boolean;
}

function lane() {
  const state = readLaneState();
  if (!state || state.vaultOwnerEmail === '') throw new Error('the lane recorded no vault owner');
  return state;
}

async function vaultControl(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
): Promise<APIResponse> {
  const url = `${lane().vaultUrl}${path}`;
  const headers = bearer(lane().vaultApiKey);
  const response = await (method === 'GET'
    ? page.request.get(url, { headers })
    : page.request.post(url, { headers }));
  expect(response.status()).toBe(HTTP_OK);
  return response;
}

/** The pages the lane vault publishes when armed, as Creek's own cell has them. */
async function relatedPages(page: Page): Promise<RelatedPages> {
  return (await (await vaultControl(page, 'GET', '/__lane/related-pages')).json()) as RelatedPages;
}

/** Every reflection the lane vault has answered, in order. */
async function reflections(page: Page): Promise<ReflectionCall[]> {
  const ledger = (await (await vaultControl(page, 'GET', '/__lane/uploads')).json()) as {
    received: ReflectionCall[];
  };
  return ledger.received.filter((call) => call.path === '/v1/reflections');
}

/** Sign the bound owner in through the real log-in screen; returns a token for out-of-band writes. */
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

/** A finished Personal page, written through the server's own journal routes. */
async function finishedPage(page: Page, token: string, message: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: message.slice(0, 24), message, classification: 'personal' },
  });
  expect(created.status()).toBe(HTTP_CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(HTTP_OK);
  return entryId;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

/**
 * Ask the open page for a pass, through the spend disclosure when it is shown,
 * and answer the pass's response body once it has landed.
 */
async function askForPass(page: Page, entryId: number): Promise<RelatedPages> {
  const passed = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/${String(entryId)}/resonance`,
  );
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const explainer = page.getByTestId('resonance-explainer-continue');
  const first = await Promise.race([
    passed.then(() => 'passed' as const),
    explainer.waitFor().then(() => 'explainer' as const),
  ]);
  if (first === 'explainer') await explainer.click();
  const response = await passed;
  expect(response.status()).toBe(HTTP_OK);
  const body = (await response.json()) as RelatedPages & { marginalia: { id: number }[] };
  // The vault's anchored note is what the pages sit beside: a pass that kept
  // no notes reports no pages, by design.
  expect(body.marginalia.length).toBeGreaterThan(0);
  // Rendered in the margin. A second pass on the same page may keep a note the
  // margin already shows, so any note card answers.
  await expect(
    page.getByTestId('journal-margin-column').locator('[data-testid^="margin-note-"]').first(),
  ).toBeVisible();
  return body;
}

/** Wait out the render a pass set off, then the band must still be absent. */
async function expectNoBand(page: Page): Promise<void> {
  await page.waitForTimeout(QUIET_PERIOD_MS);
  await expect(page.getByTestId(BAND)).toHaveCount(0);
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('a vault reflection that names a praxis page and an eddy shows them in a collapsed band beside the page', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await loginVaultOwner(page);
  const entryId = await finishedPage(page, token, FIRST_BODY);
  const pages = await relatedPages(page);
  const [praxis] = pages.related_praxis;
  const [eddy] = pages.related_eddies;
  if (praxis === undefined || eddy === undefined) throw new Error('the lane vault armed no pages');

  await openEntry(page, entryId);
  // Opening a page shows nothing of the vault: the pages ride on a reflection.
  await expect(page.getByTestId(BAND)).toHaveCount(0);

  const asked = (await reflections(page)).length;
  await vaultControl(page, 'POST', '/__lane/relate-next-reflection');
  const answer = await askForPass(page, entryId);
  // The vault answered this pass, with the pages, and the server passed them on.
  const served = (await reflections(page)).slice(asked);
  expect(served).toHaveLength(1);
  expect(served[0]?.related).toBe(true);
  expect(answer.related_praxis).toEqual(pages.related_praxis);
  expect(answer.related_eddies).toEqual(pages.related_eddies);

  // Collapsed: a titled toggle and a count, nothing of the pages themselves.
  const band = page.getByTestId(BAND);
  await expect(band).toBeVisible();
  const toggle = page.getByTestId(`${BAND}-toggle`);
  await expect(toggle).toHaveAttribute('aria-label', COLLAPSED_LABEL);
  await expect(page.getByTestId(`${BAND}-title`)).toHaveText('From your creek');
  await expect(toggle).toContainText('2 pages');
  await expect(page.getByTestId(`${BAND}-body`)).toHaveCount(0);
  await expect(band.getByText(praxis.title)).toHaveCount(0);

  // Beside the page: on the screen, never in the margin column or the sheet,
  // and never drawn over the page's own text.
  await expect(page.getByTestId('journal-screen').getByTestId(BAND)).toHaveCount(1);
  await expect(page.getByTestId('journal-margin-column').getByTestId(BAND)).toHaveCount(0);
  await expect(page.getByTestId('journal-sheet').getByTestId(BAND)).toHaveCount(0);
  const bandBox = await band.boundingBox();
  const bodyBox = await page.getByTestId('journal-body-read').boundingBox();
  expect(bandBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  if (bandBox && bodyBox) expect(overlaps(bandBox, bodyBox)).toBe(false);

  // Expanded: each page's title, its quiet context, and its own words.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', EXPANDED_LABEL);
  const body = page.getByTestId(`${BAND}-body`);
  await expect(body).toBeVisible();
  const praxisSection = page.getByTestId(`${BAND}-praxis`);
  await expect(praxisSection.getByText(praxis.title, { exact: true })).toBeVisible();
  await expect(
    praxisSection.getByText(`${praxis.praxis_type} · ${praxis.status}`, { exact: true }),
  ).toBeVisible();
  await expect(praxisSection.getByText(praxis.excerpt, { exact: true })).toBeVisible();
  const eddySection = page.getByTestId(`${BAND}-eddies`);
  await expect(eddySection.getByText(eddy.title, { exact: true })).toBeVisible();
  await expect(eddySection.getByText(eddy.description, { exact: true })).toBeVisible();
  await expect(
    eddySection.getByText(
      new RegExp(`^${String(eddy.fragment_count)} pieces of your writing`, 'u'),
    ),
  ).toBeVisible();
  // Display-only: the one control in the band is its own toggle.
  await expect(band.getByRole('button')).toHaveCount(1);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', COLLAPSED_LABEL);
  await expect(page.getByTestId(`${BAND}-body`)).toHaveCount(0);
});

test('a reflection that names no pages leaves no band, even after one that did', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await loginVaultOwner(page);
  const related = await finishedPage(page, token, FIRST_BODY);
  const plain = await finishedPage(page, token, SECOND_BODY);

  // An unarmed vault answers with its note and no pages: no band at all.
  await openEntry(page, plain);
  const asked = (await reflections(page)).length;
  const empty = await askForPass(page, plain);
  expect(empty.related_praxis).toEqual([]);
  expect(empty.related_eddies).toEqual([]);
  expect((await reflections(page)).slice(asked).map((call) => call.related)).toEqual([false]);
  await expectNoBand(page);

  // A pass that named pages, then one that names none on the same page: the
  // band describes the latest reflection only, so it goes.
  await openEntry(page, related);
  await vaultControl(page, 'POST', '/__lane/relate-next-reflection');
  await askForPass(page, related);
  await expect(page.getByTestId(BAND)).toBeVisible();
  const again = await askForPass(page, related);
  expect(again.related_praxis).toEqual([]);
  expect(again.related_eddies).toEqual([]);
  await expectNoBand(page);
});
