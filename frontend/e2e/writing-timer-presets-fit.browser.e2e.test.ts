import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/**
 * Every idle writing-timer preset is on screen and in reach (#3403).
 *
 * The idle timer floats in a band over the lower half of the page (#3131,
 * #3205). On a short phone page, such as 200% browser zoom on a 390px phone,
 * the presets wrap to a second row. That row has to stay inside the band's
 * visible area: a preset the writer can only find by scrolling a band they
 * cannot see is scrollable is a preset they never meet. These specs hold
 * every preset's box, and the unit after them, inside the band and the
 * viewport with the band unscrolled, then choose a length by tap and by
 * keyboard.
 */

const PRESETS = ['10', '20', '30', '45'] as const;
const PRESET_IDS = [
  ...PRESETS.map((minutes) => `writing-timer-preset-${minutes}`),
  'writing-timer-preset-unit',
];
const LAPTOP = { width: 1280, height: 720 } as const;
const PHONE = { width: 390, height: 844 } as const;
/** 200% browser zoom on a 390px phone: the web's own enlarged-text path. */
const PHONE_AT_200 = { width: 195, height: 422 } as const;
/** How much larger the "doubled text" pass sets the timer's type. */
const TEXT_SCALE = 2;
/** The touch-target floor the presets keep, in CSS px. */
const TOUCH_MINIMUM = 44;
/** Sub-pixel rounding allowance between a box and the edge that holds it. */
const EDGE_TOLERANCE = 1;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PresetLayout {
  /** The band's visible area: its scroll viewport, as the writer sees it. */
  visible: Rect;
  viewport: Rect;
  bandScrollTop: number;
  controls: { id: string; box: Rect; hit: boolean }[];
}

/** Read the presets against the band's visible area after layout settles. */
async function readPresetLayout(page: Page): Promise<PresetLayout> {
  return page.evaluate(async (ids) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const rect = (node: Element): Rect => {
      const { left, right, top, bottom } = node.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const content = document.querySelector('[data-testid="writing-session-band-content"]');
    if (content === null) throw new Error('the writing-session band is not on the page');
    const controls = ids.map((id) => {
      const node = document.querySelector(`[data-testid="${id}"]`);
      if (node === null) throw new Error(`${id} is not on the page`);
      const box = rect(node);
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { id, box, hit: hit !== null && (hit === node || node.contains(hit)) };
    });
    return {
      visible: rect(content),
      viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
      bandScrollTop: content.scrollTop,
      controls,
    };
  }, PRESET_IDS);
}

/** Every preset, and the unit after them, is whole inside the band and the viewport. */
async function expectPresetsInView(page: Page, label: string): Promise<void> {
  const layout = await readPresetLayout(page);
  expect(layout.bandScrollTop, `${label}: the band is read unscrolled`).toBe(0);
  for (const { id, box, hit } of layout.controls) {
    for (const [edge, holder] of [
      ['band', layout.visible],
      ['viewport', layout.viewport],
    ] as const) {
      const where = `${label}: ${id} inside the ${edge}`;
      expect(box.left, where).toBeGreaterThanOrEqual(holder.left - EDGE_TOLERANCE);
      expect(box.right, where).toBeLessThanOrEqual(holder.right + EDGE_TOLERANCE);
      expect(box.top, where).toBeGreaterThanOrEqual(holder.top - EDGE_TOLERANCE);
      expect(box.bottom, where).toBeLessThanOrEqual(holder.bottom + EDGE_TOLERANCE);
    }
    expect(hit, `${label}: nothing covers ${id}`).toBe(true);
    if (id === 'writing-timer-preset-unit') continue;
    // Fitting by shrinking the targets is not a fix.
    expect(box.right - box.left, `${label}: ${id} keeps its width`).toBeGreaterThanOrEqual(
      TOUCH_MINIMUM - EDGE_TOLERANCE,
    );
    expect(box.bottom - box.top, `${label}: ${id} keeps its height`).toBeGreaterThanOrEqual(
      TOUCH_MINIMUM - EDGE_TOLERANCE,
    );
  }
}

/** Tap a preset where it is drawn, without letting the browser scroll it into view. */
async function tapPreset(page: Page, minutes: string): Promise<void> {
  const box = await page.getByTestId(`writing-timer-preset-${minutes}`).boundingBox();
  if (box === null) throw new Error(`preset ${minutes} has no laid-out box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('writing-timer-readout')).toHaveText(`${minutes}:00`);
}

/** Walk the presets by keyboard, each one in view as it takes focus, and choose the last. */
async function choosePresetsByKeyboard(page: Page, label: string): Promise<void> {
  await page.getByTestId(`writing-timer-preset-${PRESETS[0]}`).focus();
  for (const [index, minutes] of PRESETS.entries()) {
    if (index > 0) await page.keyboard.press('Tab');
    await expect(page.getByTestId(`writing-timer-preset-${minutes}`)).toBeFocused();
    await expectPresetsInView(page, `${label}, ${minutes} focused`);
  }
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('writing-timer-readout')).toHaveText(
    `${PRESETS[PRESETS.length - 1]}:00`,
  );
}

/** Double every text face in the idle timer, as enlarged text would set it. */
async function doubleTimerText(page: Page): Promise<void> {
  await page.getByTestId('writing-timer-pill').evaluate((pill, scale) => {
    for (const text of pill.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      const style = getComputedStyle(text);
      text.style.fontSize = `${parseFloat(style.fontSize) * scale}px`;
      text.style.lineHeight = `${parseFloat(style.lineHeight) * scale}px`;
    }
  }, TEXT_SCALE);
}

async function openWritingPage(page: Page, prefix: string): Promise<void> {
  await signUp(page, prefix);
  await page.getByTestId('journal-new-entry').click();
  await expect(page.getByTestId('writing-timer-preset-45')).toBeAttached();
}

test('every idle preset is in view and in reach at 1280px, at 390px, and with doubled text at 390px', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(LAPTOP);
  await openWritingPage(page, 'writing-timer-presets');
  await expectPresetsInView(page, '1280');
  await page.screenshot({ path: testInfo.outputPath('presets-1280.png') });

  await page.setViewportSize(PHONE);
  await expectPresetsInView(page, '390');
  await page.screenshot({ path: testInfo.outputPath('presets-390.png') });

  await doubleTimerText(page);
  await expectPresetsInView(page, '390 doubled');
  await page.screenshot({ path: testInfo.outputPath('presets-390-doubled.png') });
  await tapPreset(page, '30');
  await choosePresetsByKeyboard(page, '390 doubled');
});

test('every idle preset is in view and in reach at 200% browser zoom on a phone', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: PHONE_AT_200, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await openWritingPage(page, 'writing-timer-presets-zoom');
    await expectPresetsInView(page, '200%');
    await page.screenshot({ path: testInfo.outputPath('presets-zoom-200.png') });
    await tapPreset(page, '30');
    await choosePresetsByKeyboard(page, '200%');
    // Photograph the chosen preset once its press feedback has settled.
    await expect(page.getByTestId('writing-timer-preset-45')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('presets-zoom-200-chosen.png') });
  } finally {
    await context.close();
  }
});
