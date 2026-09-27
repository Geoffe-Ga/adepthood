import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

const SAVED = 'Saved';
const SAVE_ERROR = "Couldn't save — keep writing, we'll retry";
const RETRY_NAME = 'Retry saving this entry';
const JOURNAL_ENTRY_PATH = /^\/journal\/\d+$/;

interface StoredEntry {
  message: string;
}

/** Resolves once `count` PATCHes of this page have come back from the server. */
function patchesLanded(page: Page, count: number): Promise<void> {
  let landed = 0;
  return new Promise((resolve) => {
    page.on('response', (response) => {
      const isPatch = response.request().method() === 'PATCH';
      if (isPatch && JOURNAL_ENTRY_PATH.test(new URL(response.url()).pathname)) landed += 1;
      if (landed === count) resolve();
    });
  });
}

/**
 * #2936: a create or a weekly-prompt answer whose first attempt REACHED the
 * server but whose answer never came back. From the page that looks exactly
 * like a write that never arrived, so it is retried — first by the transport
 * (a keyed POST is retry-eligible, `MAX_RETRIES` more times), then by the
 * footer's Retry — and every retry carries the key the first attempt did, so
 * the server answers it with the row it already holds.
 *
 * `route.fetch()` lets the request reach the server and commit; the abort that
 * follows is the lost answer. Later attempts are aborted before they leave
 * (without reaching the server) while `blocked` holds, so the screen's own
 * Retry is the one that finally lands.
 */
const TRANSPORT_RETRIES = 2;
const LOST_BODY = 'A page whose first save landed, though nobody heard back.';
const LOST_BODY_MORE = `${LOST_BODY} And a line written while the network was down.`;
const PROMPT_ANSWER = 'The willow by the path, and how it bent without breaking.';

interface LostAnswer {
  /** Attempts that reached the route: the first is fetched, the rest aborted. */
  hits: () => number;
  /** Keys every attempt carried, in order. */
  keys: () => (string | undefined)[];
  /** Let every later attempt through to the server. */
  release: () => Promise<void>;
}

/** Commit the first POST to `path` and lose its answer; hold later ones while blocked. */
async function loseFirstAnswer(page: Page, path: string, blockAfter: number): Promise<LostAnswer> {
  let hits = 0;
  const keys: (string | undefined)[] = [];
  const matches = (url: URL) => url.pathname === path;
  const handler = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (route.request().method() !== 'POST') return route.continue();
    hits += 1;
    keys.push(route.request().headers()['idempotency-key']);
    if (hits === 1) {
      await route.fetch();
      return route.abort('failed');
    }
    if (hits <= blockAfter) return route.abort('failed');
    return route.continue();
  };
  await page.route(matches, handler);
  return {
    hits: () => hits,
    keys: () => keys,
    release: () => page.unroute(matches, handler),
  };
}

async function journalTotal(request: APIRequestContext, email: string): Promise<number> {
  const response = await request.get(`${backendUrl()}/journal/`, {
    headers: bearer(await tokenFor(request, email)),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

async function onlyEntry(request: APIRequestContext, email: string): Promise<StoredEntry> {
  const response = await request.get(`${backendUrl()}/journal/`, {
    headers: bearer(await tokenFor(request, email)),
  });
  const { items } = (await response.json()) as { items: StoredEntry[] };
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** Open the shelf's first stage prompt: a weekly-prompt compose for week 1. */
async function composeFirstPrompt(page: Page): Promise<void> {
  await page.getByTestId('journal-stage-prompt-1').click();
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
}

test('a create whose answer was lost is healed by the transport retry: one entry', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-lost-create-heal');
  const lost = await loseFirstAnswer(page, '/journal/', 1);

  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(LOST_BODY);

  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  expect(lost.hits()).toBe(2);
  expect(new Set(lost.keys()).size).toBe(1);
  expect(lost.keys()[0]).toBeTruthy();
  await expect(page.getByRole('button', { name: RETRY_NAME })).toHaveCount(0);
  expect(await journalTotal(page.request, email)).toBe(1);
});

test('a create whose answer was lost, retried from the footer with newer words: one entry, the newer words', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-lost-create-retry');
  const lost = await loseFirstAnswer(page, '/journal/', Number.POSITIVE_INFINITY);

  await page.getByTestId('journal-new-entry').click();
  await page.getByTestId('journal-body-input').fill(LOST_BODY);
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);
  expect(lost.hits()).toBe(1 + TRANSPORT_RETRIES);
  // Still offline as far as the page knows: the newer words fail to save too.
  await page.getByTestId('journal-body-input').fill(LOST_BODY_MORE);
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);

  await lost.release();
  const reconciled = patchesLanded(page, 1);
  await page.getByRole('button', { name: RETRY_NAME }).click();
  await reconciled;

  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  expect(new Set(lost.keys()).size).toBe(1);
  expect(await journalTotal(page.request, email)).toBe(1);
  expect((await onlyEntry(page.request, email)).message).toBe(LOST_BODY_MORE);
});

test('a weekly-prompt answer whose answer was lost is healed by the transport retry: Saved', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-lost-respond-heal');
  const lost = await loseFirstAnswer(page, '/prompts/1/respond', 1);

  await composeFirstPrompt(page);
  await page.getByTestId('journal-body-input').fill(PROMPT_ANSWER);

  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  expect(lost.hits()).toBe(2);
  expect(new Set(lost.keys()).size).toBe(1);
  expect(await journalTotal(page.request, email)).toBe(1);
});

test('a weekly-prompt answer whose answer was lost, retried from the footer, is Saved rather than week-taken', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-lost-respond-retry');
  const lost = await loseFirstAnswer(page, '/prompts/1/respond', Number.POSITIVE_INFINITY);

  await composeFirstPrompt(page);
  await page.getByTestId('journal-body-input').fill(PROMPT_ANSWER);
  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVE_ERROR);
  expect(lost.hits()).toBe(1 + TRANSPORT_RETRIES);

  await lost.release();
  await page.getByRole('button', { name: RETRY_NAME }).click();

  await expect(page.getByTestId('journal-save-hint')).toHaveText(SAVED);
  expect(new Set(lost.keys()).size).toBe(1);
  const token = await tokenFor(page.request, email);
  const prompt = await page.request.get(`${backendUrl()}/prompts/1`, { headers: bearer(token) });
  expect(await prompt.json()).toMatchObject({ has_responded: true, response: PROMPT_ANSWER });
  expect(await journalTotal(page.request, email)).toBe(1);
});
