import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Live Markdown editing, end to end: keyboard typing and shortcuts in the real
 * <textarea>, the styled mirror over it, the autosave and read routes, and read
 * mode after a cold reload. The stored message must stay byte-identical to what
 * the writer typed -- the mirror is presentation only.
 */

/** Where inside a character the geometry probe clicks: its left quarter, so the caret lands before it. */
const CARET_PROBE_FRACTION = 0.25;
/** The widths the editor is checked at: phone, tablet, laptop, desktop. */
const PROBE_WIDTHS = [390, 768, 1024, 1440] as const;
const PROBE_HEIGHT = 900;
const COLOR_SCHEMES = ['light', 'dark'] as const;

const body = (page: Page): Locator => page.getByTestId('journal-body-input');

async function selection(field: Locator): Promise<[number, number]> {
  return field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    return [area.selectionStart, area.selectionEnd];
  });
}

async function selectRange(field: Locator, start: number, end: number): Promise<void> {
  await field.evaluate(
    (element, [from, to]) => {
      const area = element as HTMLTextAreaElement;
      area.focus();
      area.setSelectionRange(from!, to!);
    },
    [start, end],
  );
}

/** The viewport rect of the mirror character that draws body index ``index``. */
async function mirrorCharRect(
  page: Page,
  index: number,
): Promise<{ left: number; top: number; width: number; height: number }> {
  return page.getByTestId('journal-body-mirror').evaluate((mirror, target) => {
    const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (target < offset + length) {
        const range = document.createRange();
        range.setStart(node, target - offset);
        range.setEnd(node, target - offset + 1);
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
      offset += length;
    }
    throw new Error(`mirror has no character ${target}`);
  }, index);
}

/** Click the mirror's glyph for ``index``: the real textarea must put its caret there. */
async function expectCaretLandsOn(page: Page, index: number): Promise<void> {
  const rect = await mirrorCharRect(page, index);
  expect(rect.width).toBeGreaterThan(0);
  await page.mouse.click(rect.left + rect.width * CARET_PROBE_FRACTION, rect.top + rect.height / 2);
  expect(await selection(body(page))).toEqual([index, index]);
}

test('live Markdown editing keeps the typed source byte-identical and renders it after reload', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const email = await signUp(page, 'journal-live-markdown');
  const token = await tokenFor(page.request, email);
  await page.getByTestId('journal-new-entry').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/journal/',
  );
  await page.getByTestId('journal-title-input').fill('Typed live');

  // The title is not the editor: Cmd/Ctrl+B there is left to the browser.
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => {
      (window as unknown as { lastKeyPrevented: boolean }).lastKeyPrevented =
        event.defaultPrevented;
    });
  });
  await page.getByTestId('journal-title-input').press('ControlOrMeta+b');
  expect(
    await page.evaluate(
      () => (window as unknown as { lastKeyPrevented: boolean }).lastKeyPrevented,
    ),
  ).toBe(false);

  const field = body(page);
  await field.click();
  await page.keyboard.type('Plain words here');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> remembered');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('Plain words here\n> remembered\n> ');
  await page.keyboard.press('Enter');
  await page.keyboard.type('_soft_ and <u>under</u> end');
  const typed = 'Plain words here\n> remembered\n_soft_ and <u>under</u> end';
  await expect(field).toHaveValue(typed);

  // The styling applies as the closing delimiter is typed, with no blur.
  const mirror = page.getByTestId('journal-body-mirror');
  await expect(mirror.getByTestId('journal-live-italic-31')).toHaveText('soft');
  await expect(mirror.getByTestId('journal-live-underline-44')).toHaveText('under');

  // Cmd/Ctrl+B on a selection wraps it; undo and redo go through the browser's own stack.
  await selectRange(field, 6, 11);
  await page.keyboard.press('ControlOrMeta+b');
  const bolded = 'Plain **words** here\n> remembered\n_soft_ and <u>under</u> end';
  await expect(field).toHaveValue(bolded);
  expect(await selection(field)).toEqual([8, 13]);
  await expect(mirror.getByTestId('journal-live-bold-8')).toHaveText('words');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).toHaveValue(typed);
  expect(await selection(field)).toEqual([6, 11]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue(bolded);

  // Pasted Markdown is stored verbatim and styled.
  await field.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.setSelectionRange(area.value.length, area.value.length);
  });
  await page.evaluate(() => navigator.clipboard.writeText('\nPasted *bold* line'));
  await page.keyboard.press('ControlOrMeta+v');
  const message = `${bolded}\nPasted *bold* line`;
  await expect(field).toHaveValue(message);

  const entryId = ((await (await created).json()) as { id: number }).id;
  await page.getByTestId('journal-finish-button').click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
  await expect
    .poll(async () => {
      const stored = await page.request.get(`${backendUrl()}/journal/${entryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await stored.json()) as { message: string }).message;
    })
    .toBe(message);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  const read = page.getByTestId('journal-body-read');
  await expect(read.locator('strong')).toHaveText(['words', 'bold']);
  await expect(read.locator('em')).toHaveText('soft');
  await expect(read.locator('blockquote')).toHaveText('remembered');
  const underline = read.locator('[data-testid^="journal-markdown-underline-"]');
  await expect(underline).toHaveText('under');
  expect(await underline.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
    'underline',
  );
  await expect(read).not.toContainText('<u>');
});

test('the live mirror stays in register with the real textarea at every width and theme', async ({
  page,
}) => {
  await signUp(page, 'journal-live-geometry');
  const wrapped = 'a long line that has to wrap across the writing column '.repeat(10);
  const filler = Array.from({ length: 30 }, (_, line) => `filler line ${line}`).join('\n');
  const text = `Open **bold words** and _soft italics_ and <u>under words</u>.\n${wrapped}\n> a quote\n- item\n  - nested\n${filler}\nTail **bold** end`;
  const probes = [
    text.indexOf('bold words') + 2,
    text.indexOf('soft italics') + 1,
    text.indexOf('under words') + 3,
    text.indexOf('a quote'),
    text.indexOf('nested') + 2,
    // Well into the wrapped line, several visual lines down.
    text.indexOf(wrapped) + Math.floor(wrapped.length * 0.8),
  ];
  const afterScroll = text.lastIndexOf('bold') + 1;

  for (const colorScheme of COLOR_SCHEMES) {
    for (const width of PROBE_WIDTHS) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: PROBE_HEIGHT });
      await page.reload();
      await page.getByTestId('journal-new-entry').click();
      await body(page).fill(text);
      await expect(page.getByTestId('journal-body-mirror')).toContainText('Tail');

      for (const index of probes) await expectCaretLandsOn(page, index);

      // Hidden delimiters keep their advance: dimmed, never collapsed.
      const delimiterWidth = await page
        .getByTestId('journal-body-mirror')
        .getByTestId('journal-live-delimiter-5')
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(delimiterWidth).toBeGreaterThan(0);

      // Mid-document scroll: the page moves, the two layers move together.
      await page.mouse.wheel(0, PROBE_HEIGHT);
      const scrolledTo = await page
        .getByTestId('journal-body-mirror')
        .evaluate((mirror, target) => {
          const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
          let offset = 0;
          let host: Element | null = null;
          for (
            let node = walker.nextNode();
            node != null && host == null;
            node = walker.nextNode()
          ) {
            const length = node.textContent?.length ?? 0;
            if (target < offset + length) host = node.parentElement;
            offset += length;
          }
          host?.scrollIntoView({ block: 'center' });
          return host != null;
        }, afterScroll);
      expect(scrolledTo).toBe(true);
      await expectCaretLandsOn(page, afterScroll);
    }
  }
});
