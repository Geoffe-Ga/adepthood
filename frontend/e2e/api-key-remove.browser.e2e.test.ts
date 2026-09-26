import { randomBytes } from 'crypto';

import { expect, test, type Page, type Request } from '@playwright/test';

import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

/**
 * Removing a device-stored API key, in a real browser (#2928).
 *
 * "Remove key" used to confirm through `Alert.alert`, which react-native-web
 * ships as an empty method: on web the dialog never appeared and the key could
 * not be removed, while the Jest specs -- which spied on `Alert.alert` and fired
 * the button by hand -- stayed green. Only a browser can settle that the
 * rendered confirm is really there and really answers.
 *
 * Removal itself is device-local; no route is called. So the seam this spec
 * proves is what removal is *for*, on both ways the client picks a key:
 *
 * - The resonance pass pins the payer it disclosed and passes that key
 *   explicitly. After removal it is disclosed as, billed as, and sent as the
 *   shared allowance: no `X-LLM-API-Key` header, one monthly message drawn.
 *   This catches a build that hid the card while the key stayed in context.
 * - The margin-note essay passes no key, so it reads the session getter that
 *   `ApiKeyContext` registers. After removal, in the same session and before
 *   any reload, it too leaves without the header. This catches a build whose
 *   in-memory getter kept returning the removed key -- the resonance pass alone
 *   cannot, because an explicit key never consults the getter.
 *
 * Controls made while the key is stored -- the pass, and the completion check
 * the refused pass runs through the same getter -- carry the header, so its
 * later absence is an observation rather than a recorder that never looked.
 *
 * The controls are answered at the browser boundary and never reach the lane's
 * backend or its fake provider. The fake's attempt counters are lane-global and
 * `resonance-credit-exhausted` asserts they start at zero, so a spec that only
 * needs to *see* a header must not spend one of them. The key is minted here,
 * device-only, for the same reason: it is never meant to reach a provider.
 */

const READABLE_PAGE =
  'The heron stood in the shallows until the light changed. I stood with it, ' +
  'and for once did not reach for anything.';

const LLM_KEY_HEADER = 'x-llm-api-key'; // pragma: allowlist secret

/** Non-transient and neither 401 (token refresh) nor 402 (refill invitation). */
const CONTROL_REFUSAL_STATUS = 422;
const KEY_ENTROPY_BYTES = 24;

interface Usage {
  monthly_messages_used: number;
  offering_balance: number;
}

/** Every POST this browser sends whose path matches `route`, in order. */
function recordPosts(page: Page, route: RegExp): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && route.test(new URL(request.url()).pathname)) {
      sent.push(request);
    }
  });
  return sent;
}

async function usage(page: Page, token: string): Promise<Usage> {
  const response = await page.request.get(`${backendUrl()}/user/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Usage;
}

/** A well-formed key that exists only on this device and reaches no provider. */
function deviceOnlyKey(): string {
  return `sk-remove-${randomBytes(KEY_ENTROPY_BYTES).toString('hex')}`;
}

/**
 * Answer the control requests in the browser, so the header is observed on a
 * real outgoing request while nothing reaches the backend or the fake provider.
 */
async function refuseControlRequests(page: Page, entryId: number): Promise<() => Promise<void>> {
  const control = new RegExp(`/journal/${String(entryId)}/(resonance|suggestions/detect)$`, 'u');
  const matcher = (url: URL): boolean => control.test(url.pathname);
  await page.route(matcher, (route) =>
    route.fulfill({
      status: CONTROL_REFUSAL_STATUS,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'lane_control_refused' }),
    }),
  );
  return () => page.unroute(matcher);
}

/** Save a key through the same screen a writer uses. */
async function storeApiKey(page: Page, key: string): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

/**
 * The lane fake provider's attempt counters. They are lane-global and another
 * spec asserts they start at zero, so this spec proves it leaves them as found.
 */
async function providerAttempts(page: Page): Promise<unknown> {
  const providerUrl = readLaneState()?.providerUrl;
  if (!providerUrl) throw new Error('the browser lane booted no fake provider to read');
  const response = await page.request.get(`${providerUrl}/__lane/attempts`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function writeFinishedPage(page: Page, token: string): Promise<number> {
  const headers = { Authorization: `Bearer ${token}` };
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'The heron', message: READABLE_PAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  return entryId;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
}

test('a removed key stops travelling and the shared allowance pays', async ({ page }) => {
  const attemptsBefore = await providerAttempts(page);
  const email = await signUp(page, 'api-key-remove');
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(page, token);
  const passes = recordPosts(page, new RegExp(`/journal/${String(entryId)}/resonance$`, 'u'));
  const detections = recordPosts(
    page,
    new RegExp(`/journal/${String(entryId)}/suggestions/detect$`, 'u'),
  );
  const essays = recordPosts(page, /\/journal\/marginalia\/\d+\/essay$/u);
  const key = deviceOnlyKey();

  // 1. Control: with the key stored, a pass carries it. The pass is answered in
  //    the browser, so it reaches no server, and neither BotMason bucket moves.
  await storeApiKey(page, key);
  const walletWithKey = await usage(page, token);
  const releaseControls = await refuseControlRequests(page, entryId);
  await openEntry(page, entryId);
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText('Your own API key pays');
  await page.getByTestId('resonance-explainer-continue').click();
  await expect.poll(() => passes.length).toBe(1);
  expect(passes[0]?.headers()[LLM_KEY_HEADER]).toBe(key);
  await expect(page.getByTestId('journal-resonance-error')).toBeVisible();
  // The refused pass still runs the completion check, which passes no key and
  // so reads the session getter: while the key is stored, the getter sends it.
  await expect.poll(() => detections.length).toBe(1);
  expect(detections[0]?.headers()[LLM_KEY_HEADER]).toBe(key);
  expect(await usage(page, token)).toEqual(walletWithKey);
  await releaseControls();

  // 2. From the entry's own shortcut -- in-app navigation, so the session that
  //    held the key stays alive -- cancelling the rendered confirm keeps it.
  await page.getByRole('button', { name: 'Add or change your API key' }).click();
  await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
  await page.getByTestId('remove-key-button').click();
  await expect(page.getByTestId('remove-key-dialog')).toBeVisible();
  await expect(page.getByTestId('remove-key-dialog')).toContainText('Remove API key?');
  await page.getByTestId('remove-key-cancel').click();
  await expect(page.getByTestId('remove-key-dialog')).toHaveCount(0);
  await expect(page.getByTestId('stored-key-card')).toBeVisible();

  // 3. Confirming removes it.
  await page.getByTestId('remove-key-button').click();
  await page.getByTestId('remove-key-confirm').click();
  await expect(page.getByTestId('remove-key-dialog')).toHaveCount(0);
  await expect(page.getByTestId('api-key-status')).toContainText(
    'API key removed from this device.',
  );
  await expect(page.getByTestId('no-key-hint')).toBeVisible();
  await expect(page.getByTestId('stored-key-card')).toHaveCount(0);

  // 4. The seam, in the same session so an in-memory copy of the key would still
  //    be live: back on the entry, the next pass is disclosed as, and billed as,
  //    the shared allowance, and the key no longer rides the request.
  const walletBefore = await usage(page, token);
  await page.getByRole('link', { name: 'Go back' }).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText(
    'one of your 50 BotMason messages',
  );
  await expect(page.getByTestId('resonance-explainer-cost')).not.toContainText(
    'Your own API key pays',
  );
  await page.getByTestId('resonance-explainer-continue').click();
  await expect.poll(() => passes.length).toBe(2);
  expect(passes[1]?.headers()[LLM_KEY_HEADER]).toBeUndefined();
  await expect
    .poll(async () => (await usage(page, token)).monthly_messages_used)
    .toBe(walletBefore.monthly_messages_used + 1);

  // 5. The getter, still in the same session: opening a margin note the shared
  //    pass wrote asks for its essay with no explicit key, so the request's
  //    header comes from the getter alone -- and it no longer carries the key.
  const note = page.locator('[data-testid^="margin-note-"]:not([data-testid*="stale"])').first();
  await note.click();
  await expect.poll(() => essays.length).toBe(1);
  expect(essays[0]?.headers()[LLM_KEY_HEADER]).toBeUndefined();
  await expect(page.getByTestId('essay-text')).toBeVisible();
  await page.getByTestId('essay-close').click();

  // 6. And it stays removed across a reload.
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await expect(page.getByTestId('no-key-hint')).toBeVisible();
  await expect(page.getByTestId('stored-key-card')).toHaveCount(0);

  // Nothing here reached the lane's fake provider: its shared counters are as
  // this spec found them, for the specs that run after it.
  expect(await providerAttempts(page)).toEqual(attemptsBefore);
});
