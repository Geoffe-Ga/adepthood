import { expect, test, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

test('journal Markdown renders after finish and a cold reload while its source stays unchanged', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-markdown');
  const token = await tokenFor(page.request, email);
  const body =
    '*Bold truth* beside _quiet emphasis_.\n> First remembered line\n> _Second remembered line_';
  await page.getByTestId('journal-new-entry').click();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Formatted page');
  await page.getByTestId('journal-body-input').fill(body);
  const [created] = await Promise.all([
    createResponse,
    page.getByTestId('journal-finish-button').click(),
  ]);
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;

  const readBody = page.getByTestId('journal-body-read');
  await expect(readBody).not.toHaveAttribute('tabindex', '0');
  expect(await readBody.evaluate((element) => getComputedStyle(element).cursor)).not.toBe(
    'pointer',
  );
  await expect(readBody.locator('strong')).toHaveText('Bold truth');
  await expect(readBody.locator('em')).toHaveText(['quiet emphasis', 'Second remembered line']);
  await expect(readBody.locator('blockquote')).toHaveText(
    'First remembered line\nSecond remembered line',
  );
  await expect(readBody).not.toContainText('*Bold truth*');
  await expect(readBody).not.toContainText('> First remembered line');

  const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(stored.ok()).toBe(true);
  expect((await stored.json()) as { message: string }).toEqual(
    expect.objectContaining({ message: body }),
  );

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  const reloadedBody = page.getByTestId('journal-body-read');
  await expect(reloadedBody.locator('strong')).toHaveText('Bold truth');
  await expect(reloadedBody.locator('em')).toHaveCount(2);
  await expect(reloadedBody.locator('blockquote')).toContainText('Second remembered line');
});

test('journal headings, numbered items, tasks and rules render after a cold reload while the source stays unchanged (#3251)', async ({
  page,
}) => {
  const email = await signUp(page, 'journal-markdown-blocks');
  const token = await tokenFor(page.request, email);
  const body =
    '## Tuesday\n1. walked\n10) wrote\n- [x] called Sam\n- [ ] book the room\n---\nafter the rule';
  await page.getByTestId('journal-new-entry').click();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Structured page');
  await page.getByTestId('journal-body-input').fill(body);
  const [created] = await Promise.all([
    createResponse,
    page.getByTestId('journal-finish-button').click(),
  ]);
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;

  const expectBlocks = async (): Promise<void> => {
    const read = page.getByTestId('journal-body-read');
    await expect(read.locator('h2')).toHaveText('Tuesday');
    await expect(read.locator('[data-testid^="journal-markdown-ordinal-"]')).toHaveText([
      '1. ',
      '10) ',
    ]);
    await expect(read.locator('[data-testid^="journal-markdown-checkbox-"]')).toHaveText([
      '\u2611 ',
      '\u2610 ',
    ]);
    await expect(read.getByTestId('journal-markdown-task-done-31')).toHaveText('called Sam');
    await expect(read.locator('[data-testid^="journal-markdown-rule-"]')).toHaveCount(1);
    await expect(read).toContainText('after the rule');
    for (const raw of ['## ', '[x]', '[ ]', '---']) {
      await expect(read).not.toContainText(raw);
    }
  };
  await expectBlocks();

  const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(stored.ok()).toBe(true);
  expect((await stored.json()) as { message: string }).toEqual(
    expect.objectContaining({ message: body }),
  );

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await expectBlocks();
});

/**
 * Hanging indent in read mode (#3252): a list item that wraps keeps every later
 * visual line on the left edge of its first line's text, never back under the
 * marker -- for bullets, numbers and checkboxes, at three nesting levels.
 *
 * Edges are read off laid-out DOM and compared for equality, not closeness: a
 * Range over an item's text yields one rectangle per visual line.
 */
const HANG_TAIL =
  'runs on well past the edge of a narrow page so that it has to wrap onto another line, and then another after that';
const HANG_LINES = [
  `- A bullet that ${HANG_TAIL}`,
  `  - A nested bullet that ${HANG_TAIL}`,
  `    - A doubly nested bullet that ${HANG_TAIL}`,
  `9. The ninth item ${HANG_TAIL}`,
  `10. The tenth item ${HANG_TAIL}`,
  `  1. A nested number that ${HANG_TAIL}`,
  `    1. A doubly nested number that ${HANG_TAIL}`,
  `- [ ] An open task that ${HANG_TAIL}`,
  `  - [x] A nested done task that ${HANG_TAIL}`,
  `    - [ ] A doubly nested task that ${HANG_TAIL}`,
];
const HANG_BODY = HANG_LINES.join('\n');
/** Each line's code-point start in HANG_BODY (ASCII, so its string index). */
const HANG_STARTS = HANG_LINES.map((_, index) =>
  HANG_LINES.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0),
);
const HANG_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
] as const;

interface ItemEdges {
  /** The left edge of each visual line of the item's text, top to bottom. */
  lineLefts: number[];
  /** The text cell's own left edge. */
  cellLeft: number;
  /** The right edge of the row's visible marker. */
  markerRight: number;
  markerLeft: number;
}

/** Measure one list row: its marker and every visual line of its text. */
async function itemEdges(page: Page, start: number): Promise<ItemEdges> {
  return page.getByTestId('journal-body-read').evaluate((read, lineStart) => {
    const find = (id: string): HTMLElement => {
      const element = read.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (element === null) throw new Error(`no element ${id}`);
      return element;
    };
    const cell = find(`journal-markdown-item-text-${String(lineStart)}`);
    const marker = find(`journal-markdown-item-${String(lineStart)}`).querySelector<HTMLElement>(
      '[data-testid^="journal-markdown-marker-"], [data-testid^="journal-markdown-ordinal-"], [data-testid^="journal-markdown-checkbox-"]',
    );
    if (marker === null) throw new Error(`no marker in row ${String(lineStart)}`);
    const range = document.createRange();
    range.selectNodeContents(cell);
    const lefts = new Map<number, number>();
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      const top = Math.round(rect.top);
      lefts.set(top, Math.min(lefts.get(top) ?? Number.POSITIVE_INFINITY, rect.left));
    }
    // The marker's ink box: a pressable glyph's padded reach is not its edge.
    const ink = document.createRange();
    ink.selectNodeContents(marker);
    const inkRect = ink.getBoundingClientRect();
    return {
      lineLefts: [...lefts.entries()].sort(([a], [b]) => a - b).map(([, left]) => left),
      cellLeft: cell.getBoundingClientRect().left,
      markerRight: inkRect.right,
      markerLeft: inkRect.left,
    };
  }, start);
}

async function seedFinishedEntry(page: Page, token: string, message: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'Hanging lists', message },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  return entryId;
}

async function openFinishedEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

for (const viewport of HANG_VIEWPORTS) {
  const label = `${String(viewport.width)}x${String(viewport.height)}`;
  test(`a wrapped bullet, number and task hang under their own text at ${label} (#3252)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const email = await signUp(page, `journal-hanging-indent-${label}`);
    const token = await tokenFor(page.request, email);
    const entryId = await seedFinishedEntry(page, token, HANG_BODY);
    await openFinishedEntry(page, entryId);

    const edges: ItemEdges[] = [];
    for (const start of HANG_STARTS) edges.push(await itemEdges(page, start));

    edges.forEach((item, index) => {
      const line = HANG_LINES[index];
      // The item really wrapped, or there is nothing to hang.
      expect(item.lineLefts.length, `${String(line)} wraps`).toBeGreaterThanOrEqual(2);
      // Every later visual line starts exactly where the first line's text does.
      for (const left of item.lineLefts) expect(left, String(line)).toBe(item.lineLefts[0]);
      expect(item.lineLefts[0], String(line)).toBe(item.cellLeft);
      // ... which is past the marker, not under it.
      expect(item.markerRight, String(line)).toBeLessThanOrEqual(item.cellLeft);
      expect(item.markerLeft, String(line)).toBeLessThan(item.markerRight);
    });

    const textLeft = (index: number): number => edges[index]!.lineLefts[0]!;
    // Nesting is preserved: each level's text column sits right of its parent's.
    for (const top of [0, 4, 7]) {
      expect(textLeft(top + 1)).toBeGreaterThan(textLeft(top));
      expect(textLeft(top + 2)).toBeGreaterThan(textLeft(top + 1));
    }
    // "9." and "10." share one text column, and their delimiters one right edge.
    expect(textLeft(3)).toBe(textLeft(4));
    expect(edges[3]!.markerRight).toBe(edges[4]!.markerRight);
    expect(edges[3]!.markerLeft).toBeGreaterThan(edges[4]!.markerLeft);

    await expect(page.getByTestId('journal-body-read')).not.toContainText('- A bullet');
    const stored = await page.request.get(`${backendUrl()}/journal/${String(entryId)}`, {
      headers: bearer(token),
    });
    expect((await stored.json()) as { message: string }).toEqual(
      expect.objectContaining({ message: HANG_BODY }),
    );
  });
}

test("a note anchored on a wrapped list item's second line is drawn there, with its margin note beside it (#3252)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const email = await signUp(page, 'journal-hanging-indent-anchor');
  const token = await tokenFor(page.request, email);
  // The stub provider quotes the page's last sentence, which here begins well
  // into a bullet long enough to wrap: the passage starts on a later line.
  const passage = 'The heron stood still in the shallows.';
  const body = `- one short item\n- I walked the whole length of the river path this morning before anyone else was awake and the light was only just coming over the far bank when I reached the bend. ${passage}`;
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The heron', message: body },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const resonance = await page.request.post(
    `${backendUrl()}/journal/${String(entryId)}/resonance`,
    { headers: bearer(token) },
  );
  expect(resonance.ok()).toBe(true);
  const [note] = ((await resonance.json()) as { marginalia: { id: number; anchor_text: string }[] })
    .marginalia;
  expect(note?.anchor_text).toBe(passage);
  const noteId = note?.id ?? 0;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);

  await openFinishedEntry(page, entryId);
  const slot = page.getByTestId(`margin-slot-note-${String(noteId)}`);
  await expect(slot).toHaveCSS('position', 'absolute');
  const highlight = page.getByTestId(`highlight-${String(noteId)}`);
  await expect(highlight).toHaveText(passage);

  const item = await itemEdges(page, body.indexOf('- I walked'));
  expect(item.lineLefts.length).toBeGreaterThanOrEqual(2);
  const measured = await highlight.evaluate((run) => {
    const cell = run.closest('[data-testid^="journal-markdown-item-text-"]');
    const first = run.getClientRects()[0];
    if (cell === null || first === undefined) throw new Error('the highlight is in a text cell');
    return { top: first.top, left: first.left, cellTop: cell.getBoundingClientRect().top };
  });
  // The passage starts below the item's first visual line, inside its text column.
  expect(measured.top).toBeGreaterThan(measured.cellTop + 1);
  expect(measured.left).toBeGreaterThanOrEqual(item.cellLeft);
  // And the margin note is placed against that measured run, not the block top.
  const [slotBox, runBox] = [await slot.boundingBox(), await highlight.boundingBox()];
  expect(Math.abs((slotBox?.y ?? Number.NaN) - (runBox?.y ?? Number.NaN))).toBeLessThanOrEqual(1);
});
