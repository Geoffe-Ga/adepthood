import { expect, test, type Page } from '@playwright/test';

import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

/**
 * The spend disclosure in front of a resonance pass, in a real browser.
 *
 * `resonance.e2e.test.ts` already proves a pass reaches the server and keeps
 * anchored notes, but it drives the API client directly and cannot press a
 * button. The claim this journey makes is the one only a rendered screen can
 * settle: no request is sent until the reader sees who will pay, and changing
 * from the shared allowance to a device-stored key changes that answer before
 * the pass leaves the browser.
 *
 * The assertions are therefore counted requests and server state, not visible
 * text alone. A spec that only checked the dialog was on screen would pass just
 * as happily against a build that charged behind it, which is exactly the
 * failure this gate exists to prevent.
 *
 * The lane runs the backend's default (stub) BotMason provider, so the pass here
 * is the real route, the real wallet deduction and the real anchoring, with only
 * the model's sentences canned.
 */

/** A page with sentences the stub provider is willing to quote back. */
const READABLE_PAGE =
  'The willow bent all night and did not break. I slept badly and woke grateful, ' +
  'which is not the trade I would have chosen.';

/** Every pass this browser sends for `entryId`, in order. */
function recordPasses(page: Page, entryId: number): { readonly length: number } {
  const sent: string[] = [];
  const route = `/journal/${String(entryId)}/resonance`;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(route)) sent.push(request.url());
  });
  return sent;
}

/** The margin notes the server is actually holding for `entryId`. */
async function keptNotes(page: Page, token: string, entryId: number): Promise<unknown[]> {
  const response = await page.request.get(`${backendUrl()}/journal/${String(entryId)}/marginalia`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: unknown[] }).items;
}

interface Usage {
  monthly_messages_used: number;
  offering_balance: number;
}

/** The two wallet buckets a pass could draw from. */
async function usage(page: Page, token: string): Promise<Usage> {
  const response = await page.request.get(`${backendUrl()}/user/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Usage;
}

/** Save a real lane key through the same screen a writer uses. */
async function storeApiKey(page: Page): Promise<void> {
  const key = readLaneState()?.spentOpenaiKey;
  if (!key) throw new Error('the browser lane did not provide its BYOK fixture');
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

test('the payer is disclosed before a resonance pass is ever sent', async ({ page }) => {
  const email = await signUp(page, 'resonance-explainer');
  const token = await tokenFor(page.request, email);
  const headers = { Authorization: `Bearer ${token}` };
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers,
    data: { title: 'The willow', message: READABLE_PAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers,
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);

  const passes = recordPasses(page, entryId);
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();

  // 1. The first press buys nothing. It says what a pass does, where the entry
  //    goes, and what it costs — and sends no request at all.
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-what')).toContainText('AI model');
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText(
    'one of your 50 BotMason messages',
  );
  await expect(page.getByTestId('resonance-explainer-cost')).not.toContainText('free');
  expect(passes.length).toBe(0);

  // 2. Backing out is a real refusal, not a deferral of something already sent:
  //    no request left the browser and the server kept nothing.
  await page.getByTestId('resonance-explainer-cancel').click();
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
  expect(passes.length).toBe(0);
  expect(await keptNotes(page, token, entryId)).toEqual([]);

  // 3. Saving a caller-owned key through Settings changes the same disclosure.
  //    Cancelling still sends nothing, so this proves the payer is selected
  //    before (rather than inferred after) the model call.
  await storeApiKey(page);
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText('Your own API key pays');
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText(
    'Nothing is drawn from your BotMason messages',
  );
  expect(passes.length).toBe(0);
  await page.getByTestId('resonance-explainer-cancel').click();

  // 4. Continue through the BYOK arm. The fake provider deliberately reports
  //    that this key is out of credit, but the request crossed the full screen,
  //    API and provider stack and neither BotMason bucket moved.
  const walletBefore = await usage(page, token);
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-dont-show').click();
  await page.getByTestId('resonance-explainer-continue').click();
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
  await expect.poll(() => passes.length).toBe(1);
  await expect(page.getByTestId('journal-resonance-error')).toContainText('your API key');
  expect(await usage(page, token)).toEqual(walletBefore);
  expect(await keptNotes(page, token, entryId)).toEqual([]);

  // 5. Having been told once and asked not to be told again, the next press goes
  //    straight to the pass without silently switching payer.
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect.poll(() => passes.length).toBe(2);
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
  expect(await usage(page, token)).toEqual(walletBefore);
});
