import { expect, test, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The spend disclosure in front of a charged resonance pass, in a real browser.
 *
 * `resonance.e2e.test.ts` already proves a pass reaches the server and keeps
 * anchored notes, but it drives the API client directly and cannot press a
 * button. The claim this journey makes is the one only a rendered screen can
 * settle: that `POST /journal/{id}/resonance` — the request that deducts a
 * BotMason message before it dials the model — is not sent until the reader has
 * been shown what it costs and said yes.
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

/** Every charged pass this browser sends for `entryId`, in order. */
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

test('the cost is disclosed before the first resonance pass is ever sent', async ({ page }) => {
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
  await expect(page.getByTestId('resonance-explainer-cost')).toContainText('BotMason');
  expect(passes.length).toBe(0);

  // 2. Backing out is a real refusal, not a deferral of something already sent:
  //    no request left the browser and the server kept nothing.
  await page.getByTestId('resonance-explainer-cancel').click();
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
  expect(passes.length).toBe(0);
  expect(await keptNotes(page, token, entryId)).toEqual([]);

  // 3. Continue, with the note set aside, runs exactly one pass — and the server
  //    really did read the page, so the gate did not swallow the request either.
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-dont-show').click();
  await page.getByTestId('resonance-explainer-continue').click();
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
  await expect.poll(() => passes.length).toBe(1);
  await expect.poll(async () => (await keptNotes(page, token, entryId)).length).toBeGreaterThan(0);

  // 4. Having been told once and asked not to be told again, the next press goes
  //    straight to the pass.
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect.poll(() => passes.length).toBe(2);
  await expect(page.getByTestId('resonance-explainer-card')).toHaveCount(0);
});
