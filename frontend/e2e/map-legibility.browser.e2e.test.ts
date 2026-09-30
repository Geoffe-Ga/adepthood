import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';
import {
  clipsItsText,
  insideBox,
  insidePill,
  insideViewport,
  mapMeasureScript,
  STROKE_CLEARANCE_TOLERANCE_PX,
  strokeHits,
  within,
  withoutCovers,
  type Hotspot,
  type MapMeasurement,
} from './mapGeometry';
import {
  arrangeMapState,
  EXPECTED,
  journeyReadFor,
  openSettledMap,
  STATE_MARKER,
  type MapState,
} from './mapStates';
import { NARROW_VIEWPORT, WIDE_VIEWPORT } from './routeWalk';
import { overlappingPairs, SUBPIXEL_TOLERANCE, type Box, type TextRecord } from './textCensus';

/**
 * Issue #2657 -- the Map's stage annotations stay legible at every viewport.
 *
 * The Map is a three-column table with a decorative sine wave painted behind
 * its centre column, and that column also carries each stage's Aspect word,
 * its "Unlocks ..." copy, its padlock and, once finished, its check badge. The
 * text census (`text-order.browser.e2e.test.ts`) already holds text against
 * text on a fresh account; nothing held text against the wave, the viewport or
 * the stage band it belongs to, and nothing measured a Map anyone had walked.
 *
 * So this spec measures one settled frame (`mapMeasureScript`: two animation
 * frames, then the census and the Map in the same evaluate) of each state --
 * fresh (stage 1), partial (stage 5, stages 1-4 finished, second cycle) and
 * completed (stage 10 finished, Begin again showing) -- at the phone and the
 * desktop profiles, plus a short desktop window where the table cannot fit,
 * and asserts, each as `expect.soft` so one finding does not hide the next:
 *
 *   1. no two unrelated text boxes in the grid overlap;
 *   2. no text box, padlock or check badge in the grid meets the wave's
 *      painted stroke (the magnifier pill, and the EMPTINESS / UNITY watermark
 *      the converging wave rises through by design, are intended covers);
 *   3. every Map text box is on screen, or inside the Map's own scroller;
 *   4. each unlock line and padlock sits inside its own stage's cell;
 *   5. each stage cell's text stays inside the cell, the cell inside its band
 *      and the band inside the grid, so a short window scrolls (a real
 *      scroller, by computed overflow) instead of painting one stage on the next;
 *   6. the lens's own caption -- the YOU ARE HERE chip, the stage title and
 *      subtitle -- stays on the glass, inside the rim and clear of the pill's
 *      rounded ends, so a caption that grows must grow the pill (#2960);
 *   7. every line of every right-column aspect label reads whole -- never cut
 *      to an ellipsis -- and inside its own band, down to the narrowest phone
 *      (320) the app supports, where the label cell is at its thinnest (#2960).
 *
 * A second test sweeps rule 7 across every phone width from 320 to 390.
 *
 * Every rule is a pure function in `mapGeometry.ts`, pinned by
 * `src/design/__tests__/mapGeometry.test.ts`. Before any rule runs the spec
 * proves it measured something -- a wave with length, and exactly as many
 * unlock lines, padlocks and badges as the state has locked and finished
 * stages -- because a selector that matched nothing would pass every rule.
 *
 * Screenshots and the measured frame land in
 * `e2e/artifacts/map-legibility/<state>/<WxH>.{png,json}` (gitignored) for
 * review; there is deliberately no pixel baseline.
 */

const ARTIFACT_DIR = join(__dirname, 'artifacts', 'map-legibility');
/** A desktop window too short for the table's ten stages: the Map must scroll, not overpaint. */
const SHORT_VIEWPORT = { width: WIDE_VIEWPORT.width, height: 560 } as const;
/**
 * The narrowest phone the app supports (an iPhone SE's 320 CSS px), where the
 * right-column label cell is at its thinnest.
 */
const NARROWEST_VIEWPORT = { width: 320, height: 568 } as const;
/** Several full loads of the Map per test, each waiting on its fitted text. */
const STATE_TIMEOUT_MS = 4 * 60_000;

type Size = { width: number; height: number };

/** The viewports each state is measured at; the short window only where it bites. */
const CASES: Readonly<Record<MapState, readonly Size[]>> = {
  fresh: [WIDE_VIEWPORT, NARROW_VIEWPORT, SHORT_VIEWPORT],
  partial: [WIDE_VIEWPORT, NARROW_VIEWPORT],
  completed: [WIDE_VIEWPORT, NARROW_VIEWPORT, SHORT_VIEWPORT],
};

const PADLOCK = '\u{1F512}';
/** The chip the lens wears over the current stage. */
const YOU_ARE_HERE = 'YOU ARE HERE';
const HOTSPOT = /^stage-hotspot-(\d+)-([01])$/u;
const UNLOCK = /^stage-unlock-(\d+)$/u;
/** The EMPTINESS / UNITY watermark: the wave converges through it by design. */
const WATERMARK_PREFIX = 'title-fit-';

const label = (size: Size): string => `${String(size.width)}x${String(size.height)}`;

const describeBox = (box: Box): string =>
  [box.x, box.y, box.w, box.h].map((n) => String(Math.round(n))).join(',');

const describeRecord = (record: TextRecord): string =>
  `"${record.text}" in ${record.testId ?? '(no testID)'} at ${describeBox(record)}`;

/** The grid's own text: inside `map-grid`, the magnifier pill's caption excluded. */
function gridText(m: MapMeasurement): TextRecord[] {
  const { grid, lens } = m;
  if (grid === null) return [];
  return m.census.filter(
    (record) => within(record, grid) && (lens === null || !within(record, lens)),
  );
}

/** The stage hotspot a census record sits inside, found by document order, not by testID. */
function hotspotOf(m: MapMeasurement, record: TextRecord): Hotspot | undefined {
  return m.hotspots.find((spot) => within(record, spot));
}

/** Padlocks, by the hotspot column they sit in: 0 is the left text, 1 the centre cell. */
function padlocks(
  m: MapMeasurement,
  records: readonly TextRecord[],
  column: '0' | '1',
): Array<{ record: TextRecord; stage: string }> {
  return records.flatMap((record) => {
    const spot = record.text === PADLOCK ? HOTSPOT.exec(hotspotOf(m, record)?.id ?? '') : null;
    return spot?.[1] !== undefined && spot[2] === column ? [{ record, stage: spot[1] }] : [];
  });
}

function hotspotBox(m: MapMeasurement, stage: string, column: '0' | '1'): Box | null {
  return m.hotspots.find((spot) => spot.id === `stage-hotspot-${stage}-${column}`)?.box ?? null;
}

/** Fail loudly if the frame measured nothing, before any rule can pass on emptiness. */
function assertMeasured(m: MapMeasurement, state: MapState, where: string): void {
  const text = gridText(m);
  const { locked, complete } = EXPECTED[state];
  expect(m.grid, `${where}: map-grid is not mounted`).not.toBeNull();
  expect(m.wave.pathCount, `${where}: the wave drew no paths`).toBeGreaterThan(0);
  expect(m.wave.totalLength, `${where}: the wave has no length`).toBeGreaterThan(0);
  expect(m.wave.points.length, `${where}: the wave yielded no samples`).toBeGreaterThan(0);
  expect(m.wave.halfStroke, `${where}: the wave has no stroke`).toBeGreaterThan(0);
  const unlocks = text.filter((record) => UNLOCK.test(record.testId ?? ''));
  expect(unlocks, `${where}: unlock lines`).toHaveLength(locked);
  expect(padlocks(m, text, '1'), `${where}: centre padlocks`).toHaveLength(locked);
  expect(padlocks(m, text, '0'), `${where}: left padlocks`).toHaveLength(locked);
  expect(m.badges, `${where}: check badges`).toHaveLength(complete);
  assertStateMarkers(m, state, where);
}

/** The measured frame itself shows the arranged state, not the one before it. */
function assertStateMarkers(m: MapMeasurement, state: MapState, where: string): void {
  const texts = (id: string): string[] =>
    m.census.filter((record) => record.testId === id).map((record) => record.text);
  expect(texts('journey-read').join(' '), `${where}: journey read`).toContain(
    journeyReadFor(state),
  );
  const { lens } = m;
  const underLens = lens === null ? [] : m.census.filter((record) => within(record, lens));
  expect(
    underLens.map((record) => record.text),
    `${where}: the lens rests on the current stage`,
  ).toContain(YOU_ARE_HERE);
  const marker = STATE_MARKER[state];
  if (marker !== null) {
    const shown = m.census.some((record) => (record.testId ?? '').startsWith(marker));
    expect(shown, `${where}: ${marker} in the measured frame`).toBe(true);
  }
}

/**
 * The lens's own caption -- the chip and every line under it -- stays on the
 * glass: inside the rim and clear of the pill's rounded ends (#2960).
 */
function lensFindings(m: MapMeasurement): string[] {
  const { lens } = m;
  if (lens === null) return [];
  const caption: Array<{ what: string; box: Box }> = [
    ...(m.chip === null ? [] : [{ what: 'the YOU ARE HERE chip', box: m.chip }]),
    ...m.census
      .filter((record) => within(record, lens))
      .map((record) => ({ what: `"${record.text}"`, box: record as Box })),
  ];
  return caption
    .filter(({ box }) => !insidePill(box, lens.box, m.lensRim, SUBPIXEL_TOLERANCE))
    .map(
      ({ what, box }) =>
        `${what} at ${describeBox(box)} leaves the lens at ${describeBox(lens.box)}`,
    );
}

/** Rule 2: what the wave's paint reaches, intended covers aside. */
function strokeFindings(m: MapMeasurement): string[] {
  const covers = m.lens === null ? [] : [m.lens.box];
  const text = gridText(m).filter((record) => !(record.testId ?? '').startsWith(WATERMARK_PREFIX));
  const { points, halfStroke } = m.wave;
  const hit = (box: Box): boolean =>
    strokeHits(box, points, halfStroke, STROKE_CLEARANCE_TOLERANCE_PX).length > 0;
  return [
    ...withoutCovers(text, covers)
      .filter(hit)
      .map((record) => describeRecord(record)),
    ...m.badges
      .filter((badge) => withoutCovers([badge.box], covers).length > 0 && hit(badge.box))
      .map((badge) => `${badge.id} at ${describeBox(badge.box)}`),
  ];
}

/** The Map's own text outside the grid: the journey read above it and Begin again below. */
const MAP_CHROME = /^(?:journey-read|cycle-indicator|begin-again)/u;

/** Rule 3: Map text off screen, or outside the Map's scroller when it scrolls. */
function offscreenFindings(m: MapMeasurement): string[] {
  const { grid, scroll } = m;
  const findings = m.census
    .filter(
      (record) => (grid !== null && within(record, grid)) || MAP_CHROME.test(record.testId ?? ''),
    )
    .filter((record) =>
      scroll !== null && within(record, scroll)
        ? !insideBox(record, scrollExtent(scroll), SUBPIXEL_TOLERANCE)
        : !insideViewport(record, m.viewport, SUBPIXEL_TOLERANCE),
    )
    .map((record) => describeRecord(record));
  if (scroll !== null && !insideViewport(scroll.box, m.viewport, SUBPIXEL_TOLERANCE)) {
    findings.push(`map-scroll at ${describeBox(scroll.box)}`);
  }
  return findings;
}

/** The scroller's whole content, as far down as it scrolls. */
function scrollExtent(scroll: NonNullable<MapMeasurement['scroll']>): Box {
  return { ...scroll.box, h: Math.max(scroll.box.h, scroll.scrollHeight) };
}

/** Rule 4: unlock lines and padlocks outside their own stage's cell. */
function associationFindings(m: MapMeasurement): string[] {
  const text = gridText(m);
  const findings: string[] = [];
  const check = (record: TextRecord, stage: string, column: '0' | '1'): void => {
    const cell = hotspotBox(m, stage, column);
    if (cell === null || !insideBox(record, cell, SUBPIXEL_TOLERANCE)) {
      findings.push(`${describeRecord(record)} outside stage-hotspot-${stage}-${column}`);
    }
  };
  for (const record of text) {
    const unlock = UNLOCK.exec(record.testId ?? '');
    if (unlock?.[1] !== undefined) check(record, unlock[1], '1');
  }
  for (const column of ['0', '1'] as const) {
    for (const { record, stage } of padlocks(m, text, column)) check(record, stage, column);
  }
  return findings;
}

/** Rule 5: text spilling out of its cell, or a cell out of its band. */
function bandFindings(m: MapMeasurement): string[] {
  const findings: string[] = [];
  for (const spot of m.hotspots) {
    const stage = Number(HOTSPOT.exec(spot.id)?.[1]);
    const band = m.bands.find((row) => row.stages.includes(stage));
    if (spot.content !== null && !insideBox(spot.content, spot.box, SUBPIXEL_TOLERANCE)) {
      findings.push(`${spot.id} text at ${describeBox(spot.content)} spills its cell`);
    }
    if (band === undefined || !insideBox(spot.box, band.box, SUBPIXEL_TOLERANCE)) {
      findings.push(`${spot.id} at ${describeBox(spot.box)} leaves ${band?.id ?? 'every band'}`);
    }
  }
  return [...findings, ...gridFindings(m)];
}

/**
 * Rule 5, last link: the wave is drawn to the grid's own box, so a band outside
 * it is a band the wave was not anchored to.
 */
function gridFindings(m: MapMeasurement): string[] {
  const { grid } = m;
  if (grid === null) return [];
  return m.bands
    .filter((band) => !insideBox(band.box, grid.box, SUBPIXEL_TOLERANCE))
    .map((band) => `${band.id} at ${describeBox(band.box)} leaves map-grid`);
}

/** A right-column label's band: `right-label-fit-<label>` sits in `map-row-<label>`. */
const LABEL_WRAPPER_PREFIX = 'right-label-fit-';

/** Rule 7: an aspect label line cut to an ellipsis, or outside its own band. */
function labelFindings(m: MapMeasurement): string[] {
  const findings: string[] = [];
  for (const run of m.labels) {
    const where = `"${run.text}" in ${run.id} at ${describeBox(run.box)}`;
    if (clipsItsText(run, SUBPIXEL_TOLERANCE)) {
      findings.push(
        `${where} is cut: ${String(run.scrollWidth)}x${String(run.scrollHeight)} of text in a ` +
          `${String(run.clientWidth)}x${String(run.clientHeight)} line`,
      );
    }
    const bandId = `map-row-${run.id.slice(LABEL_WRAPPER_PREFIX.length)}`;
    const band = m.bands.find((row) => row.id === bandId);
    if (band === undefined || !insideBox(run.box, band.box, SUBPIXEL_TOLERANCE)) {
      findings.push(`${where} leaves ${bandId}`);
    }
  }
  return findings;
}

async function measure(page: Page, state: MapState, size: Size): Promise<MapMeasurement> {
  await page.setViewportSize(size);
  await openSettledMap(page, state);
  const dir = join(ARTIFACT_DIR, state);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${label(size)}.png`) });
  const measurement = await page.evaluate<MapMeasurement>(mapMeasureScript());
  writeFileSync(join(dir, `${label(size)}.json`), JSON.stringify(measurement));
  return measurement;
}

async function holdLegibility(page: Page, state: MapState, size: Size): Promise<void> {
  const where = `${state} ${label(size)}`;
  const m = await measure(page, state, size);
  assertMeasured(m, state, where);

  const overlaps = overlappingPairs(gridText(m), SUBPIXEL_TOLERANCE).map(
    ([a, b]) => `${describeRecord(a)} overlaps ${describeRecord(b)}`,
  );
  expect.soft(overlaps, `${where}: overlapping text`).toEqual([]);
  expect.soft(strokeFindings(m), `${where}: annotations under the wave`).toEqual([]);
  expect.soft(offscreenFindings(m), `${where}: text off screen`).toEqual([]);
  expect.soft(associationFindings(m), `${where}: annotations outside their stage`).toEqual([]);
  expect.soft(bandFindings(m), `${where}: stage text outside its band`).toEqual([]);
  expect.soft(lensFindings(m), `${where}: lens caption off the glass`).toEqual([]);
  expect.soft(m.labels.length, `${where}: aspect label lines measured`).toBeGreaterThan(0);
  expect.soft(labelFindings(m), `${where}: aspect labels cut or out of their band`).toEqual([]);

  const scrolls = m.scroll !== null && m.scroll.scrollHeight > m.scroll.clientHeight;
  if (size === SHORT_VIEWPORT) {
    expect.soft(scrolls, `${where}: a short window must scroll the Map`).toBe(true);
  }
  if (state === 'fresh' && size === WIDE_VIEWPORT) {
    expect.soft(scrolls, `${where}: the Map must fit a desktop window unscrolled`).toBe(false);
  }
}

for (const [state, sizes] of Object.entries(CASES) as Array<[MapState, readonly Size[]]>) {
  test(`every Map stage annotation clears the wave, its neighbours and the viewport, and stays in its own stage (${state})`, async ({
    page,
  }) => {
    test.setTimeout(STATE_TIMEOUT_MS);
    const email = await signUp(page, `map-legibility-${state}`);
    await arrangeMapState(page, email, state);
    for (const size of sizes) await holdLegibility(page, state, size);
  });
}

/** The phone widths rule 7 is swept across, narrowest first. */
const PHONE_WIDTH_STEP_PX = 5;
const PHONE_WIDTHS = Array.from(
  { length: (NARROW_VIEWPORT.width - NARROWEST_VIEWPORT.width) / PHONE_WIDTH_STEP_PX + 1 },
  (_value, index) => NARROWEST_VIEWPORT.width + index * PHONE_WIDTH_STEP_PX,
);

test('every aspect label reads whole at every phone width from 320 to 390', async ({ page }) => {
  test.setTimeout(STATE_TIMEOUT_MS);
  await signUp(page, 'map-legibility-labels');
  for (const width of PHONE_WIDTHS) {
    const size = { width, height: NARROWEST_VIEWPORT.height };
    const m = await measure(page, 'fresh', size);
    const where = `fresh ${label(size)}`;
    expect(m.labels.length, `${where}: aspect label lines measured`).toBeGreaterThan(0);
    expect.soft(labelFindings(m), `${where}: aspect labels cut or out of their band`).toEqual([]);
  }
});

/** A phone window short enough that the fresh Map overflows and scrolls. */
const TOUCH_VIEWPORT = { width: NARROW_VIEWPORT.width, height: 664 } as const;
/** How far each drag travels, and in how many touch moves. */
const DRAG_DISTANCE_PX = 120;
const DRAG_STEPS = 12;
/** A stage in the middle of the table, on screen before anything scrolls. */
const MID_TABLE_STAGE = 5;

interface Point2 {
  x: number;
  y: number;
}

/** A real finger drag through the DevTools protocol: start, move in steps, lift. */
async function touchDrag(cdp: CDPSession, from: Point2, to: Point2): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const t = step / DRAG_STEPS;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function centreOf(locator: Locator): Promise<Point2> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element to drag is not laid out');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The Map scrolls once the table outgrows the window, and the lens is dragged
 * inside that scroller: a finger on the lens must move the lens, never the grid
 * beneath it, while a finger anywhere else on the table still scrolls it.
 */
test('a touch drag on the lens moves the lens and leaves the Map still; a drag on the table scrolls it', async ({
  browser,
}) => {
  test.setTimeout(STATE_TIMEOUT_MS);
  const context = await browser.newContext({
    viewport: TOUCH_VIEWPORT,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await signUp(page, 'map-legibility-touch');
  await openSettledMap(page, 'fresh');
  const cdp = await context.newCDPSession(page);
  const scroller = page.getByTestId('map-scroll');
  const scrollTop = (): Promise<number> => scroller.evaluate((el) => el.scrollTop);
  const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, 'the fresh Map must overflow this window').toBeGreaterThan(0);

  // Bring the lens up to a mid-table stage that the unscrolled window shows,
  // and let it come to rest: from the top of the scroller, a finger moving up
  // is exactly the gesture that would scroll the Map down.
  const lens = page.getByTestId('map-magnifier');
  await page.getByTestId(`stage-hotspot-${String(MID_TABLE_STAGE)}-0`).tap();
  let resting = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await lens.boundingBox());
      const settled = box === resting;
      resting = box;
      return settled;
    })
    .toBe(true);
  await expect(lens).toBeInViewport();
  const before = await scrollTop();
  const from = await centreOf(lens);
  await touchDrag(cdp, from, { x: from.x, y: from.y - DRAG_DISTANCE_PX });
  await expect.poll(async () => (await centreOf(lens)).y).toBeLessThan(from.y);
  expect(await scrollTop(), 'a lens drag must not scroll the Map').toBe(before);

  // Control: the same gesture on the table's text does scroll the Map, so the
  // stillness above is the lens's doing and not a scroller that cannot move.
  const text = await centreOf(page.getByTestId('stage-text-fit-9'));
  await touchDrag(cdp, text, { x: text.x, y: text.y - DRAG_DISTANCE_PX });
  await expect.poll(scrollTop).toBeGreaterThan(before);
  await context.close();
});
