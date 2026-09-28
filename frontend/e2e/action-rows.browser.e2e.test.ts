import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  actionRowScript,
  applyButtonSkips,
  buttonKey,
  declaredScreens,
  misalignedRows,
  outsideViewportWidth,
  overlappingButtons,
  ROW_TOP_TOLERANCE,
  SUBPIXEL_TOLERANCE,
  tableLine,
  unaccountedScreens,
  type ButtonRecord,
  type ButtonSkip,
} from './actionRows';
import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import {
  openRoute,
  ROUTES,
  seedCensusAccount,
  VIEWPORTS,
  viewportLabel,
  type Route,
  type Viewport,
  type WalkContext,
} from './routeWalk';

/**
 * The action-row sweep (#2860): every reachable route, at the phone and
 * desktop profiles, screenshotted and reduced to one line per visible element
 * with the button role -- its accessible name, `testID` and box -- so that
 * "are this screen's controls in order?" is answered from numbers a reviewer
 * can quote. The rule being checked is `## Action rows` in
 * `src/design/DESIGN.md`.
 *
 * Why a browser spec: Jest runs the `node` environment under the React Native
 * preset, so `onLayout` never fires and every box is zero
 * (`habits-viewport.browser.e2e.test.ts`). Only Chromium can say where a
 * button is.
 *
 * What is ASSERTED, because geometry can hold it, per screen and viewport
 * (each `expect.soft`, so one bad screen still sweeps the rest), all read in
 * ONE settled frame (`actionRowScript`):
 *   1. No overlap -- no two unrelated buttons share more than
 *      `SUBPIXEL_TOLERANCE` on both axes; a control nested in a pressable
 *      card is a composition and excluded.
 *   2. Inside the viewport -- no button's box leaves the viewport's width.
 *   3. One row, one top -- buttons side by side have tops within
 *      `ROW_TOP_TOLERANCE`.
 * Everything else the rule asks -- one decline as the corner X, confirm and
 * decline right-aligned together, a form's primary action placed, no lone
 * link under a card, one edge per group -- needs judgement and is the review
 * step: the screenshots and button tables under
 * `e2e/artifacts/action-rows/<WxH>/<Route>.{png,json}` (gitignored; CI
 * publishes them as `action-row-sweep` whatever the verdict).
 *
 * The route list is `routeWalk.ts`'s, shared with the text census, plus
 * `EXTRA_ROUTES`; a screen declared in `RootStack.tsx` or `BottomTabs.tsx`
 * that is neither walked nor in `SKIPPED_ROUTES` fails the inventory test, so
 * the list cannot fall behind the app. Nothing here spends: the walk presses
 * only navigation controls, never Get resonance, and never opens the
 * photograph route.
 */

const ARTIFACT_DIR = join(__dirname, 'artifacts', 'action-rows');
/** Twenty-two routes at two viewports, each a fresh page load plus a screenshot. */
const WALK_TIMEOUT_MS = 10 * 60_000;
/**
 * How long one control may take to appear. Playwright's default is the test
 * timeout, so a missing control would wait out the whole walk and strand every
 * route after it; this makes it one unreached route instead.
 */
const ACTION_TIMEOUT_MS = 15_000;

/** Screens this sweep never opens, each with the reason it cannot or must not. */
const SKIPPED_ROUTES: readonly { name: string; reason: string }[] = [
  {
    name: 'AdminFeedback',
    reason: 'admin capability gate: GET /admin/capabilities answers 403 for a lane account',
  },
  {
    name: 'JournalPhotograph',
    reason:
      'headless Chromium has no camera or picker to feed it, and a page it did read ' +
      'would be a paid transcription',
  },
];

/**
 * Buttons left out of the three assertions on one route, each a finding with
 * a follow-up rather than a tolerance. A skip whose button is no longer on
 * its route fails the sweep, so a fixed finding cannot leave its exemption
 * behind for the next control to hide under.
 */
const SKIPPED_BUTTONS: readonly ButtonSkip[] = [
  {
    route: 'Map',
    button: 'map-magnifier',
    reason:
      'the draggable magnifier lens (#2978) parks over the current stage and so covers ' +
      "that stage's own hotspots at both viewports, by design rather than by drift; " +
      'whether a lens may cover the controls it magnifies is a review-step question, ' +
      'and every other Map control is still held to the three rules',
  },
];

/** Screens the text census does not walk (yet) that this sweep does. */
const EXTRA_ROUTES: readonly Route[] = [
  {
    name: 'PromotedQuotes',
    label: 'Promoted quotes',
    anchor: 'promoted-quotes-screen',
    open: async (page) => {
      await page.goto(`${frontendUrl()}/journal`);
      await page.getByRole('button', { name: 'Open Journal menu' }).click();
      await page.getByRole('dialog').getByTestId('journal-drawer-promoted-quotes').click();
    },
  },
];

const SKIPPED_NAMES = new Set(SKIPPED_ROUTES.map((route) => route.name));
const WALKED: readonly Route[] = [...ROUTES, ...EXTRA_ROUTES].filter(
  (route) => !SKIPPED_NAMES.has(route.name),
);

/** The navigators the inventory is read from. */
const NAVIGATION_DIR = join(__dirname, '..', 'src', 'navigation');

/**
 * A page that breaks every assertion: two buttons overlapping, a row whose
 * tops differ by three pixels, a button hanging off the right edge of a 390px
 * viewport and one a vertical scroller cuts off there. Beside them, what must
 * stay silent: a lawful row, a control nested in a card, buttons hidden,
 * faded or under an aria-hidden sheet, a button below a scroller's fold level
 * with a footer outside it, and a pill a sideways rail holds past the edge.
 */
const BROKEN_FIXTURE = `
<!doctype html>
<style>
  body { margin: 0; }
  [role="button"] { position: absolute; width: 100px; height: 44px; }
</style>
<div role="button" aria-label="Overlap A" style="left: 16px; top: 16px"></div>
<div role="button" aria-label="Overlap B" style="left: 60px; top: 30px"></div>
<div role="button" aria-label="Row left" style="left: 16px; top: 120px"></div>
<div role="button" aria-label="Row right" style="left: 140px; top: 123px"></div>
<div role="button" aria-label="Lawful left" style="left: 16px; top: 220px"></div>
<div role="button" aria-label="Lawful right" style="left: 140px; top: 222px"></div>
<div role="button" aria-label="Off the edge" style="left: 330px; top: 320px"></div>
<div role="button" aria-label="Card" style="left: 16px; top: 420px; width: 300px; height: 120px">
  <div role="button" aria-label="Nested" style="left: 180px; top: 10px"></div>
</div>
<div role="button" aria-label="Hidden" style="left: 16px; top: 16px; visibility: hidden"></div>
<div role="button" aria-label="Faded" style="left: 16px; top: 16px; opacity: 0"></div>
<div aria-hidden="true">
  <div role="button" aria-label="Behind a sheet" style="left: 16px; top: 16px"></div>
</div>
<div style="position: absolute; left: 0; top: 600px; width: 390px; height: 100px;
            overflow-x: hidden; overflow-y: auto">
  <div role="button" aria-label="Cut off" style="left: 330px; top: 10px"></div>
  <div role="button" aria-label="Below the fold" style="left: 16px; top: 150px"></div>
</div>
<div role="button" aria-label="Footer" style="left: 200px; top: 754px"></div>
<div style="position: absolute; left: 0; top: 790px; width: 390px; height: 50px;
            overflow-x: auto; overflow-y: hidden">
  <div role="button" aria-label="Past the rail" style="left: 400px; top: 0"></div>
</div>
`;

async function measure(page: Page): Promise<ButtonRecord[]> {
  return page.evaluate<ButtonRecord[]>(actionRowScript());
}

const names = (pairs: Array<[ButtonRecord, ButtonRecord]>): string[][] =>
  pairs.map(([a, b]) => [a.name, b.name]);

/** Open the route, or say why it could not be opened -- never silently. */
async function reach(page: Page, route: Route, context: WalkContext): Promise<string | null> {
  try {
    await openRoute(page, route, context);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The pair, as a failure message names it. */
const pair = ([a, b]: [ButtonRecord, ButtonRecord]): string =>
  `${buttonKey(a)} (top ${String(Math.round(a.y))}) / ${buttonKey(b)} (top ${String(Math.round(b.y))})`;

/**
 * Screenshot the screen, write its buttons, print the table and hold the three
 * rules. Returns how many buttons it measured. A screen may lawfully have none
 * -- the feedback composer's choices are radios and its back arrow a link --
 * so emptiness is checked across the walk, not per screen.
 */
async function sweep(page: Page, viewport: Viewport, route: Route): Promise<number> {
  const label = viewportLabel(viewport);
  const dir = join(ARTIFACT_DIR, label);
  mkdirSync(dir, { recursive: true });
  const records = await measure(page);
  await page.screenshot({ path: join(dir, `${route.name}.png`), fullPage: true });
  writeFileSync(
    join(dir, `${route.name}.json`),
    JSON.stringify({ viewport: label, route: route.name, buttons: records }),
  );
  for (const record of records) console.log(tableLine(label, route.label, record));

  const where = `${label} ${route.label}`;
  const { kept, stale } = applyButtonSkips(records, route.name, SKIPPED_BUTTONS);
  expect.soft(stale, `${where}: a skipped button is no longer on the screen`).toEqual([]);
  expect
    .soft(overlappingButtons(kept, SUBPIXEL_TOLERANCE).map(pair), `${where}: overlapping buttons`)
    .toEqual([]);
  expect
    .soft(
      outsideViewportWidth(kept, viewport.width, SUBPIXEL_TOLERANCE).map(buttonKey),
      `${where}: buttons outside the viewport width`,
    )
    .toEqual([]);
  expect
    .soft(
      misalignedRows(kept, ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE).map(pair),
      `${where}: buttons on one row with different tops`,
    )
    .toEqual([]);
  return records.length;
}

test('the sweep catches every planted violation on a deliberately broken page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(BROKEN_FIXTURE);
  const records = await measure(page);

  // Laid out but not there for a reader: each would otherwise overlap "Overlap A".
  const measured = records.map((r) => r.name);
  for (const unseen of ['Hidden', 'Faded', 'Behind a sheet']) {
    expect(measured).not.toContain(unseen);
  }
  expect(names(overlappingButtons(records, SUBPIXEL_TOLERANCE))).toEqual([
    ['Overlap A', 'Overlap B'],
  ]);
  expect(outsideViewportWidth(records, 390, SUBPIXEL_TOLERANCE).map((r) => r.name)).toEqual([
    'Off the edge',
    'Cut off',
  ]);
  expect(names(misalignedRows(records, ROW_TOP_TOLERANCE, SUBPIXEL_TOLERANCE))).toEqual([
    ['Row left', 'Row right'],
  ]);
});

test('every screen the app declares is walked or skipped with a reason', () => {
  const declared = declaredScreens(
    readFileSync(join(NAVIGATION_DIR, 'RootStack.tsx'), 'utf8'),
    readFileSync(join(NAVIGATION_DIR, 'BottomTabs.tsx'), 'utf8'),
  );
  expect(declared).toContain('JournalEntry');
  expect(declared).toContain('Journal');
  expect(
    unaccountedScreens(
      declared,
      WALKED.map((r) => r.name),
      [...SKIPPED_NAMES],
    ),
  ).toEqual([]);
  // A skip must name a screen that exists, or it is exempting nothing.
  expect([...SKIPPED_NAMES].filter((name) => !declared.includes(name))).toEqual([]);
});

test('every button on every route stays clear of the others, inside the viewport and on one top per row at both viewports', async ({
  page,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  for (const skipped of SKIPPED_ROUTES) {
    console.log(`[2860] SKIPPED ${skipped.name}: ${skipped.reason}`);
  }
  for (const skipped of SKIPPED_BUTTONS) {
    console.log(`[2860] SKIPPED ${skipped.route} ${skipped.button}: ${skipped.reason}`);
  }
  const email = await signUp(page, 'action-rows-2860');
  // The HTTP-cache hazard `text-order.browser.e2e.test.ts` records: routing a
  // request disables Chromium's cache for it, and nothing else changes.
  await page.route(`${backendUrl()}/**`, (route) => route.continue());
  const context = await seedCensusAccount(page.request, await tokenFor(page.request, email));

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    let measured = 0;
    for (const route of WALKED) {
      const failure = await reach(page, route, context);
      if (failure === null) {
        measured += await sweep(page, viewport, route);
      } else {
        console.log(`[2860] UNREACHED ${viewportLabel(viewport)} ${route.name}: ${failure}`);
        expect
          .soft(failure, `${viewportLabel(viewport)} ${route.label} was not reached`)
          .toBeNull();
      }
    }
    // A walker that saw nothing would certify every screen it never measured.
    expect
      .soft(measured, `${viewportLabel(viewport)}: the sweep measured no button`)
      .toBeGreaterThan(0);
  }
});
