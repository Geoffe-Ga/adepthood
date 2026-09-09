import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2449 — a practitioner can see what they have put into one practice.
 *
 * This journey belongs in the browser lane rather than the node lane for two
 * reasons the node lane cannot serve. The first is structural: the node lane
 * cannot mount a React Native screen at all (#2324), and the whole claim here
 * is that the totals reach a screen a practitioner can actually walk to — the
 * player, its drawer, "Practice details" — rather than merely being served.
 *
 * The second is the hazard #2654 left behind. The aggregate is read one tap
 * from the player that writes the rows it counts, so a freshness lifetime on
 * the response would let Chromium answer a re-read out of its own HTTP cache
 * with the pre-save number. Node's fetch keeps no HTTP cache, so a node spec
 * always puts the request on the wire and can never see that. The final leg
 * leaves the screen and returns to force a real re-read.
 *
 * The counting rule is asserted through the wire too: a zero-length abort is
 * logged alongside the two real sittings and must move neither number.
 */

/** The canonical stage-1 preset; `sense_grounding` mode. */
const GROUNDING_PRACTICE = '5-4-3-2-1 grounding';
const ENTRY_STAGE = 1;

const LONG_SIT_MINUTES = 45;
const SHORT_SIT_MINUTES = 20;
/** 45 + 20 = 65 minutes, which is the "hours+minutes past 60" case the issue names. */
const EXPECTED_TOTAL_TIME = '1h 5m';
const EXPECTED_TOTAL_SESSIONS = '2';

const MS_PER_MINUTE = 60_000;

interface CatalogPractice {
  id: number;
  name: string;
  stage_number: number;
}

/** Adopt the stage-1 grounding practice over the API and return its catalog id. */
async function adoptGroundingPractice(
  request: APIRequestContext,
  token: string,
): Promise<CatalogPractice> {
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await request.get(`${backendUrl()}/practices/?stage_number=${ENTRY_STAGE}`, {
    headers,
  });
  if (!listed.ok()) throw new Error(`listing the stage-${ENTRY_STAGE} catalog failed`);
  const catalog = (await listed.json()) as CatalogPractice[];
  const grounding = catalog.find((practice) => practice.name === GROUNDING_PRACTICE);
  if (!grounding) {
    throw new Error(`"${GROUNDING_PRACTICE}" is not in the stage-${ENTRY_STAGE} catalog`);
  }
  const adopted = await request.post(`${backendUrl()}/user-practices/`, {
    headers,
    data: { practice_id: grounding.id, stage_number: ENTRY_STAGE },
  });
  if (!adopted.ok()) throw new Error(`adopting "${GROUNDING_PRACTICE}" failed`);
  return grounding;
}

/** The id of the caller's live adoption for the given stage. */
async function adoptionId(
  request: APIRequestContext,
  token: string,
  practiceId: number,
): Promise<number> {
  const listed = await request.get(`${backendUrl()}/user-practices/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listed.ok()) throw new Error('listing the adopted practices failed');
  const rows = (await listed.json()) as Array<{ id: number; practice_id: number }>;
  const mine = rows.find((row) => row.practice_id === practiceId);
  if (!mine) throw new Error('the practice just adopted is not in the listing');
  return mine.id;
}

/** Log one sitting of `minutes` against the adoption, ending `endedMinutesAgo` back. */
async function logSitting(
  request: APIRequestContext,
  token: string,
  userPracticeId: number,
  minutes: number,
  endedMinutesAgo: number,
): Promise<void> {
  const ended = new Date(Date.now() - endedMinutesAgo * MS_PER_MINUTE);
  const started = new Date(ended.getTime() - minutes * MS_PER_MINUTE);
  const logged = await request.post(`${backendUrl()}/practice-sessions/`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      user_practice_id: userPracticeId,
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
    },
  });
  if (!logged.ok()) throw new Error(`logging a ${minutes}-minute sitting failed`);
}

/** Cross to another primary destination through the screen drawer. */
async function navigateTo(page: Page, screen: 'Journal' | 'Practice'): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: screen, exact: true }).click();
  await expect(page.getByRole('button', { name: `Open ${screen} menu` })).toBeVisible();
}

/** Walk from the player to the practice's own detail screen, as a user would. */
async function openPracticeDetails(page: Page): Promise<void> {
  await navigateTo(page, 'Practice');
  await expect(page.getByTestId('active-ritual-session')).toBeVisible();
  await page.getByRole('button', { name: 'Open Practice menu' }).click();
  await page.getByTestId('practice-drawer-details').click();
  await expect(page.getByTestId('practice-detail-name')).toBeVisible();
}

test('a practitioner sees their own total sittings and total time for one practice', async ({
  page,
}) => {
  const email = await signUp(page, 'practice-stats');
  const token = await tokenFor(page.request, email);
  const grounding = await adoptGroundingPractice(page.request, token);
  const userPracticeId = await adoptionId(page.request, token, grounding.id);

  await logSitting(page.request, token, userPracticeId, LONG_SIT_MINUTES, 120);
  await logSitting(page.request, token, userPracticeId, SHORT_SIT_MINUTES, 60);
  // A quick-cancel: started and ended at the same instant. It is a real row in
  // the sessions table and must move neither total, which is the counting rule
  // this endpoint had to settle.
  await logSitting(page.request, token, userPracticeId, 0, 30);

  await page.reload();
  await openPracticeDetails(page);

  const sessions = page.getByTestId('practice-detail-total-sessions');
  const time = page.getByTestId('practice-detail-total-time');
  await expect(sessions).toHaveText(EXPECTED_TOTAL_SESSIONS);
  await expect(time).toHaveText(EXPECTED_TOTAL_TIME);

  // The server agrees, so a failure above is a display failure rather than a
  // miscounted aggregate -- and the abort really is in the table it excluded.
  const aggregate = await page.request.get(
    `${backendUrl()}/practice-sessions/stats?user_practice_id=${userPracticeId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(await aggregate.json()).toEqual({
    total_sessions: 2,
    total_minutes: LONG_SIT_MINUTES + SHORT_SIT_MINUTES,
  });
  const logged = await page.request.get(
    `${backendUrl()}/practice-sessions/?user_practice_id=${userPracticeId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect((await logged.json()) as unknown[]).toHaveLength(3);

  // And the numbers survive the screen's own re-read. Leaving and returning is
  // the cheapest way to force one; a rollup carrying a freshness lifetime would
  // be answered here out of the browser's cache instead of by the server.
  await navigateTo(page, 'Journal');
  await openPracticeDetails(page);
  await expect(page.getByTestId('practice-detail-total-sessions')).toHaveText(
    EXPECTED_TOTAL_SESSIONS,
  );
  await expect(page.getByTestId('practice-detail-total-time')).toHaveText(EXPECTED_TOTAL_TIME);
});
