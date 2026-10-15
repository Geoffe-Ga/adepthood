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
/** WCAG 2.1 AA contrast for a preset's label against what it is drawn on. */
const AA_CONTRAST = 4.5;

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

/** How one preset reads once its press and focus feedback has settled. */
interface PresetInk {
  minutes: string;
  /** The opacity the label is drawn at, compounded through every ancestor. */
  opacity: number;
  /** The label's contrast against the preset's fill, or the pill's where it has none. */
  contrast: number;
  /** Whether the preset paints a fill of its own. */
  filled: boolean;
}

/** Read the pill's surface and every preset's label contrast. */
async function readPresetInk(page: Page): Promise<{ pillAlpha: number; presets: PresetInk[] }> {
  return page.evaluate((presets) => {
    interface Rgba {
      r: number;
      g: number;
      b: number;
      a: number;
    }
    const channels = (color: string): Rgba => {
      const parts = (/rgba?\(([^)]+)\)/.exec(color)?.[1] ?? '')
        .split(',')
        .map((part) => parseFloat(part));
      const [r, g, b, a = 1] = parts;
      if (r === undefined || g === undefined || b === undefined) {
        throw new Error(`unreadable colour ${color}`);
      }
      return { r, g, b, a };
    };
    const linear = (channel: number): number => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }: Rgba): number =>
      0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const ratio = (one: Rgba, other: Rgba): number => {
      const light = Math.max(luminance(one), luminance(other));
      const dark = Math.min(luminance(one), luminance(other));
      return (light + 0.05) / (dark + 0.05);
    };
    const pill = document.querySelector('[data-testid="writing-timer-pill"]');
    if (pill === null) throw new Error('the timer pill is not on the page');
    const pillFill = channels(getComputedStyle(pill).backgroundColor);
    return {
      pillAlpha: pillFill.a,
      presets: presets.map((minutes) => {
        const button = document.querySelector(`[data-testid="writing-timer-preset-${minutes}"]`);
        const label = button?.querySelector('[dir="auto"]');
        if (!(button instanceof HTMLElement) || !(label instanceof HTMLElement)) {
          throw new Error(`preset ${minutes} has no label`);
        }
        let opacity = 1;
        for (let node: Element | null = label; node !== null; node = node.parentElement) {
          opacity *= parseFloat(getComputedStyle(node).opacity);
        }
        const fill = channels(getComputedStyle(button).backgroundColor);
        const filled = fill.a > 0;
        return {
          minutes,
          opacity,
          contrast: ratio(channels(getComputedStyle(label).color), filled ? fill : pillFill),
          filled,
        };
      }),
    };
  }, PRESETS);
}

/**
 * The pill is opaque, so no page text reads through it, and every preset's
 * label meets AA on what it is drawn on once feedback has settled. The chosen
 * preset is the one filled preset, so it reads as chosen at every size.
 */
async function expectPresetsReadable(page: Page, label: string, chosen: string): Promise<void> {
  await expect
    .poll(async () => (await readPresetInk(page)).presets.every((ink) => ink.opacity === 1), {
      message: `${label}: preset feedback settles to full opacity`,
    })
    .toBe(true);
  const ink = await readPresetInk(page);
  expect(ink.pillAlpha, `${label}: the timer pill is opaque over the page`).toBe(1);
  for (const preset of ink.presets) {
    expect(
      preset.contrast,
      `${label}: preset ${preset.minutes} label meets AA`,
    ).toBeGreaterThanOrEqual(AA_CONTRAST);
    expect(preset.filled, `${label}: only the chosen preset is filled`).toBe(
      preset.minutes === chosen,
    );
  }
}

/** The unit sits on the preset row, after the last preset and centred on it. */
async function expectUnitOnPresetRow(page: Page, label: string): Promise<void> {
  const last = await page
    .getByTestId(`writing-timer-preset-${PRESETS[PRESETS.length - 1]}`)
    .boundingBox();
  const unit = await page.getByTestId('writing-timer-preset-unit').boundingBox();
  if (last === null || unit === null) throw new Error(`${label}: the preset row is not laid out`);
  expect(unit.x, `${label}: the unit follows the last preset`).toBeGreaterThanOrEqual(
    last.x + last.width,
  );
  expect(
    Math.abs(unit.y + unit.height / 2 - (last.y + last.height / 2)),
    `${label}: the unit is centred on the preset row`,
  ).toBeLessThanOrEqual(EDGE_TOLERANCE);
}

/** A unit that enlarged text pushes onto a line of its own ends at the last preset's edge. */
async function expectWrappedUnitTrailing(page: Page, label: string): Promise<void> {
  const last = await page
    .getByTestId(`writing-timer-preset-${PRESETS[PRESETS.length - 1]}`)
    .boundingBox();
  const unit = await page.getByTestId('writing-timer-preset-unit').boundingBox();
  if (last === null || unit === null) throw new Error(`${label}: the preset row is not laid out`);
  expect(unit.y, `${label}: the unit wrapped below the presets`).toBeGreaterThanOrEqual(
    last.y + last.height,
  );
  expect(
    Math.abs(unit.x + unit.width - (last.x + last.width)),
    `${label}: the wrapped unit ends at the last preset's trailing edge`,
  ).toBeLessThanOrEqual(EDGE_TOLERANCE);
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

/** Set every text face in the idle timer to a multiple of its own size, as enlarged text would. */
async function scaleTimerText(page: Page, scale: number): Promise<void> {
  await page.getByTestId('writing-timer-pill').evaluate((pill, factor) => {
    for (const text of pill.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      const style = getComputedStyle(text);
      text.dataset.baseFontSize ??= style.fontSize;
      text.dataset.baseLineHeight ??= style.lineHeight;
      text.style.fontSize = `${parseFloat(text.dataset.baseFontSize) * factor}px`;
      text.style.lineHeight = `${parseFloat(text.dataset.baseLineHeight) * factor}px`;
    }
  }, scale);
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
  await expectPresetsReadable(page, '1280', '20');
  await expectUnitOnPresetRow(page, '1280');
  await page.screenshot({ path: testInfo.outputPath('presets-1280.png') });
  await scaleTimerText(page, TEXT_SCALE);
  await expectPresetsInView(page, '1280 doubled');
  await expectWrappedUnitTrailing(page, '1280 doubled');
  await page.screenshot({ path: testInfo.outputPath('presets-1280-doubled.png') });
  await scaleTimerText(page, 1);

  await page.setViewportSize(PHONE);
  await expectPresetsInView(page, '390');
  await expectPresetsReadable(page, '390', '20');
  await expectUnitOnPresetRow(page, '390');
  await page.screenshot({ path: testInfo.outputPath('presets-390.png') });

  await scaleTimerText(page, TEXT_SCALE);
  await expectPresetsInView(page, '390 doubled');
  await expectPresetsReadable(page, '390 doubled', '20');
  await page.screenshot({ path: testInfo.outputPath('presets-390-doubled.png') });
  await tapPreset(page, '30');
  await choosePresetsByKeyboard(page, '390 doubled');
  await expectPresetsReadable(page, '390 doubled, 45 chosen', '45');
  await page.screenshot({ path: testInfo.outputPath('presets-390-doubled-chosen.png') });
});

test('every idle preset is in view and in reach at 200% browser zoom on a phone', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: PHONE_AT_200, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await openWritingPage(page, 'writing-timer-presets-zoom');
    await expectPresetsInView(page, '200%');
    await expectPresetsReadable(page, '200%', '20');
    await page.screenshot({ path: testInfo.outputPath('presets-zoom-200.png') });
    await tapPreset(page, '30');
    await choosePresetsByKeyboard(page, '200%');
    // Photograph the chosen preset once its press and focus feedback has settled.
    await expectPresetsReadable(page, '200%, 45 chosen', '45');
    await page.screenshot({ path: testInfo.outputPath('presets-zoom-200-chosen.png') });
  } finally {
    await context.close();
  }
});
