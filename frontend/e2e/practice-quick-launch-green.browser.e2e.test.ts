import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { STAGE_DURATIONS_DAYS } from '../src/constants/program';
import { QUICK_LAUNCH_A11Y } from '../src/features/Journal/quickLaunchCopy';

import { requestTally } from './dayBoundaryBrowserSupport';
import {
  backendUrl,
  bearer,
  setProgramAnchorDaysAgo,
  showProgramProgress,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Issue #2734 — a quick-launched writing session is recorded, once, when Green
 * has actually opened.
 *
 * `journal-practice-offer.e2e.test.ts` stands its account at Beige and pins the
 * refusal: `POST /practice-sessions/` answers 403 `stage_locked` for a Journaling
 * selection planned forward at Green, which is why the launch sends nothing
 * there. This is its complement: the same request SUCCEEDING once the calendar
 * has carried the writer into Green, driven from the one button in the Practice
 * player through to the row the server keeps.
 *
 * Four arrangements carry the weight, and each is here for a reason the spec
 * would otherwise fail on:
 *
 *  - The program anchor moves into Green's window BEFORE the page that is then
 *    read loads its stages. The client decides whether a session is countable
 *    from its own stage store (`planQuickLaunch`'s `openedStage`), which is
 *    seeded once per page load from `GET /stages/program-calendar`; a store
 *    seeded at stage 1 hands the journal `userPracticeId: null` and nothing is
 *    sent at all. So the anchor moves and the page reloads.
 *  - No habit is seeded. A habit's start date is a client-side program anchor
 *    that wins over the store, and a fresh one would pin the opened stage at 1.
 *  - The browser clock runs BEHIND the server's. The client stamps `ended_at`
 *    from the browser clock, and the server refuses an `ended_at` more than a
 *    minute in its own future (`MAX_FUTURE_SKEW`). Fast-forwarding a clock that
 *    started at real now would put the session's end minutes ahead of the
 *    server and earn a 422; a clock installed `BROWSER_CLOCK_BEHIND_MS` back
 *    lands the end a few minutes in the server's past instead. The clock is
 *    pinned for the same reason any clock-sensitive spec pins it: what the
 *    assertions measure is a difference of two browser instants, never a day.
 *  - Two sessions run on the one launched page. The first is stopped early and
 *    proves the length recorded is the length written, not the practice's
 *    twenty. An early stop gets no note at all, though, so the withheld
 *    keep-this-as-a-practice offer can only be watched being withheld on a
 *    session that runs its whole length -- the second, which is also a real
 *    second session and belongs on the record like the first.
 *  - "Once" is counted on the wire. The quick-launch POST carries no
 *    Idempotency-Key, so the server would keep a duplicate; only the writing
 *    surface's single edge into `complete` stands between a finished session
 *    and two rows. The spec counts the requests and then reads the server's
 *    own total back.
 *
 * Nothing on the request path is stubbed: `page` only ever observes requests.
 * The anchor rewind edits the lane's throwaway database, faking only elapsed
 * time, exactly as the Map and Return journeys do.
 */

const GREEN_STAGE = 6;
const JOURNALING = 'Journaling';

/** The day Green opens: the sum of every stage window before it (105). */
const GREEN_OPENS_ON_DAY = STAGE_DURATIONS_DAYS.slice(0, GREEN_STAGE - 1).reduce(
  (sum, days) => sum + days,
  0,
);
/** Mid-window, so neither edge of Green is within a midnight's reach (115). */
const DAYS_INTO_GREEN =
  GREEN_OPENS_ON_DAY + Math.floor((STAGE_DURATIONS_DAYS[GREEN_STAGE - 1] ?? 0) / 2);

/** The seeded Journaling row's length, which the launched timer opens at. */
const PRACTICE_MINUTES = 20;
/** How long the writer actually writes: short of the practice's length on purpose. */
const WRITTEN_MINUTES = 7;
const MS_PER_MINUTE = 60_000;
/**
 * Slack past every minute the spec jumps the clock (the early stop, then a full
 * session), so the last session's end still lands in the server's past.
 */
const CLOCK_MARGIN_MINUTES = 3;
const BROWSER_CLOCK_BEHIND_MS =
  (WRITTEN_MINUTES + PRACTICE_MINUTES + CLOCK_MARGIN_MINUTES) * MS_PER_MINUTE;
/** Past the practice's length, so the timer's next tick lands the session complete. */
const PAST_A_SESSION = `${PRACTICE_MINUTES}:05`;
/** The real seconds the page takes between launch and stop, on top of the jump. */
const DURATION_TOLERANCE_MINUTES = 0.5;
/** Long enough past the stop for a duplicate record to have been sent. */
const AFTER_THE_STOP = '00:02';

/** The early stop, then the full-length run, on the same launched page. */
const BOTH_SESSIONS = 2;

const HTTP_CREATED = 201;
const SESSIONS_PATH = '/practice-sessions/';
const BODY = 'The kettle, the window, and a page that counts this time.';
/** A twenty-minute timer, read at or just after its start. */
const FRESH_READOUT = new RegExp(`^(${PRACTICE_MINUTES}:00|${PRACTICE_MINUTES - 1}:[0-5]\\d)$`);

interface CatalogPractice {
  id: number;
  name: string;
  default_duration_minutes: number;
}

/** What the client sends: a window, never a length. */
interface SessionSent {
  user_practice_id: number;
  started_at: string;
  ended_at: string;
}

/** What the server kept: the length it derived from that window. */
interface SessionKept {
  user_practice_id: number;
  duration_minutes: number;
}

interface PracticeStats {
  total_sessions: number;
  total_minutes: number;
}

/** Select Journaling at Green over the wire, and return the selection's id. */
async function selectJournalingAtGreen(request: APIRequestContext, token: string): Promise<number> {
  const listed = await request.get(`${backendUrl()}/practices/?stage_number=${GREEN_STAGE}`, {
    headers: bearer(token),
  });
  expect(listed.ok(), `listing the stage-${GREEN_STAGE} catalog failed`).toBe(true);
  const journaling = ((await listed.json()) as CatalogPractice[]).find(
    (practice) => practice.name === JOURNALING,
  );
  if (!journaling) throw new Error(`"${JOURNALING}" is not in the stage-${GREEN_STAGE} catalog`);
  expect(journaling.default_duration_minutes).toBe(PRACTICE_MINUTES);
  const selected = await request.post(`${backendUrl()}/user-practices/`, {
    headers: bearer(token),
    data: { practice_id: journaling.id, stage_number: GREEN_STAGE },
  });
  expect(selected.ok(), `selecting "${JOURNALING}" at Green failed`).toBe(true);
  return ((await selected.json()) as { id: number }).id;
}

/** Cross to Practice through the screen drawer; the toggle is the proof of arrival. */
async function openPractice(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Practice menu' })).toBeVisible();
}

/** Press one of the pill's controls; the pill may sit folded behind its options toggle. */
async function pressTimer(
  page: Page,
  control: 'writing-timer-start' | 'writing-timer-stop',
): Promise<void> {
  const folded = page.getByRole('button', { name: 'Open writing timer options' });
  if (await folded.isVisible()) await folded.click();
  await page.getByTestId(control).click();
}

/**
 * The one session `response` answered: accepted, against the Green selection,
 * and for `minutes` -- both in the window the client sent and in the length the
 * server derived from it.
 */
async function expectSessionKept(
  response: Response,
  selectionId: number,
  minutes: number,
): Promise<void> {
  expect(response.status(), await response.text()).toBe(HTTP_CREATED);
  const sent = response.request().postDataJSON() as SessionSent;
  expect(sent.user_practice_id).toBe(selectionId);
  const sentMinutes = (Date.parse(sent.ended_at) - Date.parse(sent.started_at)) / MS_PER_MINUTE;
  expect(Math.abs(sentMinutes - minutes)).toBeLessThanOrEqual(DURATION_TOLERANCE_MINUTES);
  const kept = (await response.json()) as SessionKept;
  expect(kept.user_practice_id).toBe(selectionId);
  expect(Math.abs(kept.duration_minutes - minutes)).toBeLessThanOrEqual(DURATION_TOLERANCE_MINUTES);
}

function isSessionPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === SESSIONS_PATH;
}

async function readStats(
  request: APIRequestContext,
  token: string,
  userPracticeId: number,
): Promise<PracticeStats> {
  const response = await request.get(
    `${backendUrl()}/practice-sessions/stats?user_practice_id=${userPracticeId}`,
    { headers: bearer(token) },
  );
  expect(response.ok(), 'reading the practice stats back failed').toBe(true);
  return (await response.json()) as PracticeStats;
}

test('records a quick-launched writing session once Green has actually opened', async ({
  page,
}) => {
  await page.clock.install({ time: Date.now() - BROWSER_CLOCK_BEHIND_MS });
  const email = await signUp(page, 'practice-quick-launch-green');
  setProgramAnchorDaysAgo(email, DAYS_INTO_GREEN);
  const token = await tokenFor(page.request, email);
  const selectionId = await selectJournalingAtGreen(page.request, token);
  // A fresh page load reads the moved calendar, and the selection, cold. Today
  // nothing on the journal seeds the stage store before Practice opens, so the
  // Practice screen's own first load would also read the moved calendar; the
  // reload keeps the arrange true if the shell ever starts seeding it earlier.
  await page.reload();

  // --- The Practice player offers the page, and says nothing about waiting. ---
  await openPractice(page);
  const launch = page.getByRole('button', { name: QUICK_LAUNCH_A11Y });
  await expect(launch).toBeVisible();
  await expect(page.getByTestId('practice-quick-launch-waiting')).toHaveCount(0);

  const sessionPosts = requestTally(page, isSessionPost);
  sessionPosts.mark();
  const earlyStop = page.waitForResponse((response) => isSessionPost(response.request()));
  await launch.click();

  // --- The page opens with the practice's own length already running. ---
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  await expect(page.getByTestId('writing-timer-readout')).toHaveText(FRESH_READOUT);
  await page.getByTestId('journal-body-input').fill(BODY);

  // --- Stopped early: one request, accepted, for the minutes written. ---
  await page.clock.fastForward(WRITTEN_MINUTES * MS_PER_MINUTE);
  await pressTimer(page, 'writing-timer-stop');
  await expectSessionKept(await earlyStop, selectionId, WRITTEN_MINUTES);
  await sessionPosts.expectSinceMark(1, 'a quick-launched session was not posted exactly once');
  await page.clock.fastForward(AFTER_THE_STOP);
  expect(sessionPosts.sinceMark(), 'a finished session was posted again').toBe(1);
  const afterOne = await readStats(page.request, token, selectionId);
  expect(afterOne.total_sessions).toBe(1);
  expect(Math.abs(afterOne.total_minutes - WRITTEN_MINUTES)).toBeLessThanOrEqual(
    DURATION_TOLERANCE_MINUTES,
  );

  // --- Run to its length: the note is drawn, and the offer is not in it. ---
  // An early stop gets no note at all (WritingSessionSurface speaks only for a
  // session that ran its whole length), so the withheld offer can only be seen
  // being withheld here, on a session that would otherwise have carried it.
  const fullLength = page.waitForResponse((response) => isSessionPost(response.request()));
  await pressTimer(page, 'writing-timer-start');
  await page.clock.fastForward(PAST_A_SESSION);
  await expectSessionKept(await fullLength, selectionId, PRACTICE_MINUTES);
  // The banner draws its slot in the same render as itself, so once it is up
  // an offer would already be in it: the two absences cannot pass merely
  // because nothing was drawn yet.
  await expect(page.getByTestId('writing-session-banner')).toBeVisible();
  await expect(page.getByTestId('save-as-habit-offer')).toHaveCount(0);
  await expect(page.getByTestId('save-as-practice-accept')).toHaveCount(0);
  // And what does occupy the slot on a launched page: the link-a-habit note.
  await expect(page.getByTestId('link-habit-nudge')).toBeVisible();
  await sessionPosts.expectSinceMark(
    BOTH_SESSIONS,
    'the second session was not posted exactly once',
  );

  // --- The server kept the two sessions, for the minutes each one ran. ---
  const afterTwo = await readStats(page.request, token, selectionId);
  expect(afterTwo.total_sessions).toBe(BOTH_SESSIONS);
  expect(
    Math.abs(afterTwo.total_minutes - (WRITTEN_MINUTES + PRACTICE_MINUTES)),
  ).toBeLessThanOrEqual(BOTH_SESSIONS * DURATION_TOLERANCE_MINUTES);
  // Informational: the record caught up as the page read the calendar. The 201s
  // do not rest on it -- the server opens a stage by calendar OR record.
  expect(showProgramProgress(email).current_stage).toBe(GREEN_STAGE);
});
