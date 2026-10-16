import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * #3387, #3409, #3411: Journal payment work that crosses a same-account
 * token renewal still settles where the writer asked for it.
 *
 * `usePaymentScope` used to fence on the exact JWT, so when the app renewed
 * the session's token while a paid request was in flight, the answer that came
 * back was thrown away: a note's letter spun forever, a Get resonance press
 * whose wallet read was in flight did nothing, and a reading refused 402 never
 * opened the refill remedy.
 *
 * Each case refuses the request's first attempt 401 at the browser's edge.
 * Everything after that is real: the production client refreshes the token
 * against the live server (which rotates it and revokes the old one), and
 * resends the request once with the renewed bearer. The resent attempt is held
 * briefly, as a network round trip would, so the renewed credential has
 * rendered before its answer lands. The page clock is not touched: jumping it
 * to fire the proactive timer would also fire the held request's own fetch
 * timeout. Jest pins the proactive renewal, every outcome (letter, failure,
 * 402) and the refusals that must stand (the same account signing back in,
 * another account, A to B to A, sign-out) through the real AuthProvider in
 * `src/features/Journal/__tests__/paymentLineageRenewal.integration.test.tsx`.
 */

/** Long enough for the renewed credential to render before the resent request's answer. */
const ROUND_TRIP_MS = 750;
/** Long enough that a third attempt, had one been sent, would have been seen. */
const QUIET_MS = 500;

const OK = 200;
const CREATED = 201;
const UNAUTHORIZED = 401;
const PAGE_BODY = 'The heron stood in the shallows until the light changed.';
const ARTIFACTS = join(__dirname, 'artifacts', 'journal-payment-renewal');

async function writeFinishedPage(page: Page, token: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'Heron', message: PAGE_BODY },
  });
  expect(created.status()).toBe(CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(OK);
  return entryId;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

/** Take a pass through the disclosure, set aside any corpus invitation, and return its first note. */
async function firstNoteFromAPass(page: Page, entryId: number): Promise<number> {
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/${String(entryId)}/resonance`,
  );
  const invitationRead = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/corpus/invitation',
  );
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await page.getByTestId('resonance-explainer-continue').click();
  const received = await response;
  expect(received.status()).toBe(OK);
  if ((await (await invitationRead).json()).offer) {
    await page.getByTestId('journal-corpus-invitation-dismiss').click();
    await expect(page.getByTestId('journal-corpus-invitation')).toHaveCount(0);
  }
  const pass = (await received.json()) as { marginalia: { id: number }[] };
  return pass.marginalia[0]?.id ?? 0;
}

interface Refused {
  /** Every attempt, in order, as the request the app sent. */
  attempts: Request[];
  /** The token the live server minted when the client renewed after the 401. */
  renewed: Promise<string>;
}

/**
 * Refuse the first `method` request to `pathname` 401 at the browser's edge
 * and let every later one reach the server after a round trip. `answerRetry`,
 * when given, answers the later attempts in place of the server (only the 402
 * case needs it: the lane's wallet is full, and a refusal is what is under
 * test).
 */
async function refuseFirstOnce(
  page: Page,
  method: string,
  pathname: string,
  answerRetry?: (_route: Route) => Promise<void>,
): Promise<Refused> {
  const attempts: Request[] = [];
  const renewed = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/auth/refresh',
    )
    .then(async (response) => {
      expect(response.status()).toBe(OK);
      return ((await response.json()) as { token: string }).token;
    });
  const answer = async (route: Route): Promise<void> => {
    attempts.push(route.request());
    if (attempts.length === 1) {
      await route.fulfill({
        status: UNAUTHORIZED,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'unauthorized' }),
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS));
      await (answerRetry ? answerRetry(route) : route.continue());
    }
  };
  await page.route(
    (url) => url.pathname === pathname,
    (route) => (route.request().method() === method ? answer(route) : route.fallback()),
  );
  return { attempts, renewed };
}

/** The refused attempt was resent exactly once, under the token the server renewed. */
async function expectRetriedUnderRenewal(page: Page, refused: Refused): Promise<void> {
  const renewed = await refused.renewed;
  await expect.poll(() => refused.attempts.length).toBe(2);
  const [first, retry] = refused.attempts;
  expect(retry?.headers().authorization).toBe(`Bearer ${renewed}`);
  expect(first?.headers().authorization).not.toBe(`Bearer ${renewed}`);
  await page.waitForTimeout(QUIET_MS);
  expect(refused.attempts).toHaveLength(2);
}

async function frame(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

/** Give a stuck surface time to show itself before the shot, so a spinner is caught. */
async function settleThenFrame(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(1000);
  await frame(page, name);
}

async function signedInOnAFinishedPage(page: Page, prefix: string) {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(page, token);
  await openEntry(page, entryId);
  return { token, entryId };
}

for (const width of [390, 1280]) {
  test(`#3387 a letter asked for across a renewal lands at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const { entryId } = await signedInOnAFinishedPage(page, `letter-renewal-${width}`);
    const noteId = await firstNoteFromAPass(page, entryId);
    await page.getByTestId(`margin-note-open-${String(noteId)}`).click();
    await expect(page.getByTestId('essay-ask')).toBeVisible();
    const refused = await refuseFirstOnce(
      page,
      'POST',
      `/journal/marginalia/${String(noteId)}/essay`,
    );

    await page.getByTestId('essay-ask').click();
    await expectRetriedUnderRenewal(page, refused);
    await settleThenFrame(page, `letter-${String(width)}`);

    await expect(page.getByTestId('essay-text')).toBeVisible();
    await expect(page.getByTestId('essay-loading')).toHaveCount(0);
  });

  test(`#3409 a Get resonance press whose wallet read crosses a renewal opens the disclosure at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await signedInOnAFinishedPage(page, `preflight-renewal-${width}`);
    const refused = await refuseFirstOnce(page, 'GET', '/user/usage');

    await page.getByRole('button', { name: 'Get resonance' }).click();
    await expectRetriedUnderRenewal(page, refused);
    await settleThenFrame(page, `preflight-${String(width)}`);

    await expect(page.getByTestId('resonance-explainer-continue')).toBeVisible();
    await expect(page.getByTestId('resonance-explainer-cost')).not.toHaveText('');
  });

  test(`#3411 a reading refused 402 after a renewal opens the refill remedy at ${String(width)}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const { entryId } = await signedInOnAFinishedPage(page, `reading-renewal-${width}`);
    // The lane's wallet is full, so the refusal under test is the server's
    // own 402 body, answered to the renewed retry.
    const refused = await refuseFirstOnce(
      page,
      'POST',
      `/journal/${String(entryId)}/resonance`,
      (route) =>
        route.fulfill({
          status: 402,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'insufficient_offerings' }),
        }),
    );

    await page.getByRole('button', { name: 'Get resonance' }).click();
    await page.getByTestId('resonance-explainer-continue').click();
    await expectRetriedUnderRenewal(page, refused);
    await settleThenFrame(page, `reading-refill-${String(width)}`);

    await expect(page.getByTestId('journal-resonance-refill')).toBeVisible();
    await expect(page.getByTestId('journal-resonance-refill-cancel')).toBeVisible();
  });
}
