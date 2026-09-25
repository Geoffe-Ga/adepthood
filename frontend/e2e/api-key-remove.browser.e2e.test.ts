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
 * proves is what removal is *for*: the next resonance pass leaves the browser
 * without the `X-LLM-API-Key` header and draws on the shared allowance instead.
 * A control pass made while the key is stored proves the header recorder can
 * see the header at all, so its later absence is an observation rather than a
 * recorder that never looked. A spec that only checked the card disappeared
 * would pass against a build that hid the card while an in-memory getter kept
 * sending the key.
 */

const READABLE_PAGE =
  'The heron stood in the shallows until the light changed. I stood with it, ' +
  'and for once did not reach for anything.';

const LLM_KEY_HEADER = 'x-llm-api-key'; // pragma: allowlist secret

interface Usage {
  monthly_messages_used: number;
  offering_balance: number;
}

/** Every resonance pass this browser sends for `entryId`, in order. */
function recordPasses(page: Page, entryId: number): Request[] {
  const sent: Request[] = [];
  const route = `/journal/${String(entryId)}/resonance`;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(route)) sent.push(request);
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

/** The lane's BYOK fixture key, which its fake provider refuses for credit. */
function laneKey(): string {
  const key = readLaneState()?.spentOpenaiKey;
  if (!key) throw new Error('the browser lane did not provide its BYOK fixture');
  return key;
}

/** Save a key through the same screen a writer uses. */
async function storeApiKey(page: Page, key: string): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
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
  const email = await signUp(page, 'api-key-remove');
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(page, token);
  const passes = recordPasses(page, entryId);
  const key = laneKey();

  // 1. Control: with the key stored, a pass carries it. The lane's fake provider
  //    refuses this key for credit, so neither BotMason bucket moves.
  await storeApiKey(page, key);
  const walletWithKey = await usage(page, token);
  await openEntry(page, entryId);
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText('Your own API key pays');
  await page.getByTestId('resonance-explainer-continue').click();
  await expect.poll(() => passes.length).toBe(1);
  expect(passes[0]?.headers()[LLM_KEY_HEADER]).toBe(key);
  await expect(page.getByTestId('journal-resonance-error')).toContainText('your API key');
  expect(await usage(page, token)).toEqual(walletWithKey);

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

  // 5. And it stays removed across a reload.
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await expect(page.getByTestId('no-key-hint')).toBeVisible();
  await expect(page.getByTestId('stored-key-card')).toHaveCount(0);
});
