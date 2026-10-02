import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  backendUrl,
  bearer,
  isoDaysAgo,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * The account's zone, pinned for this spec. The server counts elapsed program
 * days in local midnights of the zone `signUp` records from the browser, while
 * the rewind and `isoDaysAgo` both count in UTC. Pinning the browser to UTC
 * makes the three clocks one, and keeps a DST shift out of a 251-day rewind.
 */
const ACCOUNT_TIMEZONE = 'UTC';

/**
 * Days-ago values for the rewind, NOT 1-based program days. Elapsed day 62 is
 * program day 63, the last of stage 3 (21 x 3), which closes the first section.
 */
const SECTION_RED_CLOSE_DAYS_AGO = 62;
/**
 * Elapsed day 251 is program day 252, the last day of the program (21 x 8 +
 * 42 x 2), which closes the course. 252 days ago would mean the program is over
 * and nothing is due.
 */
const COURSE_CLOSE_DAYS_AGO = 251;
/** How far into week 1 the backdated daily falls, so section 1 is its cover. */
const WEEK_ONE_DAYS_INTO_PROGRAM = 3;
const WEEK_ONE_DAILY_DAYS_AGO = COURSE_CLOSE_DAYS_AGO - WEEK_ONE_DAYS_INTO_PROGRAM;

const SECTION_LEVEL = 'section';
const COURSE_LEVEL = 'course';
const SECTION_RED_SCOPE = 'c1:x1';
const SECTION_SCOPES = ['c1:x1', 'c1:x2', 'c1:x3'] as const;
const COURSE_SCOPE = 'c1:course';
const SECTION_RED_TITLE = 'Section Review — Red';
/**
 * The course's three sections, by the Wavelength turn each closes, written out
 * rather than derived from SECTION_SCOPES so a seed dropped from the arrange
 * cannot quietly shrink what the decomposition is expected to hold.
 */
const SECTION_TITLES = [
  SECTION_RED_TITLE,
  'Section Review — Green',
  'Section Review — Ultraviolet',
] as const;
const STAGE_TEN_DAILY_TITLE = 'A late page';
const COURSE_TITLE = 'Course Review';
const REFLECTION_TAG = 'hierarchical_reflection';
const SECTION_EYEBROW = 'Section reflection';
const SECTION_BODY = 'Three stages behind me, and the red turn closing.';
const COURSE_BODY = 'The whole arc, read back.';
const CALENDAR_EDGE =
  'calendar edge: the rewind and this read straddled a local midnight, so a different day is due';

test.use({ timezoneId: ACCOUNT_TIMEZONE });

interface SavedEntry {
  id: number;
  tag: string;
  reflection_level: string | null;
  reflection_scope_key: string | null;
}

interface SourceItem {
  kind: 'reflection' | 'entry';
  id: number;
  title: string | null;
}

interface DueResponse {
  due: { level: string; scope_key: string } | null;
}

/** Post an entry over the real API and finish it, so the sources feed will serve it. */
async function seedFinished(
  request: APIRequestContext,
  token: string,
  data: Record<string, string>,
): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data,
  });
  if (!created.ok()) throw new Error(`seeding an entry failed with ${created.status()}`);
  const { id } = (await created.json()) as { id: number };
  const finished = await request.patch(`${backendUrl()}/journal/${id}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  if (!finished.ok()) throw new Error(`finishing entry ${id} failed with ${finished.status()}`);
  return id;
}

/** Assert the server, not the shelf, says `scopeKey` is the review due today. */
async function expectDue(
  request: APIRequestContext,
  token: string,
  level: string,
  scopeKey: string,
): Promise<void> {
  const response = await request.get(`${backendUrl()}/reflections/due`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  const { due } = (await response.json()) as DueResponse;
  expect(due, CALENDAR_EDGE).toEqual(expect.objectContaining({ level, scope_key: scopeKey }));
}

test('on the last day of stage 3 the shelf offers the Section Review — Red and saves it as c1:x1', async ({
  page,
}) => {
  const email = await signUp(page, 'section-review-red');
  const token = await tokenFor(page.request, email);
  setProgramAnchorDaysAgo(email, SECTION_RED_CLOSE_DAYS_AGO);
  await expectDue(page.request, token, SECTION_LEVEL, SECTION_RED_SCOPE);
  await page.reload();

  const cta = page.getByRole('button', { name: /^Write your Section Review/ });
  await expect(cta).toBeVisible();
  // The Wavelength turn the section closes is named in the band's scope line.
  await expect(cta).toHaveAccessibleName(new RegExp(SECTION_RED_TITLE, 'u'));
  await expect(page.getByRole('button', { name: 'Begin a page of morning pages' })).toHaveCount(0);
  await cta.click();

  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(SECTION_RED_TITLE);
  await page.getByRole('textbox', { name: 'Entry body' }).fill(SECTION_BODY);
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

  const saved = await page.request.get(`${backendUrl()}/journal/`, { headers: bearer(token) });
  const { items } = (await saved.json()) as { items: SavedEntry[] };
  expect(items.filter((entry) => entry.reflection_scope_key === SECTION_RED_SCOPE)).toEqual([
    expect.objectContaining({ tag: REFLECTION_TAG, reflection_level: SECTION_LEVEL }),
  ]);
});

test('on the program’s final day the Course Review gathers the three sections and the tenth stage', async ({
  page,
}) => {
  const email = await signUp(page, 'course-review-final-day');
  const token = await tokenFor(page.request, email);
  setProgramAnchorDaysAgo(email, COURSE_CLOSE_DAYS_AGO);
  await expectDue(page.request, token, COURSE_LEVEL, COURSE_SCOPE);

  const sectionIds: number[] = [];
  for (const [index, scopeKey] of SECTION_SCOPES.entries()) {
    sectionIds.push(
      await seedFinished(page.request, token, {
        title: SECTION_TITLES[index] ?? scopeKey,
        message: `Looking back on ${scopeKey}.`,
        tag: REFLECTION_TAG,
        reflection_level: SECTION_LEVEL,
        reflection_scope_key: scopeKey,
      }),
    );
  }
  // Week 1 lies inside section 1, whose finished review stands in for it.
  const weekOneDaily = await seedFinished(page.request, token, {
    title: 'An early page',
    message: 'The first week of the arc.',
    entry_date: isoDaysAgo(WEEK_ONE_DAILY_DAYS_AGO),
  });
  // Today is week 36, stage 10, which no section covers.
  const stageTenDaily = await seedFinished(page.request, token, {
    title: STAGE_TEN_DAILY_TITLE,
    message: 'The last week of the arc.',
  });

  // The server's own decomposition, in the order it resolves it: the three
  // sections, then the tenth stage's raw daily. The panel re-sorts by time, so
  // this order is only observable on the wire.
  const sources = await page.request.get(
    `${backendUrl()}/reflections/sources?level=${COURSE_LEVEL}&scope_key=${encodeURIComponent(COURSE_SCOPE)}`,
    { headers: bearer(token) },
  );
  expect(sources.ok()).toBe(true);
  const { items } = (await sources.json()) as { items: SourceItem[] };
  expect(items.map(({ kind, id }) => ({ kind, id }))).toEqual([
    ...sectionIds.map((id) => ({ kind: 'reflection', id })),
    { kind: 'entry', id: stageTenDaily },
  ]);
  expect(items.map(({ title }) => title)).toEqual([...SECTION_TITLES, STAGE_TEN_DAILY_TITLE]);

  await page.reload();
  const cta = page.getByRole('button', { name: /^Write your Course Review/ });
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page.getByRole('textbox', { name: 'Entry title' })).toHaveValue(COURSE_TITLE);
  await page.getByRole('textbox', { name: 'Entry body' }).fill(COURSE_BODY);
  await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');

  await page.locator('[data-testid="reflection-sources-toggle"]:visible').click();
  for (const id of sectionIds) {
    await expect(page.locator(`[data-testid="reflection-source-${id}"]:visible`)).toContainText(
      SECTION_EYEBROW,
    );
  }
  await expect(page.locator(`[data-testid="entry-source-${stageTenDaily}"]:visible`)).toBeVisible();
  await expect(page.locator(`[data-testid="entry-source-${weekOneDaily}"]`)).toHaveCount(0);
});
