import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Where the writing timer actually sits while a session runs, measured in a
 * real browser at the desktop viewport the defect was reported against.
 *
 * Issue #2656 reported the timer "stretching across the viewport and overlaying
 * the lower editor" at 1280x720, against commit `545f0053`. At that commit the
 * pill had no width constraint of any kind -- `marginHorizontal: 16` inside a
 * `left: 0 / right: 0` absolute wrapper -- so it took the full 1248dp of the
 * band and painted an opaque, touch-absorbing box across the writing column.
 * `94b69c95` (#2646) rebuilt both shapes: the idle pill now shrink-wraps its
 * own contents inside a centred track, and the running pill docks to a 44dp
 * rail beside the sheet. This spec is the regression guard that change never
 * got, and it is the third acceptance criterion of #2656.
 *
 * Jest cannot settle any of it: `jest.config.js` runs the `node` environment
 * under the React Native preset, so `onLayout` never fires and every box is
 * zero. The sibling `writingTimerLayout.test.tsx` therefore asserts on STYLE
 * OBJECTS and on the arithmetic between the clearance constants -- worth
 * having, and not the same claim. `maxWidth: 680` in a style sheet is not
 * evidence that the laid-out pill is at most 680dp wide; this file found that
 * out the hard way, and the note on ANTI-STRETCH below records what it found.
 *
 * The four questions it asks of laid-out DOM, printing every box on each run:
 *
 *  1. LIVENESS -- is a session genuinely running before any geometry is
 *     trusted? Asserted first and hard. Every claim below is vacuous if the
 *     arrange quietly left an idle timer on screen: a pill that never started
 *     is small, well-behaved, and proves nothing about the active state.
 *  2. ANTI-STRETCH -- does the idle pill size itself to its contents, or to the
 *     viewport? This is the reported defect stated as geometry, and it is
 *     asserted by WIDENING THE VIEWPORT and requiring the width not to move,
 *     rather than by comparing it to a constant. The constant would have been
 *     the vacuous version: the pill measures 277dp here, so `width <= 680`
 *     passes whether or not the cap exists -- and in fact the `maxWidth` in
 *     `pillExpanded` never binds at all, because the pill's parent shrink-wraps
 *     it first. A guard written against that constant would have guarded
 *     nothing. A pill that stretches with the viewport is the defect itself,
 *     and no implementation of the defect can survive this.
 *  3. NON-OVERLAP -- does the RUNNING pill's box intersect the title or body
 *     textarea? It must not: docked, it is a rail outside the sheet entirely.
 *  4. REACHABILITY -- are the body and the Finish control hit-testable rather
 *     than merely present? `elementFromPoint` at each centre, plus a typed
 *     character that has to arrive and a Finish press that has to reach the
 *     wire. "In the DOM" and "not covered by an opaque floating pill" are
 *     different claims and the defect is the second one.
 *
 * Two things this spec deliberately does NOT assert, both recorded rather than
 * frozen:
 *
 * - The right-rail asymmetry the issue's "Actual" paragraph also describes (the
 *   fixed 220dp margin column rendered unconditionally at
 *   `JournalEntryScreen.tsx:2089-2097`). Whether that is a defect or the
 *   intended Candle & Ink reading measure is a product decision, and a test
 *   that froze either answer would be this repository deciding it silently.
 * - That the IDLE pill clears the body textarea. It does not, and that is
 *   measured, not assumed: at 1280x720 the idle pill occupies x 502-778,
 *   y 542-644 while the body's box runs x 215-833, y 350-782, so the two
 *   genuinely intersect. The body is flex-grown taller than the fold and
 *   `WRITING_TIMER_CLEARANCE` reserves its 220dp at the END of the scrollable
 *   page, which is what keeps the last line and the Finish control clear (both
 *   asserted below) but does not shrink the textarea out from under a pill
 *   floating at a fixed viewport offset. Asserting non-overlap for the idle
 *   shape would fail on today's correct-by-design behaviour; asserting it for
 *   the running shape, which is what "the active writing state" means, is a
 *   real invariant and is question 3.
 */

/** Bounding boxes are sub-pixel; a fraction of a pixel is not an overlap. */
const SUBPIXEL_TOLERANCE = 1;
const SECONDS_PER_MINUTE = 60;
/** `touchTarget.minimum` -- the width of the docked rail the running pill becomes. */
const DOCK_RAIL_WIDTH = 44;
/** Two readout samples this far apart; the engine ticks ten times a second. */
const TICK_SAMPLE_MS = 1_500;
/** The viewport the issue reports against, and the one `playwright.config.ts` pins. */
const REPORTED_VIEWPORT = { width: 1280, height: 720 };
/**
 * A deliberately wider desktop, used only to ask whether the pill grows with
 * the window. Still above `TIMER_DOCK_MIN_VIEWPORT_WIDTH` (1020), so the shapes
 * under test are the same two shapes -- this changes the room, not the layout
 * mode.
 */
const WIDER_VIEWPORT = { width: 1600, height: 720 };
const TITLE = 'Measuring the desk';
const BODY =
  'I sat down to write and the timer kept its own corner of the page. ' +
  'The lamp was on and the room was quiet enough to hear the clock.';
const ADDENDUM = ' Still writing.';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function right(box: Box): number {
  return box.x + box.width;
}

function bottom(box: Box): number {
  return box.y + box.height;
}

/** The centre point of a laid-out box, in viewport coordinates. */
function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Do two laid-out rectangles share any area, beyond sub-pixel rounding? */
function intersects(a: Box, b: Box): boolean {
  const overlapX = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const overlapY = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  return overlapX > SUBPIXEL_TOLERANCE && overlapY > SUBPIXEL_TOLERANCE;
}

/**
 * A locator's layout box, or a loud failure -- never a silently skipped check.
 *
 * Waits for visibility first: `boundingBox` does not auto-wait, so without this
 * the measurement races the layout, and the caller has usually only awaited
 * something NEARBY. A viewport change re-lays the whole page out, which is
 * where that gap is widest and where this spec relies on it most.
 */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no layout box`);
  return box;
}

function pill(page: Page): Locator {
  return page.getByTestId('writing-timer-pill');
}

function body(page: Page): Locator {
  return page.getByTestId('journal-body-input');
}

function title(page: Page): Locator {
  return page.getByTestId('journal-title-input');
}

function finish(page: Page): Locator {
  return page.getByTestId('journal-finish-button');
}

function sheet(page: Page): Locator {
  return page.getByTestId('journal-sheet');
}

/** The readout's mm:ss face as a count of seconds, so two samples can be compared. */
async function remainingSeconds(page: Page): Promise<number> {
  const face = (await page.getByTestId('writing-timer-readout').textContent())?.trim() ?? '';
  const match = /^(\d+):(\d{2})$/u.exec(face);
  if (match === null) throw new Error(`the timer readout does not read as mm:ss: "${face}"`);
  const [, minutes, seconds] = match;
  return Number(minutes) * SECONDS_PER_MINUTE + Number(seconds);
}

/**
 * Open a new entry with real content in it, and leave the page in edit mode.
 *
 * The timer only mounts in edit mode (`EntryWritingSurfaces` returns null
 * otherwise), and an empty body would give the textarea a degenerate box that
 * no floating pill could plausibly overlap -- so the arrange writes enough to
 * make the editor a real target before anything is measured.
 */
async function openEntryInEditMode(page: Page): Promise<void> {
  await page.getByTestId('journal-new-entry').click();
  await title(page).fill(TITLE);
  await body(page).fill(BODY);
  await expect(pill(page)).toBeVisible();
  await expect(page.getByTestId('writing-timer-start')).toBeVisible();
}

/**
 * Start the session and PROVE it started, before any geometry is trusted.
 *
 * Three independent witnesses, because each alone has a way of lying. The
 * control swap could be a re-render of a still-idle engine; a single readout
 * sample says nothing about whether the clock is moving; and a 44dp width could
 * be a compact pill the writer merely minimised without ever starting. A
 * strictly falling countdown is the one that cannot be faked by layout, and a
 * docked width is the one that cannot be faked by a paused engine.
 */
async function startSessionAndProveItRuns(page: Page): Promise<void> {
  await page.getByTestId('writing-timer-start').click();

  // Witness 1: the idle affordances are gone and the live ones replaced them.
  await expect(page.getByTestId('writing-timer-pause')).toBeVisible();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  await expect(page.getByTestId('writing-timer-start')).toHaveCount(0);
  await expect(page.getByTestId('writing-timer-row-presets')).toHaveCount(0);

  // Witness 2: the countdown is actually counting down.
  const first = await remainingSeconds(page);
  await page.waitForTimeout(TICK_SAMPLE_MS);
  const second = await remainingSeconds(page);
  console.log(`[2656/liveness] readout ${first}s -> ${second}s after ${TICK_SAMPLE_MS}ms`);
  expect(
    second,
    'the writing session did not start: the countdown never moved, so every ' +
      'measurement below would describe an idle timer',
  ).toBeLessThan(first);

  // Witness 3: starting collapsed the pill onto the desk-side rail.
  const running = await boxOf(pill(page), 'the running timer pill');
  expect(
    running.width,
    'the running timer is not docked to the rail, so this is not the running shape',
  ).toBeLessThanOrEqual(DOCK_RAIL_WIDTH + SUBPIXEL_TOLERANCE);
}

/**
 * The geometry of the page, printed whatever it says.
 *
 * The numbers are the point as much as the assertions are: a run log carrying
 * the pill's box against the sheet's and the textarea's is what lets a later
 * reader re-decide these thresholds on evidence rather than on the comment
 * above them.
 */
async function report(page: Page, label: string): Promise<void> {
  const timer = await boxOf(pill(page), 'the timer pill');
  const text = await boxOf(body(page), 'the entry body');
  const paper = await boxOf(sheet(page), 'the journal sheet');
  console.log(
    `[2656/${label}] pill=${JSON.stringify(timer)} body=${JSON.stringify(text)} ` +
      `sheet=${JSON.stringify(paper)} viewport=${JSON.stringify(page.viewportSize())}`,
  );
}

/**
 * Drive the journal page to the very bottom of its scroll range.
 *
 * This is what makes `WRITING_TIMER_CLEARANCE` load-bearing for this spec
 * rather than incidental to it. That constant reserves 220dp at the END of the
 * scrollable page precisely so the last of the writer's content -- and the
 * Finish control below it -- comes to rest ABOVE the floating pill's band
 * instead of underneath it. `scrollIntoViewIfNeeded` alone scrolls the minimum
 * distance, which parks the element at the bottom edge of the scroller and
 * happens to clear the pill whatever the reserve is; only scrolling to the end
 * asks the question the constant exists to answer.
 *
 * Assigning `scrollTop` is deliberate: `scrollTo` honours the element's
 * scroll-behavior and can still be animating when the box is read, which
 * reports a half-scrolled page as an unreachable control.
 */
/**
 * Return the journal page to the top of its scroll range.
 *
 * Called before the running pill is measured against the editor, and not
 * cosmetic. The idle reserve check just above scrolls to the foot of the page,
 * which carries the body textarea up out of the pill's band entirely -- at the
 * end of the scroll the body's box sits at y -88 while the pill occupies
 * y 510-644. A non-overlap assertion taken in that state is vacuous: it would
 * hold for a pill parked anywhere at all, including squarely over the writing
 * column. Scrolled back to the top the body spans y 350-782, straddling the
 * pill's band, so the only thing that can keep them apart is the pill being on
 * the rail -- which is the claim.
 */
async function scrollPageToTop(page: Page): Promise<void> {
  await page.getByTestId('journal-page-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
}

async function scrollPageToEnd(page: Page): Promise<void> {
  const scrolled = await page.getByTestId('journal-page-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight };
  });
  expect(
    scrolled.scrollTop,
    'the journal page did not scroll to its end, so the reserve below the ' +
      'last line was never actually tested',
  ).toBeCloseTo(scrolled.maxScroll, 0);
}

/**
 * Is this element the thing the browser would actually hand a click at its own
 * centre -- or is something else painted on top of it?
 *
 * `toBeVisible` answers neither question: an element wholly covered by an
 * opaque floating pill is still visible by every definition Playwright uses.
 * `elementFromPoint` is the browser's own hit test, and the reported defect is
 * exactly a failure of it.
 *
 * Scrolled into view first, deliberately. At 1280x720 the Finish control sits
 * at y 810 on an unscrolled page -- below the fold, where `elementFromPoint`
 * returns null for reasons that have nothing to do with this bug. "Reachable"
 * is the claim the acceptance criterion makes, and reachable means the writer
 * can get to it and press it, not that it fits on the first screenful.
 */
async function expectHitTestable(page: Page, locator: Locator, what: string): Promise<void> {
  await scrollPageToEnd(page);
  await locator.scrollIntoViewIfNeeded();
  const box = await boxOf(locator, what);
  const covering = await locator.evaluate((element, centre) => {
    const hit = document.elementFromPoint(centre.x, centre.y);
    if (hit === null) return 'nothing at all (its centre is outside the viewport)';
    if (element === hit || element.contains(hit) || hit.contains(element)) return null;
    const id = hit.getAttribute('data-testid');
    return `<${hit.tagName.toLowerCase()}${id === null ? '' : ` data-testid="${id}"`}>`;
  }, centreOf(box));
  console.log(`[2656/reach] ${what} box=${JSON.stringify(box)} covering=${covering ?? 'nothing'}`);
  expect(covering, `${what} is not reachable at 1280x720: it is covered by ${covering}`).toBeNull();
}

test('the writing timer keeps its own corner of the desk while a session runs', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-timer-2656');
  const token = await tokenFor(page.request, email);
  await openEntryInEditMode(page);
  await report(page, 'idle');

  // --- Question 2: the idle pill sizes itself to its contents, not the window.
  const atReported = await boxOf(pill(page), 'the idle timer pill');
  const paper = await boxOf(sheet(page), 'the journal sheet');

  // It stays inside the sheet it belongs to. The pre-fix pill spanned x 16-1264
  // against a sheet of 190-1090 and fails both of these outright.
  expect
    .soft(atReported.x, 'the idle timer starts left of the journal sheet')
    .toBeGreaterThanOrEqual(paper.x - SUBPIXEL_TOLERANCE);
  expect
    .soft(right(atReported), 'the idle timer runs past the right edge of the journal sheet')
    .toBeLessThanOrEqual(right(paper) + SUBPIXEL_TOLERANCE);

  // And it does not grow with the window. This is the assertion that a pill
  // restored to `left: 0 / right: 0` cannot pass at any width.
  await page.setViewportSize(WIDER_VIEWPORT);
  await expect(pill(page)).toBeVisible();
  const atWider = await boxOf(pill(page), 'the idle timer pill at the wider viewport');
  console.log(
    `[2656/anti-stretch] width ${atReported.width} at ${REPORTED_VIEWPORT.width} -> ` +
      `${atWider.width} at ${WIDER_VIEWPORT.width}`,
  );
  expect(
    atWider.width,
    `the idle timer grew with the viewport (${atReported.width}dp at ` +
      `${REPORTED_VIEWPORT.width} became ${atWider.width}dp at ${WIDER_VIEWPORT.width}): ` +
      'it is sizing itself to the window rather than to its own contents',
  ).toBeCloseTo(atReported.width, 0);
  await page.setViewportSize(REPORTED_VIEWPORT);
  await expect(pill(page)).toBeVisible();

  // The completion control clears the IDLE pill at the foot of the page. This
  // is the one check the docked rail cannot make: the running pill sits beside
  // the sheet and so can never share the Finish control's x range, whereas the
  // idle pill spans x 502-778 directly above it. It is what makes
  // WRITING_TIMER_CLEARANCE load-bearing here -- shrink that reserve and the
  // scrolled-to-end Finish control comes to rest under the pill.
  await expectHitTestable(page, finish(page), 'the Finish control, with the timer idle');

  // ...and clears it by its whole box, not merely by its centre point. The
  // centre test alone is too weak to hold the reserve: shrinking
  // WRITING_TIMER_CLEARANCE by the pill's own height moves the scrolled-to-end
  // Finish control down into the pill's band by a few pixels, which buries its
  // lower edge while leaving the midpoint uncovered. Partial occlusion of a
  // completion control is the defect, so the box is what is asserted.
  const idlePill = await boxOf(pill(page), 'the idle timer pill');
  const restingFinish = await boxOf(finish(page), 'the Finish control at the foot of the page');
  console.log(
    `[2656/reserve] pill=${JSON.stringify(idlePill)} finish=${JSON.stringify(restingFinish)}`,
  );
  expect(
    intersects(idlePill, restingFinish),
    'the idle writing timer overlaps the Finish control once the page is ' +
      'scrolled to its end: the reserve below the last line is too small ' +
      `(pill ${JSON.stringify(idlePill)} vs Finish ${JSON.stringify(restingFinish)})`,
  ).toBe(false);

  // --- Nothing below this line is trusted until the session is proven live. ---
  await startSessionAndProveItRuns(page);
  await scrollPageToTop(page);
  await report(page, 'running');

  // --- Question 3: the running pill shares no area with either editable field.
  const running = await boxOf(pill(page), 'the running timer pill');
  for (const [what, locator] of [
    ['the entry body', body(page)],
    ['the entry title', title(page)],
  ] as const) {
    const field = await boxOf(locator, what);
    expect
      .soft(
        intersects(running, field),
        `the running writing timer overlays ${what} ` +
          `(pill ${JSON.stringify(running)} vs field ${JSON.stringify(field)})`,
      )
      .toBe(false);
  }

  // The rail reserves its own space BESIDE the sheet rather than floating over
  // it. A pill returned to the full-width band lands inside the sheet's span.
  expect(
    running.x,
    'the running timer sits over the journal sheet instead of the rail beside it',
  ).toBeGreaterThanOrEqual(right(paper) - SUBPIXEL_TOLERANCE);

  // --- Question 4: reachable, not merely present. ---
  await expectHitTestable(page, body(page), 'the entry body');
  await expectHitTestable(page, finish(page), 'the Finish control, with the session running');

  // The strongest form of the same claim: a character typed into the body has
  // to arrive. An opaque pill over the textarea absorbs the click that focuses
  // it, and this is what notices.
  await body(page).click();
  await page.keyboard.type(ADDENDUM);
  await expect(body(page)).toHaveValue(`${BODY}${ADDENDUM}`);

  // And the completion control still completes. Reachability that is never
  // exercised is a claim about pixels; this is the journey it protects.
  //
  // Asserted on the outcome rather than on a POST: the page autosaves while the
  // writer types, so by the time Finish is pressed the entry usually exists
  // already and the press issues an update, not a create. Waiting for the
  // create would have made this a race that passes only when autosave is slow.
  await finish(page).click();
  await expect(page.getByTestId('promote-quote-button')).toBeVisible();

  // Read it back out of band, so the browser's own state is never the witness:
  // the character typed past the floating pill has to have reached the server.
  const entries = await page.request.get(`${backendUrl()}/journal/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(entries.ok(), 'reading the finished entry back failed').toBe(true);
  const listed = (await entries.json()) as { items: Array<{ message: string }> };
  const bodies = listed.items.map((entry) => entry.message);
  expect(bodies, 'the finished entry did not carry the text typed past the timer').toContain(
    `${BODY}${ADDENDUM}`,
  );
});
