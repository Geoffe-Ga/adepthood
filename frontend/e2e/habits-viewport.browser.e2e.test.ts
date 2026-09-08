import { randomBytes } from 'node:crypto';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { readBrowserLaneState } from './browserState';
import { readLaneState } from './laneState';
import { freshLicenseKey } from './licenseKey';

/**
 * What a full page of habits actually does to its own box, measured in a real
 * browser at the two viewport profiles the app is built for.
 *
 * Issue #2658 reported the Habits grid as "clipped beneath fixed controls" with
 * no scroll container. Jest cannot settle that: `jest.config.js` runs the `node`
 * environment under the React Native preset, so `onLayout` never fires and every
 * box is zero -- `HabitsFooterLayout.test.tsx` says as much about itself. Only a
 * browser can, which is what this spec is. It asks two geometric questions of
 * laid-out DOM and prints the grid's overflow numbers on every run:
 *
 *  1. NON-OVERLAP -- does the grid run underneath the pagination bar or the
 *     Energy Scaffolding CTA? An in-flow sibling cannot; a fixed overlay would.
 *  2. REACHABILITY -- is the first tile wholly inside the grid's box before any
 *     scrolling, and the last tile wholly inside it after scrolling to the end?
 *     A missing or broken scroller would leave the later rows out of reach.
 *
 * There is deliberately no third assertion that a full page fits without
 * scrolling. It was written, run, and dropped on the measurement: at 1280x720
 * the ten tiles want 643px of content in a 496px box, and a mutation run that
 * drove the layout hook's chrome reserve up until `tileMinHeight` clamped to the
 * 44px touch-target floor still measured 638px of content -- the tile's own
 * intrinsic height (116px in the wide, icon-above-name layout) is what does not
 * fit, not the reserve. The grid cannot be made to fit that viewport without
 * redesigning the tile, so the fit is not an invariant this repo holds, and the
 * comments that claimed it were corrected in the same change rather than left
 * standing against a gate.
 *
 * What this spec cannot answer is the issue's subjective claim that labels and
 * badges are "partially hidden". Legibility is not a geometric property;
 * bounding-box containment is the closest honest proxy and it tests geometry.
 */

const ACCOUNT_PHRASE = 'Habits-viewport-2658-passphrase';
const ISO_DATE_LENGTH = 10;
const ENERGY_COST = 2;
const ENERGY_RETURN = 5;
/** Bounding boxes are sub-pixel; a fraction of a pixel is not an overlap. */
const SUBPIXEL_TOLERANCE = 1;
/** The wide desktop profile the issue reports against; the config pins it too. */
const WIDE_VIEWPORT = { width: 1280, height: 720 };
/** The phone profile, where the grid flips to one column of ten rows. */
const NARROW_VIEWPORT = { width: 390, height: 844 };
const CTA_NAME = 'Perform Energy Scaffolding';

/**
 * A full page of habits: `HABITS_PER_PAGE` is `MAX_HABITS` (10), so this fills
 * page zero exactly and makes both the pagination bar and the CTA render.
 */
const SEEDED_HABITS: ReadonlyArray<{ name: string; icon: string }> = [
  { name: 'High Flow Activity', icon: '\u{1F3A8}' },
  { name: 'Meditation', icon: '\u{1F9D8}' },
  { name: 'Movement', icon: '\u{1F3C3}' },
  { name: 'Reading', icon: '\u{1F4DA}' },
  { name: 'Journalling', icon: '\u{270D}' },
  { name: 'Cold Exposure', icon: '\u{1F9CA}' },
  { name: 'Sleep Hygiene', icon: '\u{1F634}' },
  { name: 'Time in Nature', icon: '\u{1F332}' },
  { name: 'Gratitude Practice', icon: '\u{1F64F}' },
  { name: 'Deep Work', icon: '\u{1F4A1}' },
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function frontendUrl(): string {
  const state = readBrowserLaneState();
  if (state === null) throw new Error('browser E2E state is missing; global setup did not run');
  return state.frontendUrl;
}

function backendUrl(): string {
  const state = readLaneState();
  if (state === null || state.baseUrl === '') {
    throw new Error('API lane state is missing; global setup did not boot a backend');
  }
  return state.baseUrl;
}

/**
 * A locator's layout box, or a loud failure -- never a silently skipped check.
 *
 * Waits for the element itself to be visible before measuring it. `boundingBox`
 * does not auto-wait, so without this the measurement races the layout: the
 * caller has usually awaited something NEARBY -- a tile's visibility, or a
 * count that resolves the moment the right number of nodes exist -- which does
 * not establish that THIS element has been laid out yet. A viewport change
 * re-lays the whole page out, which is where the gap is widest. The wait
 * changes nothing about what is asserted; it only stops the assertion being
 * taken before the page is ready to answer.
 */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no layout box`);
  return box;
}

/**
 * The scrolling grid element.
 *
 * On web RNW renders `FlatList` as a `ScrollView`, whose base style is
 * `overflowY: auto`, and spreads `testID` onto that same scrolling node -- so
 * this locator is the scroller itself, not a wrapper around one.
 */
function grid(page: Page): Locator {
  return page.getByTestId('habits-list');
}

function tiles(page: Page): Locator {
  return page.getByTestId('habit-tile');
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto(`${frontendUrl()}/get-started`);
  await page.getByRole('button', { name: 'I have a license key' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(ACCOUNT_PHRASE);
  await page.getByRole('textbox', { name: 'Gumroad license key' }).fill(freshLicenseKey());
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Skip the welcome' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
}

/**
 * Fill the account's first page over HTTP.
 *
 * A fresh account is empty: the ten fixture tiles have been behind
 * `EXPO_PUBLIC_HABIT_DEMO_MODE` since #2671, and that flag is lane-wide -- it
 * would change the app under test for every other browser spec, and it would
 * measure fixtures rather than rows the server actually returned. So the arrange
 * goes through the same public endpoints the app itself uses.
 */
async function seedHabits(request: APIRequestContext, email: string): Promise<void> {
  const login = await request.post(`${backendUrl()}/auth/login`, {
    data: { email, password: ACCOUNT_PHRASE },
  });
  if (!login.ok()) throw new Error(`seeding login failed with ${login.status()}`);
  const session = (await login.json()) as { token: string };
  const startDate = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
  for (const habit of SEEDED_HABITS) {
    const created = await request.post(`${backendUrl()}/habits/`, {
      headers: { Authorization: `Bearer ${session.token}` },
      data: {
        name: habit.name,
        icon: habit.icon,
        start_date: startDate,
        energy_cost: ENERGY_COST,
        energy_return: ENERGY_RETURN,
      },
    });
    if (!created.ok()) {
      throw new Error(`seeding "${habit.name}" failed with ${created.status()}`);
    }
  }
}

async function openHabits(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Habits', exact: true }).click();
  await expect(page.getByTestId('habits-pagination')).toBeVisible();
  await expect(page.getByRole('button', { name: CTA_NAME })).toBeVisible();
  await expect(tiles(page).first()).toBeVisible();
}

/**
 * The geometry of the page, printed whatever it says.
 *
 * These numbers are the point of the spec as much as the assertions are: a run
 * log that carries the grid's box, a tile's rendered height and the exact
 * overflow is what lets a later reader re-decide the fit question on evidence
 * instead of on the comment above the hook.
 */
async function report(page: Page, label: string): Promise<void> {
  const list = await boxOf(grid(page), 'the habits grid');
  const tile = await boxOf(tiles(page).first(), 'the first habit tile');
  const overflow = await grid(page).evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  const locked = await page.getByTestId('unlock-label').count();
  const count = await tiles(page).count();
  console.log(
    `[2658/${label}] tiles=${count} locked=${locked} ` +
      `grid=${JSON.stringify(list)} firstTile=${JSON.stringify(tile)} ` +
      `scrollHeight=${overflow.scrollHeight} clientHeight=${overflow.clientHeight} ` +
      `overflow=${overflow.scrollHeight - overflow.clientHeight}`,
  );
}

/** Assertion 1 -- the grid does not run underneath either footer control. */
async function expectNoOverlap(page: Page, label: string): Promise<void> {
  const list = await boxOf(grid(page), 'the habits grid');
  const bar = await boxOf(page.getByTestId('habits-pagination'), 'the pagination bar');
  const cta = await boxOf(
    page.getByRole('button', { name: CTA_NAME }),
    'the Energy Scaffolding CTA',
  );
  console.log(
    `[2658/${label}] non-overlap gridBottom=${list.y + list.height} ` +
      `paginationTop=${bar.y} ctaTop=${cta.y}`,
  );
  expect
    .soft(list.y + list.height, `${label}: the grid runs under the pagination bar`)
    .toBeLessThanOrEqual(bar.y + SUBPIXEL_TOLERANCE);
  expect
    .soft(list.y + list.height, `${label}: the grid runs under the Energy Scaffolding CTA`)
    .toBeLessThanOrEqual(cta.y + SUBPIXEL_TOLERANCE);
}

/** Every tile on a full page lies inside the grid's box, scrolling if it must. */
async function expectEveryTileReachable(page: Page, label: string): Promise<void> {
  const box = await boxOf(grid(page), 'the habits grid');
  const first = await boxOf(tiles(page).first(), 'the first habit tile');
  expect
    .soft(first.y, `${label}: the first tile starts above the grid's top edge`)
    .toBeGreaterThanOrEqual(box.y - SUBPIXEL_TOLERANCE);
  expect
    .soft(first.y + first.height, `${label}: the first tile is cut off before any scrolling`)
    .toBeLessThanOrEqual(box.y + box.height + SUBPIXEL_TOLERANCE);

  // Assigning scrollTop is deliberate: `scrollTo(0, scrollHeight)` honours the
  // element's scroll-behavior and can still be animating when the box is read,
  // which reports an unscrolled grid as an unreachable last row.
  const scrolled = await grid(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight };
  });
  const all = tiles(page);
  const last = await boxOf(all.nth((await all.count()) - 1), 'the last habit tile');
  const after = await boxOf(grid(page), 'the habits grid');
  console.log(
    `[2658/${label}] reachability scrollTop=${scrolled.scrollTop} ` +
      `maxScroll=${scrolled.maxScroll} lastTile=${JSON.stringify(last)}`,
  );
  expect
    .soft(scrolled.scrollTop, `${label}: the grid did not scroll to its end`)
    .toBe(scrolled.maxScroll);
  expect
    .soft(last.y, `${label}: the last tile sits above the grid's top edge`)
    .toBeGreaterThanOrEqual(after.y - SUBPIXEL_TOLERANCE);
  expect
    .soft(last.y + last.height, `${label}: the last tile hangs below the grid's bottom edge`)
    .toBeLessThanOrEqual(after.y + after.height + SUBPIXEL_TOLERANCE);
}

test('a full page of habits clears its footer controls and every tile is reachable', async ({
  page,
}) => {
  const email = `habits-2658-${randomBytes(6).toString('hex')}@example.com`;
  await signUp(page, email);
  await seedHabits(page.request, email);
  await page.reload();
  await openHabits(page);

  expect(await tiles(page).count()).toBe(SEEDED_HABITS.length);
  await report(page, 'wide');
  await expectNoOverlap(page, 'wide');
  await expectEveryTileReachable(page, 'wide');

  // The same page, re-laid-out for a phone: one column of ten rows. Driven on
  // this page rather than in a second project so the run pays one signup.
  await page.setViewportSize(NARROW_VIEWPORT);
  await expect(tiles(page).first()).toBeVisible();
  await report(page, 'narrow');
  await expectNoOverlap(page, 'narrow');
  await expectEveryTileReachable(page, 'narrow');

  await page.setViewportSize(WIDE_VIEWPORT);
});
