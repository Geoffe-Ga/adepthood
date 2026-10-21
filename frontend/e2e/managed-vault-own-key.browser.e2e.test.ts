import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

// A routed read can still be awaiting `route.fetch()` when the test ends, and
// that fetch then rejects with "Test ended" outside any test (#3481). Unroute
// first so a straggler's late error is dropped rather than failing the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/**
 * A managed vault writes with the writer's own key (#3437, ADR 0009's
 * 2026-10-16 amendment; Creek-Vault ADR-0015).
 *
 * The real client, the real server and the lane's Creek vault, with nothing
 * stubbed in between: the bound owner saves an Anthropic key in Settings, the
 * lane vault advertises `request_key_providers` like a Creek 0.18 managed vault,
 * and a reading is asked for through the UI. The seam is proved from both ends:
 * the page shows the per-use label before and after, the wallet is untouched,
 * and the vault's own ledger shows the key arrived -- by digest, on
 * `POST /v1/reflections` and on nothing else.
 */
const PAGE_BODY = 'The willow bent all night and did not break. I woke grateful beside the water.';
/** A well-formed lane key; the lane vault never calls a vendor, so it is never used. */
const OWN_KEY = 'sk-ant-api03-lane3437managedVAULTownKEYzz'; // pragma: allowlist secret
/** The receipt's payment route, after the pass. */
const LABEL = 'Paid by your own Anthropic key, through your vault';
/** The price line, before anything runs: future tense, naming the hop. */
const EXPLAINER = 'Your vault will write this reading with your own Anthropic key.';
const ARTIFACTS =
  process.env.MANAGED_VAULT_KEY_ARTIFACTS ?? join(__dirname, 'artifacts', 'managed-vault-own-key');

function lane() {
  const state = readLaneState();
  if (!state) throw new Error('managed-vault own-key lane state is missing');
  return state;
}

interface KeyedRequest {
  method: string;
  path: string;
  provider: string | null;
  keyDigest: string;
}

async function keyedRequests(page: Page): Promise<KeyedRequest[]> {
  const response = await page.request.get(`${lane().vaultUrl}/__lane/uploads`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { keyed: KeyedRequest[] }).keyed;
}

async function setAdvertised(page: Page, advertised: boolean): Promise<void> {
  const path = advertised ? 'advertise-request-keys' : 'withdraw-request-keys';
  const response = await page.request.post(`${lane().vaultUrl}/__lane/${path}`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(200);
}

function wallet(): { monthly_messages_used: number; offering_balance: number } {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', lane().vaultOwnerEmail]),
  );
}

async function loginVaultOwner(page: Page): Promise<string> {
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
  return token;
}

async function writeFinishedPage(page: Page, token: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The willow', message: PAGE_BODY, classification: 'personal' },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${id}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(200);
  return id;
}

async function frame(page: Page, name: string, target?: Locator): Promise<void> {
  // Centred rather than merely "in view", so the frame shows the copy and its context.
  if (target) await target.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

/** Double every text node's computed size, the way the 200% text-zoom frames do. */
async function doubleText(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      const style = getComputedStyle(element);
      element.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
      const line = Number.parseFloat(style.lineHeight);
      if (Number.isFinite(line)) element.style.lineHeight = `${line * 2}px`;
    }
  });
}

/** The copy fits its box and the viewport: nothing clipped, nothing off-screen. */
async function fits(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const ok = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.left >= 0 &&
      box.right <= innerWidth &&
      element.scrollWidth <= element.clientWidth + 1
    );
  });
  expect(ok).toBe(true);
}

test.afterEach(async ({ page }) => {
  // The lane vault is shared by every spec: no later journey may see a managed vault.
  await setAdvertised(page, false);
});

for (const width of [390, 1280]) {
  test(`a managed vault reading is written with the writer's own key at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const token = await loginVaultOwner(page);
    await page.goto(`${frontendUrl()}/api-key-settings`);
    await page.getByTestId('api-key-input').fill(OWN_KEY);
    await page.getByTestId('save-key-button').click();
    await expect(page.getByTestId('stored-key-card')).toBeVisible();
    const disclosure = page.getByText(/With a managed vault, those features pass it on/u);
    await expect(disclosure).toBeVisible();
    await fits(disclosure);
    await frame(page, `settings-disclosure-${width}`, disclosure);

    await setAdvertised(page, true);
    const id = await writeFinishedPage(page, token);
    const before = wallet();
    const keyedBefore = (await keyedRequests(page)).length;

    await page.goto(`${frontendUrl()}/journal`);
    await page.getByTestId(`journal-shelf-open-${id}`).click();
    await expect(page.getByTestId('journal-body-read')).toBeVisible();
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const cost = page.getByTestId('resonance-explainer-cost');
    await expect(cost).toContainText(EXPLAINER);
    await expect(cost).toContainText('Your key pays for it, not your BotMason messages.');
    await fits(cost);
    await frame(page, `explainer-${width}`, cost);

    const pass = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && new URL(r.url()).pathname === `/journal/${id}/resonance`,
    );
    // A completed pass asks the server whether to raise the corpus invitation.
    const invitationRead = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/corpus/invitation',
    );
    await page.getByTestId('resonance-explainer-continue').click();
    const answered = await pass;
    expect(answered.status()).toBe(200);
    const body = (await answered.json()) as {
      provenance: { paid_by: string; own_key_vendor: string | null };
    };
    expect(body.provenance).toMatchObject({ paid_by: 'own_key', own_key_vendor: 'anthropic' });
    expect(answered.request().headers()['x-llm-api-key']).toBe(OWN_KEY);

    const payer = page.getByTestId('resonance-pass-receipt').getByTestId('resonance-pass-payer');
    await expect(payer).toHaveText(LABEL);
    // The corpus invitation a first pass can raise is its own, separate offer.
    // Decide from the server's answer, not from whether the note is up yet (#3481).
    const invitationReply = await invitationRead;
    expect(invitationReply.status()).toBe(200);
    if (((await invitationReply.json()) as { offer: boolean }).offer)
      await page.getByTestId('journal-corpus-invitation-dismiss').click();
    await fits(payer);
    await frame(page, `receipt-${width}`, payer);
    await doubleText(page);
    await fits(payer);
    await frame(page, `receipt-${width}-200-percent`, payer);

    expect(wallet()).toMatchObject({
      monthly_messages_used: before.monthly_messages_used,
      offering_balance: before.offering_balance,
    });
    const digest = createHash('sha256').update(OWN_KEY, 'utf8').digest('hex');
    const keyed = (await keyedRequests(page)).slice(keyedBefore);
    expect(keyed).toEqual([
      { method: 'POST', path: '/v1/reflections', provider: 'anthropic', keyDigest: digest },
    ]);
  });
}

test('the managed vault notice says what happens to the key and the writing', async ({ page }) => {
  // A writer with no vault, shown the managed offer. Only availability is
  // controlled -- the lane's activation switch is off -- the route and screen are real.
  await signUp(page, 'managed-key-notice');
  await page.route('**/vault/activation', async (route) => {
    const actual = await route.fetch();
    const activation = await actual.json();
    await route.fulfill({
      response: actual,
      json: { ...activation, new_activation_available: true },
    });
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${frontendUrl()}/settings`);
    await page.getByTestId('settings-row-vault').click();
    await page.getByTestId('open-vault-activation').click();
    const notice = page.getByTestId('activation-own-key-notice');
    await expect(notice).toContainText('Neither keeps the key');
    await fits(notice);
    await frame(page, `activation-notice-${width}`, notice);
  }
});
