import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';
import { NARROW_VIEWPORT, WIDE_VIEWPORT } from './routeWalk';

import { readBackendSource } from '@/testing/backendSource';

/**
 * Issue #3157 -- the six Wavelength phase names a traveller reads in a stage's
 * Map modal are the course's canonical terms, all the way through.
 *
 * The seam is `archetypal_wavelength.json` -> `GET /stages` `manifestations[]`
 * -> `stageService` -> `StageExpressionsSection` in the Map's stage modal. The
 * source end is already pinned against the vendored Modes of the Wavelength CSV
 * (`backend/scripts/check_wavelength_terms.py`, the content-drift job, and
 * `test_phase_names_match_the_canonical_modes_csv`); the renderer is pinned by
 * fixtures. Nothing held the two together, so this spec does.
 *
 * It names no phase term of its own beyond a guard on the CSV parse. It reads
 * the `GET /stages` response the page's own `stages` client received -- the
 * route is never stubbed or rewritten -- requires Teal's served manifestations
 * to equal Teal's two CSV rows, phase for phase, then opens Teal on the Map and
 * requires every phase eyebrow and every integrated / shadow name on screen to
 * be the served one. Teal (stage 8) is the stage #3135 corrected, and a locked
 * one on a fresh account, so the modal is reached through the Map drawer rather
 * than a hotspot the magnifier lens may be gliding across.
 *
 * Each viewport is checked at normal and at doubled text: every line of every
 * card stays inside that card, unclipped, every card inside the modal, and the
 * page never scrolls sideways. Screenshots land in this test's output directory for review; there
 * is deliberately no pixel baseline.
 */

/** Teal: the stage whose twelve names #3135 corrected. */
const TEAL_STAGE = 8;
const TEAL_COLOUR = 'Teal';

/** The six phases in canonical order, as the dataset spells them. */
const PHASES = [
  'Rising',
  'Peaking',
  'Withdrawal',
  'Diminishing',
  'Bottoming Out',
  'Restoration',
] as const;

/** The phases photographed: the first and the last, which bracket the scroll. */
const PHOTOGRAPHED_PHASES = [PHASES[0], PHASES[5]] as const;

/** The CSV's dosage values: medicine is the integrated (Rx) face, toxic the shadow (OD). */
const MEDICINE = 'Medicine';
const TOXIC = 'Toxic';

/** Doubled text: the targeted enlarged-text check. */
const TEXT_SCALE = 2;
/** Sub-pixel slack for layout rounding when comparing boxes. */
const SUB_PIXEL = 1;

/** One phase's two names, in the shape `GET /stages` serves and the CSV implies. */
interface PhaseNames {
  phase: string;
  integrated: string;
  shadow: string;
}

/** The slice of a served stage this spec reads. */
interface WireStage {
  stage_number: number;
  manifestations?: Array<{
    phase: string;
    integrated: { name: string };
    shadow: { name: string };
  }>;
}

/**
 * Teal's six phase-name pairs from the vendored Modes CSV.
 *
 * The file is a plain comma table with no quoted cells; a quote would mean the
 * split below is no longer a faithful parse, so it refuses one. Cells are
 * trimmed, as the drift gate trims them (the CSV carries trailing spaces).
 */
function canonicalTealNames(): PhaseNames[] {
  const text = readBackendSource('content', 'curriculum', 'modes_of_the_wavelength.csv');
  if (text.includes('"')) throw new Error('the Modes CSV grew quoted cells; parse it properly');
  const [header, ...rows] = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',').map((cell) => cell.trim()));
  const columns = (header ?? []).map((cell) => cell.toLowerCase());
  const column = (name: string): number => {
    const index = columns.indexOf(name.toLowerCase());
    if (index < 0) throw new Error(`the Modes CSV has no ${name} column`);
    return index;
  };
  const row = (dosage: string): string[] => {
    const found = rows.filter(
      (cells) => cells[column('dosage')] === dosage && cells[column('stage')] === TEAL_COLOUR,
    );
    expect(found, `${dosage} ${TEAL_COLOUR} rows in the Modes CSV`).toHaveLength(1);
    return found[0] ?? [];
  };
  const medicine = row(MEDICINE);
  const toxic = row(TOXIC);
  return PHASES.map((phase) => ({
    phase,
    integrated: medicine[column(phase)] ?? '',
    shadow: toxic[column(phase)] ?? '',
  }));
}

/** One `GET /stages?paginate=true` page, the envelope the `stages` client drains. */
interface WirePage {
  items: WireStage[];
}

/** Teal's served manifestations, reduced to their names. */
function servedTealNames(teal: WireStage): PhaseNames[] {
  return (teal.manifestations ?? []).map((manifestation) => ({
    phase: manifestation.phase,
    integrated: manifestation.integrated.name,
    shadow: manifestation.shadow.name,
  }));
}

const isStageList = (response: Response): boolean =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === '/stages';

/** The `testID` slug `StageExpressionsSection` gives a phase. */
const phaseSlug = (phase: string): string => phase.toLowerCase().replace(/\s+/gu, '-');

const expressionCard = (page: Page, phase: string, face: 'integrated' | 'shadow'): Locator =>
  page.getByTestId(`stage-expression-${phaseSlug(phase)}-${face}`);

/** A card's lines as rendered: its heading, its canon name, its canon description. */
async function cardLines(card: Locator): Promise<string[]> {
  return (await card.innerText()).split('\n').map((line) => line.trim());
}

/** Open Teal's stage modal from the Map drawer, whose row tap glides the lens and opens it. */
async function openTealModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Open Map menu' }).click();
  await page.getByTestId(`map-drawer-stage-${String(TEAL_STAGE)}`).click();
  await expect(page.getByTestId('stage-modal')).toBeVisible();
  await expect(page.getByTestId('stage-expressions')).toBeVisible();
}

/** Double every text leaf in the expressions section. */
async function doubleExpressionText(page: Page): Promise<void> {
  await page.getByTestId('stage-expressions').evaluate((root, scale) => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount > 0 || !element.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      element.style.fontSize = `${String(parseFloat(style.fontSize) * scale)}px`;
      const lineHeight = parseFloat(style.lineHeight);
      if (Number.isFinite(lineHeight)) {
        element.style.lineHeight = `${String(lineHeight * scale)}px`;
      }
    }
  }, TEXT_SCALE);
}

/** In the page: every text leaf of a card that spills past the card or its own box. */
function spilledText(card: Element, slack: number): string[] {
  const box = card.getBoundingClientRect();
  const spilled: string[] = [];
  for (const element of card.querySelectorAll<HTMLElement>('*')) {
    if (element.childElementCount > 0 || !element.textContent?.trim()) continue;
    const own = element.getBoundingClientRect();
    const clipped = element.scrollWidth > element.clientWidth + slack;
    const outside =
      own.left < box.left - slack ||
      own.right > box.right + slack ||
      own.top < box.top - slack ||
      own.bottom > box.bottom + slack;
    if (clipped || outside) spilled.push(element.textContent.trim());
  }
  return spilled;
}

/** Every card's text stays inside it, every card inside the modal, and nothing scrolls sideways. */
async function expectCardsContained(page: Page, served: readonly PhaseNames[]): Promise<void> {
  const modal = await page.getByTestId('stage-modal').boundingBox();
  expect(modal).not.toBeNull();
  for (const { phase } of served) {
    for (const face of ['integrated', 'shadow'] as const) {
      const card = expressionCard(page, phase, face);
      expect.soft(await card.evaluate(spilledText, SUB_PIXEL), `${phase} ${face}`).toEqual([]);
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      if (box === null || modal === null) continue;
      expect.soft(box.x, `${phase} ${face} left`).toBeGreaterThanOrEqual(modal.x - SUB_PIXEL);
      expect
        .soft(box.x + box.width, `${phase} ${face} right`)
        .toBeLessThanOrEqual(modal.x + modal.width + SUB_PIXEL);
    }
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Two animation frames, so a scroll or a restyle has painted before a screenshot. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Screenshot the first and last phase blocks, scrolled into the modal's view. */
async function photograph(page: Page, name: string, path: (file: string) => string): Promise<void> {
  for (const phase of PHOTOGRAPHED_PHASES) {
    await page.getByTestId(`stage-expression-${phaseSlug(phase)}`).scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: path(`${name}-${phaseSlug(phase)}.png`) });
  }
}

for (const viewport of [NARROW_VIEWPORT, WIDE_VIEWPORT]) {
  test(`Teal's Map modal reads the canonical Wavelength phase names at ${String(viewport.width)}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    // Teal as the page's own `stages` client last received it, from whichever
    // page of the envelope carried it: what the Map's store holds when the
    // modal opens.
    let servedTeal: WireStage | null = null;
    page.on('response', (response) => {
      if (!isStageList(response) || !response.ok()) return;
      void response.json().then((body: WirePage) => {
        servedTeal = body.items.find((stage) => stage.stage_number === TEAL_STAGE) ?? servedTeal;
      });
    });

    await signUp(page, 'map-wavelength-phases');
    await openTealModal(page);
    await expect.poll(() => servedTeal, 'GET /stages served stage 8').not.toBeNull();

    const canonical = canonicalTealNames();
    // A guard on the parse, not the assertion: the right row was read.
    expect(canonical[0]).toEqual({ phase: 'Rising', integrated: 'Epiphany', shadow: 'Delusion' });
    expect(canonical[PHASES.length - 1]).toEqual({
      phase: 'Restoration',
      integrated: 'Pattern-Seeking',
      shadow: 'Belief Salience',
    });

    // The served names are the course's own, phase for phase and in order.
    const served = servedTealNames(servedTeal ?? { stage_number: TEAL_STAGE });
    expect(served).toEqual(canonical);

    // And the modal shows exactly what was served: the eyebrow names the phase
    // (upper-cased by style, so compared without case), each card its name.
    const eyebrows = page.getByTestId('stage-expressions').getByRole('heading');
    await expect(eyebrows).toHaveCount(PHASES.length);
    for (const [index, names] of served.entries()) {
      await expect(eyebrows.nth(index)).toHaveText(names.phase, { ignoreCase: true });
      expect((await cardLines(expressionCard(page, names.phase, 'integrated')))[1]).toBe(
        names.integrated,
      );
      expect((await cardLines(expressionCard(page, names.phase, 'shadow')))[1]).toBe(names.shadow);
    }

    await expectCardsContained(page, served);
    await photograph(page, 'normal', (file) => info.outputPath(file));

    await doubleExpressionText(page);
    await expectCardsContained(page, served);
    await photograph(page, 'doubled', (file) => info.outputPath(file));
  });
}
