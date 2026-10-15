import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { openHabits, seedHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';

const CHOICES = ['Select today', 'Select next Monday', 'Select first of next month'] as const;

/** Double the rendered shortcut type, leaving the viewport and controls at their real size. */
async function enlargeShortcuts(page: Page): Promise<void> {
  for (const name of CHOICES) {
    await page.getByRole('button', { name, exact: true }).evaluate((button) => {
      const label = button.firstElementChild as HTMLElement;
      const style = getComputedStyle(label);
      const font = Number.parseFloat(style.fontSize);
      const line = Number.parseFloat(style.lineHeight);
      label.style.fontSize = `${font * 2}px`;
      label.style.lineHeight = `${line * 2}px`;
    });
  }
}

/** Check glyphs, independent targets and viewport bounds, including disabled choices. */
async function assertShortcuts(page: Page): Promise<void> {
  await page.getByRole('button', { name: CHOICES[0], exact: true }).scrollIntoViewIfNeeded();
  const boxes = await page.evaluate(
    (names) =>
      names.map((name) => {
        const node = document.querySelector(`[role="button"][aria-label="${name}"]`)!;
        const box = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node.firstElementChild!);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          viewport: innerWidth,
          containerLeft: node.parentElement!.getBoundingClientRect().left,
          containerRight: node.parentElement!.getBoundingClientRect().right,
          glyphs: Array.from(range.getClientRects()).map((r) => ({
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          })),
        };
      }),
    CHOICES,
  );
  for (const geometry of boxes) {
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.containerLeft - 0.1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.containerRight + 0.1);
    for (const glyph of geometry.glyphs) {
      expect(glyph.left).toBeGreaterThanOrEqual(geometry.left - 0.1);
      expect(glyph.right).toBeLessThanOrEqual(geometry.right + 0.1);
      expect(glyph.top).toBeGreaterThanOrEqual(geometry.top - 0.1);
      expect(glyph.bottom).toBeLessThanOrEqual(geometry.bottom + 0.1);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
  for (let i = 0; i < boxes.length; i += 1) {
    for (const other of boxes.slice(i + 1)) {
      const box = boxes[i]!;
      expect(
        box.right <= other.left ||
          other.right <= box.left ||
          box.bottom <= other.top ||
          other.bottom <= box.top,
      ).toBe(true);
    }
  }
}

for (const width of [390, 1280]) {
  test(`photograph date shortcuts reflow with doubled text at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await signUp(page, 'date-photo');
    await page.getByRole('button', { name: 'Open Journal menu' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('journal-photograph-entry').click();
    await (await chooser).setFiles(join(__dirname, '..', 'assets', 'cards', 'rws', 'the_sun.png'));
    await expect(page.getByTestId('capture-entry-date')).toBeVisible();
    await assertShortcuts(page);
    await page.screenshot({ path: info.outputPath(`photo-${width}-normal.png`) });
    await enlargeShortcuts(page);
    await assertShortcuts(page);
    await expect(page.getByRole('button', { name: CHOICES[1], exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: CHOICES[2], exact: true })).toBeDisabled();
    const today = page.getByRole('button', { name: CHOICES[0], exact: true });
    await today.focus();
    await expect(today).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await expect
      .poll(() => today.evaluate((node) => Number(getComputedStyle(node).opacity)))
      .toBe(1);
    const last = page.getByRole('button', { name: CHOICES[2], exact: true });
    await last.scrollIntoViewIfNeeded();
    const lastBox = await last.boundingBox();
    expect(lastBox!.y).toBeGreaterThanOrEqual(0);
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: info.outputPath(`photo-${width}-2x.png`) });
  });

  test(`onboarding date shortcuts remain distinct keyboard actions at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'date-onboarding');
    await seedHabit(request, await tokenFor(request, email), 'Date shortcut witness');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
    await openHabits(page);
    await page.getByRole('button', { name: 'Start Energy Scaffolding' }).click();
    await page.getByTestId('review-continue').click();
    await page.getByTestId('continue-button').click();
    await page.getByTestId('count-warning-continue').click();
    await page.getByTestId('continue-button').click();
    await page.getByTestId('continue-button').click();
    await expect(page.getByText('Beige begins on:', { exact: true })).toBeVisible();
    const caption = page.getByText('Beige begins on:', { exact: true });
    const captionBox = await caption.boundingBox();
    expect(captionBox!.x).toBeGreaterThanOrEqual(10);
    expect(captionBox!.x + captionBox!.width).toBeLessThanOrEqual(width - 10);
    await assertShortcuts(page);
    await page.screenshot({ path: info.outputPath(`onboarding-${width}-normal.png`) });
    await enlargeShortcuts(page);
    await assertShortcuts(page);
    const first = page.getByRole('button', { name: CHOICES[0], exact: true });
    await first.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: CHOICES[1], exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: CHOICES[2], exact: true })).toBeFocused();
    const dates = await page.evaluate(() => {
      const today = new Date();
      const monday = new Date(today);
      monday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
      const month = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return [today, monday, month].map(
        (d) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      );
    });
    for (const [index, name] of CHOICES.entries()) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeEnabled();
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press(index === 1 ? 'Space' : 'Enter');
      await expect(page.getByLabel('Date', { exact: true })).toHaveValue(dates[index]!);
    }
    const last = page.getByRole('button', { name: CHOICES[2], exact: true });
    await expect
      .poll(() => last.evaluate((node) => Number(getComputedStyle(node).opacity)))
      .toBe(1);
    await page.screenshot({ path: info.outputPath(`onboarding-${width}-2x.png`) });
  });
}
