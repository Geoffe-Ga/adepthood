import { expect, type Page, type Route } from '@playwright/test';

import { frontendUrl, setProgramAnchorDaysAgo } from './journalHabitsBrowserSupport';

/**
 * The three Map states the legibility spec (#2657) measures, and how a lane
 * account is put into each one.
 *
 * Which stage is current is the calendar's to say, so it is moved the only way
 * it can be: the program anchor goes back through `tests.e2e.program_anchor`,
 * and the server works the stage out from that on the next read. Per-stage
 * completion has no writer at all -- no route records a stage as finished, and
 * the lane ships no arrange module for it -- so for the two later states the
 * spec lets `GET /stages` and `GET /stages/program-calendar` reach the lane's
 * server and rewrites only `progress` (and, for the returning traveller, the
 * `cycle_number`) on the way back. Nothing on the Map is stubbed: the store,
 * the service and every component read the server's own response.
 */

export type MapState = 'fresh' | 'partial' | 'completed';

export const MAP_STATES: readonly MapState[] = ['fresh', 'partial', 'completed'];

/**
 * Days back for the partial Map: inside stage 5's window, which opens on day
 * 84 (four 21-day stages), so 1-4 are behind and 6-10 still locked.
 */
const PARTIAL_DAYS_AGO = 90;
/** The stage the partial Map stands in. */
export const PARTIAL_STAGE = 5;
/**
 * Days back for the completed Map: inside stage 10's window, which opens on
 * day 210 (eight 21-day stages and one of 42) and closes on day 252.
 */
const COMPLETED_DAYS_AGO = 240;
/** The last stage, whose completion is what shows Begin again. */
export const FINAL_STAGE = 10;
/** A second pass round the arc, which is what shows the cycle caption. */
const SECOND_CYCLE = 2;
const FULL_PROGRESS = 1;

/** How many stages each state shows as locked, and how many as complete. */
export const EXPECTED: Readonly<Record<MapState, { locked: number; complete: number }>> = {
  fresh: { locked: FINAL_STAGE - 1, complete: 0 },
  partial: { locked: FINAL_STAGE - PARTIAL_STAGE, complete: PARTIAL_STAGE - 1 },
  completed: { locked: 0, complete: FINAL_STAGE },
};

/** The stage the calendar puts each state in. */
export const CURRENT_STAGE: Readonly<Record<MapState, number>> = {
  fresh: 1,
  partial: PARTIAL_STAGE,
  completed: FINAL_STAGE,
};

/** The journey read's opening for a state: "Stage N of 10". */
export const journeyReadFor = (state: MapState): string =>
  `Stage ${String(CURRENT_STAGE[state])} of ${String(FINAL_STAGE)}`;

/**
 * What only the arranged state shows, so a measure cannot run on the Map as it
 * looked before the calendar and the stage list answered: Begin again once the
 * arc is whole, and the cycle caption for the returning traveller.
 */
export const STATE_MARKER: Readonly<Record<MapState, string | null>> = {
  fresh: null,
  partial: 'cycle-indicator',
  completed: 'begin-again-button',
};

interface WireStage {
  stage_number: number;
  progress: number;
}

const isStageList = (url: URL): boolean => url.pathname === '/stages';
const isCalendar = (url: URL): boolean => url.pathname === '/stages/program-calendar';

/** Stages below `completeBelow` read as finished; every other field is the server's. */
async function patchProgress(route: Route, completeThrough: number): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as { items: WireStage[] };
  for (const stage of body.items) {
    if (stage.stage_number <= completeThrough) stage.progress = FULL_PROGRESS;
  }
  await route.fulfill({ response, json: body });
}

/** The server's calendar with this traveller on their second pass. */
async function patchCycle(route: Route): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as { cycle_number: number };
  await route.fulfill({ response, json: { ...body, cycle_number: SECOND_CYCLE } });
}

/**
 * Put `email`'s account into `state`. Call after sign-up and before the Map is
 * opened; the Map then loads its stages through the routes installed here.
 */
export async function arrangeMapState(page: Page, email: string, state: MapState): Promise<void> {
  if (state === 'fresh') return;
  const partial = state === 'partial';
  setProgramAnchorDaysAgo(email, partial ? PARTIAL_DAYS_AGO : COMPLETED_DAYS_AGO);
  const completeThrough = partial ? PARTIAL_STAGE - 1 : FINAL_STAGE;
  await page.route(isStageList, (route) => patchProgress(route, completeThrough));
  if (partial) await page.route(isCalendar, patchCycle);
}

/** Every stage number, 1 to 10. */
const STAGE_NUMBERS = Array.from({ length: FINAL_STAGE }, (_value, index) => index + 1);

/** In the page: whether every one of these `testID`s is mounted with a real width. */
function everyMeasured(ids: readonly string[]): boolean {
  return ids.every((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return el !== null && el.getBoundingClientRect().width > 0;
  });
}

/**
 * Open the Map and wait until it has settled in `state`: the state's own
 * markers shown, the wave drawn, every fitted
 * text wrapper measured to a real width, so the fitted font sizes are final,
 * and the magnifier at rest on the current stage.
 * The frame itself is then taken by `mapMeasureScript`, two animation frames on.
 */
export async function openSettledMap(page: Page, state: MapState): Promise<void> {
  await page.goto(`${frontendUrl()}/map`);
  // The state is established before anything is measured: the calendar's
  // current stage in the journey read and under the lens's YOU ARE HERE chip,
  // and the state's own marker.
  await expect(page.getByTestId('journey-read')).toContainText(journeyReadFor(state));
  const marker = STATE_MARKER[state];
  if (marker !== null) await expect(page.getByTestId(marker)).toBeVisible();
  await expect(page.getByTestId('map-magnifier').getByTestId('you-are-here')).toBeVisible();
  await expect(page.locator('[testid="map-wave"], [data-testid="map-wave"]')).toHaveCount(1);
  const fitted = STAGE_NUMBERS.flatMap((stage) => [
    `stage-text-fit-${String(stage)}`,
    ...(stage < FINAL_STAGE - 1 ? [`aspect-label-fit-${String(stage)}`] : []),
  ]);
  await expect.poll(() => page.evaluate(everyMeasured, fitted)).toBe(true);
  // The magnifier glides from wherever it mounted to the current stage once the
  // calendar answers; measure the Map it rests on, not one frame of the glide.
  const lens = page.getByTestId('map-magnifier');
  let previous = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await lens.boundingBox());
      const resting = box === previous;
      previous = box;
      return resting;
    })
    .toBe(true);
}
