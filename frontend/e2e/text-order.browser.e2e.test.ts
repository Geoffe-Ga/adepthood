import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import {
  openRoute,
  ROUTES,
  seedCensusAccount,
  SKIPPED,
  VIEWPORTS,
  viewportLabel,
  type Route,
  type Viewport,
  type WalkContext,
} from './routeWalk';
import {
  faces,
  leftEdges,
  legalFontSizes,
  offRampSizes,
  outsideParent,
  overlappingPairs,
  rawMarkup,
  SUBPIXEL_TOLERANCE,
  summaryLine,
  textCensusScript,
  type TextRecord,
} from './textCensus';

/**
 * The text census (#2948, epic #2946): every reachable route, at the phone
 * and desktop profiles, screenshotted and reduced to one record per visible
 * text node -- its string, computed face, size, weight, colour, box and
 * nearest `testID` -- so that "is this screen's text in order?" is answered
 * from numbers a reviewer can quote rather than from a glance.
 *
 * Why a browser spec: Jest runs the `node` environment under the React Native
 * preset, so `onLayout` never fires and every box is zero
 * (`habits-viewport.browser.e2e.test.ts`). Only Chromium can say where text is.
 *
 * What is ASSERTED, because geometry can hold it, per screen and viewport
 * (each as `expect.soft`, so one bad screen still censuses the rest):
 *   A. Containment -- no text box leaves its closest `testID` ancestor by more
 *      than a pixel, measured against the ancestor's scroll extent when it
 *      scrolls, so a list's below-the-fold rows are not false positives.
 *   B. No overlap -- no two unrelated text boxes share more than a pixel;
 *      nested `Text` spans are related and excluded.
 *   C. No raw markup -- no visible string carries `**`, `__`, `##` or `[x](`.
 *
 * What is REPORTED, not asserted: the off-ramp font sizes. The legal set is
 * computed from `type(width)`, `editorialType` and `uiType` (pinned to the
 * tokens by `src/design/__tests__/textCensus.test.ts`), and every size a
 * screen sets outside it is printed and written to the JSON. It is not a gate
 * at HEAD because `fontSize:` literals outside the tokens number in the
 * hundreds across dozens of files -- Map sets 8-12px, Course 21 and 48,
 * Settings 22 -- and a gate would red the lane on those screens at its first
 * run. Promoting `off-ramp={}` to an assertion is the exit criterion of the
 * per-screen remediation issues the epic files; until then the number is the
 * evidence. Everything that needs judgement -- one edge, one face per role,
 * scope -- is the summary line's `left edges=` and `faces=` columns and the
 * review step in `prompts/scans/text-order.md`.
 *
 * Artifacts land in `e2e/artifacts/text-order/<WxH>/<Route>.{png,json}`
 * (gitignored; CI publishes them as `text-order-census`). The PNG is the
 * viewport fold only -- the RNW root is `height: 100%` with inner scrollers,
 * so `fullPage` cannot see past it -- while the JSON, measured against scroll
 * extents, is the complete record.
 *
 * Nothing here spends: the walk never presses Get resonance, never opens the
 * photograph route and never transcribes a draft (see `SKIPPED`); the lane's
 * fake provider is the only one reachable regardless. #2860's action-row
 * sweep extends this walk (`routeWalk.ts`) rather than walking twice.
 */

const ARTIFACT_DIR = join(__dirname, 'artifacts', 'text-order');
/** Twenty-two routes at two viewports, each a fresh page load plus a screenshot. */
const WALK_TIMEOUT_MS = 10 * 60_000;
/**
 * How long one control may take to appear. Playwright's default is the test
 * timeout, so a route whose control is missing would otherwise wait out the
 * whole walk and strand every route after it; this makes it one unreached
 * route instead.
 */
const ACTION_TIMEOUT_MS = 15_000;

function logSkipped(): void {
  for (const skipped of SKIPPED) {
    console.log(`[2948] SKIPPED ${skipped.name}: ${skipped.reason}`);
  }
}

/** Open the route, or say why it could not be opened -- never silently. */
async function reach(page: Page, route: Route, context: WalkContext): Promise<string | null> {
  try {
    await openRoute(page, route, context);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A record, as a failure message names it: the string, its anchor, its box. */
function describe(record: TextRecord): string {
  const box = [record.x, record.y, record.w, record.h].map((n) => String(Math.round(n)));
  return `"${record.text}" in ${record.testId ?? '(no testID)'} at ${box.join(',')}`;
}

async function capture(page: Page, viewport: Viewport, route: Route): Promise<TextRecord[]> {
  const dir = join(ARTIFACT_DIR, viewportLabel(viewport));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${route.name}.png`), fullPage: true });
  return page.evaluate<TextRecord[]>(textCensusScript());
}

/** Write the JSON, print the summary line and hold the three geometric rules. */
function report(viewport: Viewport, route: Route, records: TextRecord[]): void {
  const label = viewportLabel(viewport);
  const legal = legalFontSizes(viewport.width);
  const outside = outsideParent(records, SUBPIXEL_TOLERANCE);
  const overlaps = overlappingPairs(records, SUBPIXEL_TOLERANCE);
  const markup = rawMarkup(records);
  const offRamp = offRampSizes(records, legal);
  writeFileSync(
    join(ARTIFACT_DIR, label, `${route.name}.json`),
    JSON.stringify({ viewport: label, route: route.name, legal: [...legal], offRamp, records }),
  );
  console.log(
    summaryLine(label, route.label, {
      textNodes: records.length,
      leftEdges: leftEdges(records),
      faces: faces(records).length,
      rawMarkup: markup.length,
      outsideParent: outside.length,
      overlaps: overlaps.length,
      offRamp,
    }),
  );
  const where = `${label} ${route.label}`;
  expect.soft(records.length, `${where}: the census found no text at all`).toBeGreaterThan(0);
  expect.soft(outside.map(describe), `${where}: text outside its component`).toEqual([]);
  expect
    .soft(
      overlaps.map(([a, b]) => `${describe(a)} overlaps ${describe(b)}`),
      `${where}: overlapping text`,
    )
    .toEqual([]);
  expect.soft(markup.map(describe), `${where}: raw markup on screen`).toEqual([]);
}

async function censusRoute(
  page: Page,
  viewport: Viewport,
  route: Route,
  context: WalkContext,
): Promise<void> {
  const failure = await reach(page, route, context);
  if (failure === null) {
    report(viewport, route, await capture(page, viewport, route));
  } else {
    console.log(`[2948] UNREACHED ${viewportLabel(viewport)} ${route.name}: ${failure}`);
    expect.soft(failure, `${viewportLabel(viewport)} ${route.label} was not reached`).toBeNull();
  }
}

test('every visible text node on every route sits inside its component, off other text and free of raw markup at both viewports', async ({
  page,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  logSkipped();
  const email = await signUp(page, 'text-order-2948');
  // Signing up lands on the Journal, which reads the account's practices before
  // the seed below adopts one, and Chromium may answer the walk's later reads
  // of `GET /user-practices/` from its own HTTP cache with that empty list --
  // the hazard `practice-stats.browser.e2e.test.ts` records against #2654,
  // seen here as the Practice tab painting "No practice yet" for an account
  // with one adopted. Routing a request disables the HTTP cache for it, and
  // the handler changes nothing else: every response still comes from the
  // lane's server.
  await page.route(`${backendUrl()}/**`, (route) => route.continue());
  const context = await seedCensusAccount(page.request, await tokenFor(page.request, email));

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const route of ROUTES) {
      await censusRoute(page, viewport, route, context);
    }
  }
});
