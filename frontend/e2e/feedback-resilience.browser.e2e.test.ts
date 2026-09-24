import { expect, test, type Page } from '@playwright/test';

import {
  captureFeedbackPosts,
  feedbackControl,
  feedbackReportCount,
  fillBrokenReport,
  HTTP_TOO_MANY,
  HTTP_UNPROCESSABLE,
  openComposerFrom,
  readReference,
  routeIntake,
  type CapturedPost,
} from './feedbackBrowserSupport';
import { signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2899 — a report survives the network failing at every point a real
 * send can fail, in a real browser against the live intake route.
 *
 * Each journey interrupts the one intake POST with Playwright's own routing, so
 * the failure is deterministic rather than hoped for: the response lost after
 * the server committed, the page reloaded while the request is still held, the
 * browser offline, and a 422 or 429 answered in the server's place. The draft
 * must stay recoverable, a resend must reuse the same Idempotency-Key, and the
 * server must end up holding exactly the reports that were sent -- one, or none.
 *
 * Kept apart from `feedback-composer.browser.e2e.test.ts` on purpose: a held
 * route that fails to release would stall every journey in its file, and this
 * file is the only one that holds routes.
 *
 * Server-side rate limiting is not exercised here: the lane's server runs with
 * the limiter disarmed, so the 429 below is the client's handling of one, and
 * the server's own limits stay pinned by `backend/tests/test_rate_limits.py`.
 */

/** Long enough for any automatic resend to have left, if one were going to. */
const SETTLE_MS = 3_000;
/** The request layer sends a keyed POST once and retries it twice (`MAX_RETRIES`). */
const CLIENT_ATTEMPTS_PER_SEND = 3;
const ONE_REQUEST = 1;
const ONE_REPORT = 1;
const NO_REPORTS = 0;
const SUMMARY = 'The journal shelf would not load';

// The composer's own words for each outcome (`FEEDBACK_OUTCOME_COPY`), stated
// literally so a change to them is a deliberate edit here too.
const RETRYABLE_COPY =
  "We couldn't confirm your report arrived. It's safe to send again — it will not create a duplicate.";
const INVALID_COPY =
  "Part of this report couldn't be accepted. Your draft is still here — check it and send again.";
const RATE_LIMITED_COPY =
  "You've sent several reports in a short time. Your report is saved here — please send it again later.";
const SEND_LABEL = 'Send report';
const SEND_AGAIN_LABEL = 'Send again';

function keysOf(posts: readonly CapturedPost[]): Set<string | undefined> {
  return new Set(posts.map((post) => post.idempotencyKey));
}

async function startReport(page: Page, prefix: string): Promise<string> {
  const email = await signUp(page, prefix);
  await openComposerFrom(page, 'journal');
  await fillBrokenReport(page, SUMMARY);
  return email;
}

/** The attempt is frozen: resend offered, the words kept and no longer editable. */
async function expectFrozenDraft(page: Page): Promise<void> {
  await expect(page.getByTestId('feedback-send')).toHaveText(SEND_AGAIN_LABEL);
  await expect(page.getByTestId('feedback-field-summary')).toHaveValue(SUMMARY);
  await expect(page.getByTestId('feedback-field-summary')).not.toBeEditable();
  await expect(page.getByTestId('feedback-reference')).toHaveCount(0);
}

test('a response lost after the server committed resends to the same reference', async ({
  page,
}) => {
  const email = await startReport(page, 'feedback-lost-response');
  const posts = captureFeedbackPosts(page);
  let armed = true;
  let committedId = '';
  await routeIntake(page, async (route) => {
    if (armed) {
      // The server stores (or replays) the report; the browser never hears back.
      const response = await route.fetch();
      committedId = ((await response.json()) as { public_id: string }).public_id;
      await route.abort('connectionreset');
    } else {
      await route.continue();
    }
  });

  await page.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-status')).toContainText(RETRYABLE_COPY);
  await expectFrozenDraft(page);

  armed = false;
  await page.getByTestId('feedback-send').click();
  const publicId = await readReference(page);

  expect(publicId).toBe(committedId);
  expect(keysOf(posts).size).toBe(ONE_REQUEST);
  expect(await feedbackReportCount(page.request, await tokenFor(page.request, email))).toBe(
    ONE_REPORT,
  );
});

test('a reload while the send is held reopens on the frozen draft and never resends by itself', async ({
  page,
}) => {
  const email = await startReport(page, 'feedback-reload-held');
  const posts = captureFeedbackPosts(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await routeIntake(page, async (route) => {
    reached();
    await held;
    // The page that sent it is gone by now; aborting a dead request may throw.
    await route.abort().catch(() => undefined);
  });

  await page.getByTestId('feedback-send').click();
  await seen;
  const heldKey = posts[0]?.idempotencyKey;
  try {
    await page.reload();
  } finally {
    release();
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  const heading = page.getByTestId('feedback-composer-heading');
  await expect(heading.or(feedbackControl(page)).first()).toBeVisible();
  if (!(await heading.isVisible())) await feedbackControl(page).click();
  await expectFrozenDraft(page);
  const beforeSettling = posts.length;
  await page.waitForTimeout(SETTLE_MS);
  expect(posts).toHaveLength(beforeSettling);

  await page.getByTestId('feedback-send').click();
  await readReference(page);

  expect(heldKey).toBeDefined();
  expect(keysOf(posts)).toEqual(new Set([heldKey]));
  expect(await feedbackReportCount(page.request, await tokenFor(page.request, email))).toBe(
    ONE_REPORT,
  );
});

test('offline keeps the draft, and back online one resend files one report', async ({ page }) => {
  const email = await startReport(page, 'feedback-offline');
  const posts = captureFeedbackPosts(page);

  await page.context().setOffline(true);
  await page.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-status')).toContainText(RETRYABLE_COPY);
  await expectFrozenDraft(page);

  await page.context().setOffline(false);
  await page.getByTestId('feedback-send').click();
  await readReference(page);

  expect(keysOf(posts).size).toBe(ONE_REQUEST);
  expect(await feedbackReportCount(page.request, await tokenFor(page.request, email))).toBe(
    ONE_REPORT,
  );
});

test('a refused 422 and a 429 show their copy, file nothing and send nothing by themselves', async ({
  page,
}) => {
  const email = await startReport(page, 'feedback-refused');
  const posts = captureFeedbackPosts(page);
  const answer = (status: number): Parameters<typeof routeIntake>[1] => {
    return async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ detail: [{ type: 'refused', loc: ['body'], msg: 'refused' }] }),
      });
    };
  };

  // A 422 is definitive: nothing was stored, so the draft is editable again.
  await routeIntake(page, answer(HTTP_UNPROCESSABLE));
  await page.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-status')).toContainText(INVALID_COPY);
  await expect(page.getByTestId('feedback-send')).toHaveText(SEND_LABEL);
  await page.waitForTimeout(SETTLE_MS);
  expect(posts).toHaveLength(ONE_REQUEST);

  // A 429 is retried under the same key a bounded number of times, then held frozen.
  await page.unrouteAll({ behavior: 'wait' });
  await routeIntake(page, answer(HTTP_TOO_MANY));
  await page.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-status')).toContainText(RATE_LIMITED_COPY);
  await expectFrozenDraft(page);
  await page.waitForTimeout(SETTLE_MS);
  expect(posts).toHaveLength(ONE_REQUEST + CLIENT_ATTEMPTS_PER_SEND);
  expect(keysOf(posts).size).toBe(ONE_REQUEST);

  expect(await feedbackReportCount(page.request, await tokenFor(page.request, email))).toBe(
    NO_REPORTS,
  );
});
