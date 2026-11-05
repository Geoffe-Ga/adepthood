import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';
import { NARROW_VIEWPORT, WIDE_VIEWPORT } from './routeWalk';

/**
 * Clear Light reads as the Neither/Both Mode on the Map, not as a scale.
 *
 * The seam is `archetypal_wavelength.json` (Clear Light's `mode`, with
 * `holds_all_modes`, and no pairs of its own) -> `curriculum.phase_chords` ->
 * `GET /stages` `mode` + `chord` -> `stageService` -> `StageModeSection` in the
 * Map's stage modal.
 *
 * It names no copy of its own. It reads the `GET /stages` response the page's
 * own `stages` client received (the route is never stubbed or rewritten),
 * requires Clear Light's served chord to be, phase for phase, the served
 * integrated name of every stage that plays its own scale, then opens Clear
 * Light from the Map drawer and requires the modal to state the served Mode,
 * show every served note of every phase, and show no integrated/shadow scale.
 * At 390 and 1280 px every note stays inside the modal and nothing scrolls
 * sideways. Screenshots land in this test's output directory for review.
 */

/** Clear Light: the stage whose Mode holds all the Modes. */
const CLEAR_LIGHT_STAGE = 10;

/** The six phases in canonical order, as the dataset spells them. */
const PHASES = [
  'Rising',
  'Peaking',
  'Withdrawal',
  'Diminishing',
  'Bottoming Out',
  'Restoration',
] as const;

/** Sub-pixel slack for layout rounding when comparing boxes. */
const SUB_PIXEL = 1;

/** The slice of a served stage this spec reads. */
interface WireStage {
  stage_number: number;
  manifestations?: Array<{ phase: string; integrated: { name: string } }>;
  mode?: { name: string; description: string; holds_all_modes: boolean } | null;
  chord?: Array<{ phase: string; notes: Array<{ stage_number: number; name: string }> }>;
}

/** One `GET /stages?paginate=true` page, the envelope the `stages` client drains. */
interface WirePage {
  items: WireStage[];
}

const isStageList = (response: Response): boolean =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === '/stages';

/** The `testID` slug `StageModeSection` gives a phase. */
const phaseSlug = (phase: string): string => phase.toLowerCase().replace(/\s+/gu, '-');

const noteChip = (page: Page, phase: string, stageNumber: number): Locator =>
  page.getByTestId(`stage-chord-${phaseSlug(phase)}-note-${String(stageNumber)}`);

/** The chord Clear Light should sound: every scale stage's integrated name, per phase. */
function expectedChord(stages: readonly WireStage[]): WireStage['chord'] {
  const scales = stages
    .filter((stage) => (stage.manifestations ?? []).length > 0)
    .sort((a, b) => a.stage_number - b.stage_number);
  return PHASES.map((phase, index) => ({
    phase,
    notes: scales.map((stage) => ({
      stage_number: stage.stage_number,
      name: stage.manifestations?.[index]?.integrated.name ?? '',
    })),
  }));
}

/** Open Clear Light's stage modal from the Map drawer. */
async function openClearLightModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Open Map menu' }).click();
  await page.getByTestId(`map-drawer-stage-${String(CLEAR_LIGHT_STAGE)}`).click();
  await expect(page.getByTestId('stage-modal')).toBeVisible();
  await expect(page.getByTestId('stage-mode')).toBeVisible();
}

type ServedMode = NonNullable<WireStage['mode']>;
type ServedChord = NonNullable<WireStage['chord']>;

/** Clear Light is served as a Mode holding all the Modes, chorded from every scale stage. */
function expectServedNeitherBoth(served: ReadonlyMap<number, WireStage>): {
  mode: ServedMode;
  chord: ServedChord;
} {
  const clearLight = served.get(CLEAR_LIGHT_STAGE);
  if (!clearLight?.mode) throw new Error('GET /stages served Clear Light with no mode');
  // No scale of its own...
  expect(clearLight.mode.holds_all_modes).toBe(true);
  expect(clearLight.manifestations ?? []).toEqual([]);
  // ...and a chord of every scale stage's served integrated name, per phase.
  const chord = clearLight.chord ?? [];
  expect(chord).toEqual(expectedChord([...served.values()]));
  expect(chord.every(({ notes }) => notes.length === CLEAR_LIGHT_STAGE - 1)).toBe(true);
  return { mode: clearLight.mode, chord };
}

/** The modal states exactly the served Mode, sounds exactly the served notes, and shows no scale. */
async function expectModalSounds(page: Page, mode: ServedMode, chord: ServedChord): Promise<void> {
  const statement = page.getByTestId('stage-mode');
  await expect(statement).toContainText(mode.name);
  await expect(statement).toContainText(mode.description);
  for (const { phase, notes } of chord) {
    for (const note of notes) {
      await expect(noteChip(page, phase, note.stage_number)).toHaveText(note.name);
    }
  }
  await expect(page.getByTestId('stage-expressions')).toHaveCount(0);
}

/** Every note sits inside the modal, and the page never scrolls sideways. */
async function expectNotesContained(page: Page, chord: ServedChord): Promise<void> {
  const modal = await page.getByTestId('stage-modal').boundingBox();
  expect(modal).not.toBeNull();
  for (const { phase, notes } of chord) {
    for (const note of notes) {
      const box = await noteChip(page, phase, note.stage_number).boundingBox();
      expect(box).not.toBeNull();
      if (box === null || modal === null) continue;
      const label = `${phase} note ${String(note.stage_number)}`;
      expect.soft(box.x, `${label} left`).toBeGreaterThanOrEqual(modal.x - SUB_PIXEL);
      expect
        .soft(box.x + box.width, `${label} right`)
        .toBeLessThanOrEqual(modal.x + modal.width + SUB_PIXEL);
    }
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const viewport of [NARROW_VIEWPORT, WIDE_VIEWPORT]) {
  test(`Clear Light's Map modal states the Neither/Both Mode and its chords at ${String(viewport.width)}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    // Every stage as the page's own `stages` client last received it.
    const served = new Map<number, WireStage>();
    page.on('response', (response) => {
      if (!isStageList(response) || !response.ok()) return;
      void response.json().then((body: WirePage) => {
        for (const stage of body.items) served.set(stage.stage_number, stage);
      });
    });

    await signUp(page, 'map-clear-light-mode');
    await openClearLightModal(page);
    await expect.poll(() => served.size, 'GET /stages served all ten stages').toBe(10);

    const { mode, chord } = expectServedNeitherBoth(served);
    await expectModalSounds(page, mode, chord);

    await expectNotesContained(page, chord);
    await page.getByTestId('stage-mode').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('mode.png') });
    await noteChip(page, 'Restoration', 1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('chord.png') });
  });
}
