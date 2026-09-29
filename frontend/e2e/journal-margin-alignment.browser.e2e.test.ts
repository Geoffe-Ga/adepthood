import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { computeMarginSlots } from '../src/features/Journal/computeMarginSlots';

import {
  backendUrl,
  bearer,
  frontendUrl,
  seedHabit,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Margin notes sit beside the passages they annotate, and stay reachable
 * (#2418), measured on laid-out DOM -- Jest's node env never fires onLayout.
 *
 * The page is long, and the stub provider quotes a page's LAST sentence, so two
 * passes -- one before and one after appending a sentence -- leave two notes
 * whose passages sit at the very bottom, one right after the other. That is
 * both questions at once: a note far down must sit beside its passage, not at
 * the top of the column; and two passages closer together than a note is tall
 * must not stack their notes on top of each other. The lower note then hangs
 * below the end of the writing, so the column has to grow for the page's one
 * scroll surface to reach it.
 *
 * Not claimed here: native alignment (native keeps the flow layout; its
 * onTextLayout measurement is a follow-up) and body-to-margin scroll sync or
 * tap-to-scroll, which belong to #2893.
 */

/** Bounding boxes are sub-pixel; a pixel either way is layout rounding. */
const LAYOUT_SLACK_PX = 1;
const WIDE_VIEWPORT = { width: 1280, height: 800 };
/** Below NARROW_BREAKPOINT (600): the margin stacks under the writing. */
const NARROW_VIEWPORT = { width: 390, height: 844 };
const FILLER_PARAGRAPHS = 14;

const FIRST_PASSAGE = 'The heron stood still in the shallows.';
const SECOND_PASSAGE = 'I watched it until the light went.';
const FILLER = Array.from(
  { length: FILLER_PARAGRAPHS },
  (_, index) =>
    `Morning ${String(index + 1)} began with the kettle and the long walk down to the water, ` +
    'past the fence line and the reeds where the wind comes off the river in the cold.',
).join('\n\n');
const FIRST_BODY = `${FILLER}\n\n${FIRST_PASSAGE}`;
const SECOND_BODY = `${FIRST_BODY} ${SECOND_PASSAGE}`;

interface Note {
  id: number;
  anchor_text: string;
}

async function resonate(request: APIRequestContext, token: string, id: number): Promise<Note[]> {
  const response = await request.post(`${backendUrl()}/journal/${String(id)}/resonance`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { marginalia: Note[] }).marginalia;
}

async function patchEntry(
  request: APIRequestContext,
  token: string,
  id: number,
  data: Record<string, string>,
): Promise<void> {
  const response = await request.patch(`${backendUrl()}/journal/${String(id)}`, {
    headers: bearer(token),
    data,
  });
  expect(response.ok()).toBe(true);
}

/**
 * Write the long page, take one pass, append a sentence, take another, finish.
 * Returns the two notes' ids in document order.
 */
async function seedTwoCloseNotes(page: Page, token: string): Promise<[number, number, number]> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The heron', message: FIRST_BODY },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const [first] = await resonate(page.request, token, entryId);
  await patchEntry(page.request, token, entryId, { message: SECOND_BODY });
  const [second] = await resonate(page.request, token, entryId);
  await patchEntry(page.request, token, entryId, { status: 'finished' });
  expect(first?.anchor_text).toBe(FIRST_PASSAGE);
  expect(second?.anchor_text).toBe(SECOND_PASSAGE);
  return [entryId, first?.id ?? 0, second?.id ?? 0];
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

interface Geometry {
  /** The margin's own gap, read off the column it pads (journalLayout.marginNoteGap). */
  gap: number;
  streamTop: number;
  anchors: number[];
  slots: { top: number; height: number; position: string }[];
}

/** Read the passages, the slots and the stream off laid-out DOM, in viewport px. */
async function geometry(page: Page, ids: readonly number[]): Promise<Geometry> {
  return page.evaluate((noteIds) => {
    const byTestId = (id: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (element === null) throw new Error(`no element ${id}`);
      return element;
    };
    const column = byTestId('journal-margin-column');
    return {
      gap: Number.parseFloat(getComputedStyle(column).paddingLeft),
      streamTop: byTestId('journal-margin-stream').getBoundingClientRect().top,
      anchors: noteIds.map((id) => byTestId(`highlight-${String(id)}`).getBoundingClientRect().top),
      slots: noteIds.map((id) => {
        const slot = byTestId(`margin-slot-note-${String(id)}`);
        const rect = slot.getBoundingClientRect();
        return { top: rect.top, height: rect.height, position: getComputedStyle(slot).position };
      }),
    };
  }, ids);
}

test('margin notes sit beside their passages, apart, and within reach', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  const email = await signUp(page, 'journal-margin-alignment');
  const token = await tokenFor(page.request, email);
  const [entryId, firstId, secondId] = await seedTwoCloseNotes(page, token);
  const ids = [firstId, secondId];

  await openEntry(page, entryId);
  await expect(page.getByTestId(`margin-slot-note-${String(secondId)}`)).toHaveCSS(
    'position',
    'absolute',
  );

  const measured = await geometry(page, ids);
  const [first, second] = measured.slots;
  const [firstAnchor, secondAnchor] = measured.anchors;
  if (!first || !second || firstAnchor === undefined || secondAnchor === undefined) {
    throw new Error('both notes must be measured');
  }
  const expected = computeMarginSlots(
    measured.anchors.map((top) => top - measured.streamTop),
    measured.slots.map((slot) => slot.height),
    measured.gap,
  );

  // Each note lands where the solver puts it for its measured passage.
  measured.slots.forEach((slot, index) => {
    expect(
      Math.abs(slot.top - measured.streamTop - (expected[index] ?? Number.NaN)),
    ).toBeLessThanOrEqual(LAYOUT_SLACK_PX);
  });
  // The first note sits beside its passage, far down -- not at the column top.
  expect(Math.abs(first.top - firstAnchor)).toBeLessThanOrEqual(LAYOUT_SLACK_PX);
  expect(first.top - measured.streamTop).toBeGreaterThan(WIDE_VIEWPORT.height);
  // The passages are closer than a note is tall, so the second is pushed down:
  // in document order, clear of the first by at least the margin gap.
  expect(secondAnchor - firstAnchor).toBeLessThan(first.height);
  expect(second.top).toBeGreaterThanOrEqual(
    first.top + first.height + measured.gap - LAYOUT_SLACK_PX,
  );

  // The column itself grows to hold the lowest note, so its rule and paper run
  // beside every note rather than stopping where the writing does.
  const columnBottom = await page
    .getByTestId('journal-margin-column')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  expect(columnBottom).toBeGreaterThanOrEqual(second.top + second.height - LAYOUT_SLACK_PX);

  // Reachability: at the end of the page's one scroll surface, the last note is
  // wholly on screen.
  await page.getByTestId('journal-page-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = await page.getByTestId(`margin-slot-note-${String(secondId)}`).boundingBox();
  if (last === null) throw new Error('the last note has no box');
  expect(last.y).toBeGreaterThanOrEqual(0);
  expect(last.y + last.height).toBeLessThanOrEqual(WIDE_VIEWPORT.height + LAYOUT_SLACK_PX);

  // Narrow: the margin stacks under the writing and keeps its document-order flow.
  await page.setViewportSize(NARROW_VIEWPORT);
  await expect(page.getByTestId('journal-margin-column')).toHaveCSS('border-left-width', '0px');
  for (const id of ids) {
    await expect(page.getByTestId(`margin-slot-note-${String(id)}`)).not.toHaveCSS(
      'position',
      'absolute',
    );
  }
  const narrow = await geometry(page, ids);
  const [narrowFirst, narrowSecond] = narrow.slots;
  if (!narrowFirst || !narrowSecond) throw new Error('both notes must be measured');
  expect(narrowSecond.top).toBeGreaterThanOrEqual(narrowFirst.top + narrowFirst.height);
});

/** The refused check-off: every accept failure reaches the same margin banner. */
const ACCEPT_ROUTE = '**/journal/suggestions/*/accept';
const HABIT = 'Evening swim';
const HABIT_PASSAGE = `I completed ${HABIT}.`;

/**
 * Something appearing ABOVE the notes -- here the margin's error banner after a
 * refused check-off -- moves the stream down without resizing the stream or
 * the page. The notes must follow their passages, not the stream: a note whose
 * passage now lies above the stream's top sits at that top, clear of the
 * banner, instead of hanging under it or over it.
 */
/**
 * A one-note page whose passage is its first line, taller than the margin: the
 * stub quotes the last sentence, so the note anchors on the habit line while it
 * is the whole page, and the filler is appended after. Returns the entry and
 * note ids.
 */
async function seedNoteAtTop(page: Page, token: string): Promise<[number, number]> {
  await seedHabit(page.request, token, HABIT);
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The swim', message: HABIT_PASSAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const [note] = await resonate(page.request, token, entryId);
  expect(note?.anchor_text).toBe(HABIT_PASSAGE);
  await patchEntry(page.request, token, entryId, { message: `${HABIT_PASSAGE}\n\n${FILLER}` });
  await patchEntry(page.request, token, entryId, { status: 'finished' });
  return [entryId, note?.id ?? 0];
}

/** The one note's passage top, slot top and stream top, in viewport px. */
async function loneNote(
  page: Page,
  noteId: number,
): Promise<{ anchor: number; slot: number; stream: number }> {
  const measured = await geometry(page, [noteId]);
  const [anchor] = measured.anchors;
  const [slot] = measured.slots;
  if (anchor === undefined || slot === undefined) throw new Error('the note must be measured');
  return { anchor, slot: slot.top, stream: measured.streamTop };
}

test('a banner above the margin notes leaves each note beside its passage', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  const email = await signUp(page, 'journal-margin-banner');
  const token = await tokenFor(page.request, email);
  const [entryId, noteId] = await seedNoteAtTop(page, token);
  await page.route(ACCEPT_ROUTE, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'boom' }),
    });
  });

  await openEntry(page, entryId);
  await expect(page.getByTestId(`margin-slot-note-${String(noteId)}`)).toHaveCSS(
    'position',
    'absolute',
  );
  const before = await loneNote(page, noteId);
  expect(Math.abs(before.slot - before.anchor)).toBeLessThanOrEqual(LAYOUT_SLACK_PX);

  await page.getByRole('button', { name: `Check off completed ${HABIT}`, exact: true }).click();
  const banner = page.getByTestId('journal-resonance-error');
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  if (bannerBox === null) throw new Error('the banner has no box');

  // The note settles where its passage and the moved stream say.
  await expect
    .poll(async () => {
      const now = await loneNote(page, noteId);
      return Math.abs(now.slot - Math.max(now.anchor, now.stream));
    })
    .toBeLessThanOrEqual(LAYOUT_SLACK_PX);
  const after = await loneNote(page, noteId);
  // The banner pushed the stream past the passage: the case the note must be
  // held at the stream's top for, rather than lifted over the banner.
  expect(after.anchor).toBeLessThan(after.stream);
  expect(after.slot).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height - LAYOUT_SLACK_PX);
});
