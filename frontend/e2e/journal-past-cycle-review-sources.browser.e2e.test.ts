import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  forgetPastCycleAnchor,
  isoDaysAgo,
  setProgramAnchorDaysAgo,
  showProgramProgress,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * A writer who finished the arc, began again, and reopens a review from the
 * first pass.
 *
 * The completed cycle is arranged with the existing out-of-band rewind alone:
 * the anchor goes back into stage 10, and a real read of the program calendar
 * records entry into it. Begin-again is then POSTed to the real route rather
 * than tapped on the Map, because the Map offers it only once stage 10's
 * progress reads 100%, which no lane writer produces without stubbing. The
 * unrecorded case is arranged by `forget-past-anchor`, the same out-of-band
 * module, standing in for a loop made before #2894 retained anchors. Nothing on
 * the request path is stubbed: there is no page.route here.
 */

/** The account's zone, pinned so the server's local midnights are the UTC ones the spec counts in. */
const ACCOUNT_TIMEZONE = 'UTC';

/** Elapsed days at which stage 10 opens: 21 x 8 stages, then 42 for stage 9. */
const STAGE_TEN_OPENS_DAYS_AGO = 210;
/** Margin into stage 10, so a midnight between rewind and read cannot cross either edge. */
const STAGE_TEN_MARGIN_DAYS = 20;
const DAYS_INTO_STAGE_TEN = STAGE_TEN_OPENS_DAYS_AGO + STAGE_TEN_MARGIN_DAYS;
/** A first-cycle daily, well inside the lived cycle and far from both of its ends. */
const CYCLE_ONE_DAILY_DAYS_AGO = 120;
/** 21 x 8 + 42 x 2: the natural length of a cycle, which the clamp must cut short. */
const TOTAL_PROGRAM_DAYS = 252;
const MS_PER_DAY = 86_400_000;

const FINAL_STAGE = 10;
const FIRST_CYCLE = 1;
const SECOND_CYCLE = 2;
const HTTP_OK = 200;
const HTTP_CREATED = 201;

const REFLECTION_TAG = 'hierarchical_reflection';
/** The first pass's whole-course review: its span contains the loop day, so the clamp bites. */
const PAST_COURSE_SCOPE = 'c1:course';
/** The first pass's first week: closed long before the loop, so never clamped. */
const PAST_WEEK_SCOPE = 'c1:w1';
/** The new cycle's first week, where the cycle-2 daily belongs. */
const NEW_WEEK_SCOPE = 'c2:w1';
const UNRECORDED_COPY = 'cannot be reconstructed';
const EDIT_NAME = 'Edit this entry';

test.use({ timezoneId: ACCOUNT_TIMEZONE });

interface SourcesResponse {
  window_start: string | null;
  window_end: string | null;
  anchor_status: string;
  items: Array<{ kind: string; id: number }>;
}

interface LoopedAccount {
  email: string;
  token: string;
  cycleOneDaily: number;
  cycleTwoDaily: number;
  reviewId: number;
  /** Cycle 1's program start, as the arrange left it before the loop. */
  anchorBefore: string;
  /** The instant begin-again stamped as cycle 2's start: the loop itself. */
  loopInstant: string;
}

async function postEntry(
  request: APIRequestContext,
  token: string,
  data: Record<string, string>,
): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, { headers: bearer(token), data });
  expect(created.status()).toBe(HTTP_CREATED);
  return ((await created.json()) as { id: number }).id;
}

/** Post and finish an entry: the sources feed serves only finished pages. */
async function postFinished(
  request: APIRequestContext,
  token: string,
  data: Record<string, string>,
): Promise<number> {
  const id = await postEntry(request, token, data);
  const finished = await request.patch(`${backendUrl()}/journal/${id}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(HTTP_OK);
  return id;
}

async function readSources(
  request: APIRequestContext,
  token: string,
  level: string,
  scopeKey: string,
): Promise<SourcesResponse> {
  const response = await request.get(
    `${backendUrl()}/reflections/sources?level=${level}&scope_key=${encodeURIComponent(scopeKey)}`,
    { headers: bearer(token) },
  );
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as SourcesResponse;
}

/**
 * The instant a `YYYY-MM-DD` day begins in ACCOUNT_TIMEZONE. The zone is pinned
 * to UTC, so that local midnight is the UTC midnight `Date.UTC` names.
 */
function localMidnightOf(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not a YYYY-MM-DD day key: ${dayKey}`);
  }
  return Date.UTC(year, month - 1, day);
}

function sourceIds(sources: SourcesResponse): number[] {
  return sources.items.map((item) => item.id);
}

/**
 * Live a first cycle to its final stage, write in it, leave its course review
 * as a draft, begin again through the real route, and write once in cycle 2.
 */
async function loopedAccount(page: Page, prefix: string): Promise<LoopedAccount> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  setProgramAnchorDaysAgo(email, DAYS_INTO_STAGE_TEN);

  // Reading the calendar is what records entry into stage 10; the rewind alone does not.
  const calendar = await page.request.get(`${backendUrl()}/stages/program-calendar`, {
    headers: bearer(token),
  });
  expect(calendar.status()).toBe(HTTP_OK);
  expect(await calendar.json()).toEqual(
    expect.objectContaining({ current_stage: FINAL_STAGE, cycle_number: FIRST_CYCLE }),
  );
  const anchorBefore = showProgramProgress(email).program_started_at;

  const cycleOneDaily = await postFinished(page.request, token, {
    title: 'A first-pass page',
    message: 'Written in the middle of the first time through.',
    entry_date: isoDaysAgo(CYCLE_ONE_DAILY_DAYS_AGO),
  });
  const reviewId = await postEntry(page.request, token, {
    title: 'Course Review',
    message: 'The whole first pass, read back.',
    tag: REFLECTION_TAG,
    reflection_level: 'course',
    reflection_scope_key: PAST_COURSE_SCOPE,
  });

  const looped = await page.request.post(`${backendUrl()}/stages/begin-again`, {
    headers: bearer(token),
  });
  expect(looped.status()).toBe(HTTP_OK);
  expect(await looped.json()).toEqual(expect.objectContaining({ cycle_number: SECOND_CYCLE }));
  const after = showProgramProgress(email);
  expect(after.past_cycle_anchors).toHaveLength(FIRST_CYCLE);
  expect(Date.parse(after.past_cycle_anchors[0] ?? '')).toBe(Date.parse(anchorBefore));

  const cycleTwoDaily = await postFinished(page.request, token, {
    title: 'A second-pass page',
    message: 'The first day of the second time through.',
  });
  // Positive control: the cycle-2 daily IS a finished source -- of its own
  // cycle -- so its absence from the first pass's review is the window's doing.
  expect(sourceIds(await readSources(page.request, token, 'week', NEW_WEEK_SCOPE))).toContain(
    cycleTwoDaily,
  );

  return {
    email,
    token,
    cycleOneDaily,
    cycleTwoDaily,
    reviewId,
    anchorBefore,
    loopInstant: after.program_started_at,
  };
}

async function reopenFromShelf(page: Page, entryId: number): Promise<void> {
  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
}

test('a first-pass review, reopened after beginning again, gathers only that cycle’s own writing', async ({
  page,
}) => {
  const account = await loopedAccount(page, 'past-cycle-recorded');

  await reopenFromShelf(page, account.reviewId);
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  await expect(
    page.locator(`[data-testid="entry-source-${account.cycleOneDaily}"]:visible`),
  ).toBeVisible();
  await expect(page.locator(`[data-testid="entry-source-${account.cycleTwoDaily}"]`)).toHaveCount(
    0,
  );

  const declared = await readSources(page.request, account.token, 'course', PAST_COURSE_SCOPE);
  expect(declared.anchor_status).toBe('recorded');
  expect(sourceIds(declared)).toContain(account.cycleOneDaily);
  expect(sourceIds(declared)).not.toContain(account.cycleTwoDaily);
  const windowStart = declared.window_start ?? '';
  const windowEnd = declared.window_end ?? '';
  // The first pass closes EXACTLY at the local midnight that opened the loop
  // day -- not at the loop instant itself, which would leave that morning
  // inside both cycles. An exact instant, not a day-wide bracket: a clamp at the
  // raw loop instant differs from it by however far past midnight the loop ran.
  expect(Date.parse(windowEnd)).toBe(
    localMidnightOf(dayKeyIn(account.loopInstant, ACCOUNT_TIMEZONE)),
  );
  // ... and the second pass's first week opens at that same instant, so the
  // two laps abut with neither gap nor overlap.
  const secondPassOpens = (await readSources(page.request, account.token, 'week', NEW_WEEK_SCOPE))
    .window_start;
  expect(Date.parse(secondPassOpens ?? '')).toBe(Date.parse(windowEnd));
  // ... which is short of the 252 days the course would otherwise span: the clamp bit.
  expect(Date.parse(windowEnd)).toBeLessThan(
    Date.parse(account.anchorBefore) + TOTAL_PROGRAM_DAYS * MS_PER_DAY,
  );

  // The panel names the period the server windowed on. The expected label is
  // built from the declared bounds by calendar arithmetic -- the exclusive end's
  // day, less one calendar day -- rather than by restating the panel's own step.
  const expectedPeriod = await page.evaluate(
    ({ start, end, timeZone }: { start: string; end: string; timeZone: string }) => {
      const exclusive = new Date(end);
      const lastDay = new Date(
        Date.UTC(exclusive.getUTCFullYear(), exclusive.getUTCMonth(), exclusive.getUTCDate() - 1),
      );
      const fromLabel = new Date(start).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone,
      });
      const toLabel = lastDay.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone,
      });
      return `${fromLabel} – ${toLabel}`;
    },
    { start: windowStart, end: windowEnd, timeZone: ACCOUNT_TIMEZONE },
  );
  await expect(page.locator('[data-testid="reflection-sources-period"]:visible')).toHaveText(
    expectedPeriod,
  );
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
});

test('a first pass whose anchor was never recorded says its period cannot be reconstructed', async ({
  page,
}) => {
  const account = await loopedAccount(page, 'past-cycle-unrecorded');
  const forgotten = forgetPastCycleAnchor(account.email, FIRST_CYCLE);
  expect(forgotten.past_cycle_anchors[0]).toBeNull();

  const declared = await readSources(page.request, account.token, 'course', PAST_COURSE_SCOPE);
  expect(declared).toEqual(
    expect.objectContaining({
      anchor_status: 'unrecorded',
      window_start: null,
      window_end: null,
      items: [],
    }),
  );

  await reopenFromShelf(page, account.reviewId);
  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  await expect(page.locator('[data-testid="reflection-sources-unrecorded"]:visible')).toContainText(
    UNRECORDED_COPY,
  );
  await expect(page.locator('[data-testid="reflection-sources-empty"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="reflection-sources-period"]')).toHaveCount(0);
  await expect(page.locator(`[data-testid="entry-source-${account.cycleOneDaily}"]`)).toHaveCount(
    0,
  );
});

test('a finished first-pass review is read, not added to, until Edit is confirmed', async ({
  page,
}) => {
  const account = await loopedAccount(page, 'past-cycle-read-mode');
  const weekReview = await postFinished(page.request, account.token, {
    title: 'Weekly Review — Week 1',
    message: 'The first week of the first pass.',
    tag: REFLECTION_TAG,
    reflection_level: 'week',
    reflection_scope_key: PAST_WEEK_SCOPE,
  });

  await reopenFromShelf(page, weekReview);
  // Sources is a writing door (#3002/#3004): a finished page opens to read.
  const edit = page.getByRole('button', { name: EDIT_NAME });
  await expect(edit).toBeVisible();
  await expect(page.locator('[data-testid="reflection-sources-toggle"]:visible')).toHaveCount(0);

  await edit.click();
  await page.getByTestId('edit-confirm-edit').click();
  const toggle = page.locator('[data-testid="reflection-sources-toggle"]:visible');
  await expect(toggle).toBeVisible();
  await toggle.click();
  // The first week ended long before the loop: a whole, unclamped, empty week.
  await expect(page.locator('[data-testid="reflection-sources-period"]:visible')).toBeVisible();
  await expect(page.locator('[data-testid="reflection-sources-empty"]:visible')).toBeVisible();
});
