import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';

/**
 * Issue #2666 — the persona beside a stage on the Map is the course archetype
 * the server holds, all the way through.
 *
 * The seam is `coursestage.relationship_to_free_will` -> `GET /stages` ->
 * `stageService` -> the Map's left column and its spoken label. Until #2666 that
 * word was a client-side copy in `mapLayout.ts`, so no spec could watch it come
 * from the server; asserting a literal at both ends would only prove the same
 * two words were typed twice.
 *
 * So this spec names no persona of its own. It reads the persona the Map shows,
 * rewrites that stage's row out of band (`tests.e2e.stage_copy set-field`, which
 * reports the value it replaced) and requires the replaced value to be exactly
 * what was on screen -- binding the rendered word to the row -- then reloads and
 * requires the Map to follow the row to a string the curriculum never held. A
 * client answering from its own copy of the seeded words passes the first half
 * and fails the second. The row is put back before the file ends.
 *
 * The arrange is out of band because stage copy is seeded, never posted: no
 * request schema accepts a persona. Every read under assertion goes through the
 * unmocked production client and page.
 */

const COPY_MODULE = 'tests.e2e.stage_copy';
const PERSONA_FIELD = 'relationship_to_free_will';

/** Mid-arc and paired in its row, so a first- or last-row answer cannot pass. */
const REWRITTEN_STAGE = 2;

/** What `set-field` reports: the value now stored and the one it replaced. */
interface FieldWrite {
  stage_number: number;
  field: string;
  value: string;
  previous: string;
}

/** Write one stage's persona straight into the lane database, reporting the old one. */
function writePersona(persona: string): FieldWrite {
  return JSON.parse(
    runBackendModule(COPY_MODULE, [
      'set-field',
      '--stage',
      String(REWRITTEN_STAGE),
      '--field',
      PERSONA_FIELD,
      '--value',
      persona,
    ]),
  ) as FieldWrite;
}

/** The Map's left-column persona line for the rewritten stage, as rendered. */
async function shownPersona(page: Page): Promise<string> {
  const block = page.getByTestId(`stage-text-fit-${String(REWRITTEN_STAGE)}`);
  await expect(block).toBeVisible();
  // The persona is the block's first line; descriptor and practice follow it.
  const persona = (await block.innerText()).split('\n')[0]?.trim() ?? '';
  expect(persona.length).toBeGreaterThan(0);
  return persona;
}

async function openMap(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();
}

let seeded: string | null = null;

test.afterAll(() => {
  // The lane shares one database across every journey, so the row goes back
  // even when an assertion ended the test early.
  if (seeded !== null) writePersona(seeded);
});

test("the Map's stage persona is the one the coursestage row holds", async ({ page }) => {
  await signUp(page, 'map-stage-persona');
  await openMap(page);

  const before = await shownPersona(page);
  const sentinel = `Rewritten Archetype ${randomUUID()}`;
  const written = writePersona(sentinel);
  seeded = written.previous;

  // The word on screen is the row's own value, not a client-side copy of it.
  expect(written.previous).toBe(before);
  expect(written.value).toBe(sentinel);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();

  // The assertion the journey exists for: the Map follows the row.
  await expect(page.getByTestId(`stage-text-fit-${String(REWRITTEN_STAGE)}`)).toContainText(
    sentinel,
  );
  await expect(page.getByTestId(`stage-hotspot-${String(REWRITTEN_STAGE)}-0`)).toHaveAttribute(
    'aria-label',
    new RegExp(`^${sentinel} - `, 'u'),
  );

  const restored = writePersona(written.previous);
  seeded = null;
  expect(restored.value).toBe(before);
});
