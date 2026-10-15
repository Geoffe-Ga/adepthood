import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, seedTimerHabit, signUp, tokenFor } from './journalHabitsBrowserSupport';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${name} has no laid-out box`);
  return box;
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clippedTo(box: Box, clip: Box): Box {
  const x = Math.max(box.x, clip.x);
  const y = Math.max(box.y, clip.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(box.x + box.width, clip.x + clip.width) - x),
    height: Math.max(0, Math.min(box.y + box.height, clip.y + clip.height) - y),
  };
}

async function openWritingPage(page: Page): Promise<void> {
  await signUp(page, 'writing-timer-layout');
  await page.getByTestId('journal-new-entry').click();
  await page
    .getByTestId('journal-body-input')
    .fill('A line held open while the writing timer waits below the page.');
}

test('the idle timer does not cover the entry body at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWritingPage(page);

  const scroll = page.getByTestId('journal-page-scroll');
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(scroll).toHaveJSProperty('scrollTop', 0);

  const body = await boxOf(page.getByTestId('journal-body-input'), 'journal body');
  const scrollViewport = await boxOf(scroll, 'journal scroll viewport');
  const idleTimer = await boxOf(page.getByTestId('writing-timer-pill'), 'idle timer');
  const visibleBody = clippedTo(body, scrollViewport);

  expect(visibleBody.width, 'the journal body has no visible width').toBeGreaterThan(0);
  expect(visibleBody.height, 'the journal body has no visible height').toBeGreaterThan(0);
  expect(
    overlapArea(visibleBody, idleTimer),
    `the idle timer covers the visible writing field: body=${JSON.stringify(visibleBody)} timer=${JSON.stringify(idleTimer)}`,
  ).toBe(0);

  await page.getByTestId('writing-timer-start').click();
  await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
  const runningPill = await boxOf(page.getByTestId('writing-timer-pill'), 'running timer pill');
  expect(runningPill.width, 'the running timer left its 44dp desktop rail').toBeLessThanOrEqual(44);
  expect(overlapArea(visibleBody, runningPill), 'the running timer covers the writing field').toBe(
    0,
  );
});

for (const height of [720, 390]) {
  test(`live clock stays readable in its 44px rail at 200% text in a 1280x${height} window`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height });
    await page.clock.install();
    await openWritingPage(page);
    // Pause before Start so browser interaction time cannot consume seconds.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
    await page.getByTestId('writing-timer-start').click();
    const readout = page.getByTestId('writing-timer-readout');
    await readout.evaluate((node) => {
      node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
      node.style.lineHeight = 'normal';
    });
    await page.clock.fastForward(4_000);
    await readout.scrollIntoViewIfNeeded();
    await expect
      .poll(() => readout.evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);
    expect((await boxOf(page.getByTestId('writing-timer-pill'), 'running rail')).width).toBe(44);
    await expect(readout).toBeInViewport({ ratio: 1 });
    const visibleBody = clippedTo(
      await boxOf(page.getByTestId('journal-body-input'), 'body'),
      await boxOf(page.getByTestId('journal-page-scroll'), 'page viewport'),
    );
    expect(
      overlapArea(visibleBody, await boxOf(page.getByTestId('writing-timer-pill'), 'rail')),
    ).toBe(0);
    expect(
      await readout.evaluate((node) => {
        const frame = node.getBoundingClientRect();
        const text = node.firstChild;
        if (text === null) return false;
        for (let index = 0; index < (text.textContent?.length ?? 0); index++) {
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const glyph = range.getBoundingClientRect();
          if (
            glyph.left < frame.left - 0.5 ||
            glyph.right > frame.right + 0.5 ||
            glyph.top < frame.top - 0.5 ||
            glyph.bottom > frame.bottom + 0.5
          )
            return false;
        }
        return true;
      }),
      'every enlarged clock glyph must fit its rail and measured height',
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('live-clock-2x.png') });
    await page.getByTestId('writing-timer-pause').scrollIntoViewIfNeeded();
    await page.getByTestId('writing-timer-pause').click();
    await expect(page.getByTestId('writing-timer-resume')).toBeVisible();
    await page.getByTestId('writing-timer-resume').click();
    await page.clock.fastForward(60_000);
    await expect(readout).toContainText('18:56');
    await page.getByTestId('writing-timer-stop').scrollIntoViewIfNeeded();
    await page.getByTestId('writing-timer-stop').click();
    await page.getByTestId('writing-timer-compact').click();
    await expect(page.getByTestId('writing-timer-start')).toBeVisible();
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
  });
}

/** Scroll the page to its true end, then hit-test both edges after layout settles. */
async function expectReachable(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeEnabled();
  if (testId === 'get-resonance-button') {
    await expect(control.locator('..')).toHaveCSS('opacity', '1');
  }
  await expect
    .poll(
      async () => {
        await page.getByTestId('journal-page-scroll').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return control.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          return [box.top + 2, box.bottom - 2].map((y) => {
            const hit = document.elementFromPoint(x, y);
            return {
              clear: hit !== null && (hit === node || node.contains(hit)),
              covering: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.tagName,
              x,
              y,
            };
          });
        });
      },
      { message: `${testId} must clear the floating band by its entire box` },
    )
    .toEqual([expect.objectContaining({ clear: true }), expect.objectContaining({ clear: true })]);
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`Finish and Resonance stay reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openWritingPage(page);
    await page.clock.install();
    const sheet = page.getByTestId('journal-sheet');
    const idleSheet = await boxOf(sheet, 'idle sheet');
    const idleBand = await boxOf(page.getByTestId('writing-session-band'), 'idle band');
    const idleContent = await boxOf(
      page.getByTestId('writing-session-band-content'),
      'idle content',
    );
    expect(idleContent.height, 'short content must keep its natural height').toBeLessThan(
      idleBand.height,
    );
    expect(
      idleContent.y + idleContent.height,
      'short content stays anchored to the bottom of the band',
    ).toBeCloseTo(idleBand.y + idleBand.height, 1);
    await page.clock.fastForward(4_000);
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    await page.screenshot({ path: testInfo.outputPath('idle-timer.png') });
    await page.getByTestId('writing-timer-start').click();
    await page.clock.fastForward(4_000);
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    expect((await boxOf(sheet, 'running sheet')).height).toBeCloseTo(idleSheet.height, 2);
    await page.screenshot({ path: testInfo.outputPath('running-timer.png') });

    await page.clock.fastForward(20 * 60_000);
    await expect(page.getByTestId('writing-session-banner')).toBeVisible();
    await expectReachable(page, 'journal-finish-button');
    await expectReachable(page, 'get-resonance-button');
    expect((await boxOf(sheet, 'finished sheet')).height).toBeCloseTo(idleSheet.height, 2);
    const note = await boxOf(page.getByTestId('writing-session-banner'), 'finished note');
    expect(note.width).toBeLessThanOrEqual(680);
    await page.screenshot({ path: testInfo.outputPath('finished-note.png') });

    await page.getByTestId('journal-finish-button').click();
    await expect(page.getByTestId('journal-edit-button')).toBeVisible();
  });
}

test('expanded options stay inside the sheet around the desktop rail breakpoint', async ({
  page,
}, testInfo) => {
  await openWritingPage(page);
  for (const width of [1019, 1020, 1021, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await expect
      .poll(
        async () => {
          const sheet = await boxOf(page.getByTestId('journal-sheet'), 'sheet');
          const pill = await boxOf(page.getByTestId('writing-timer-pill'), 'expanded pill');
          return pill.x >= sheet.x && pill.x + pill.width <= sheet.x + sheet.width;
        },
        { message: `expanded options leave the sheet at ${width}px` },
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`expanded-${width}.png`) });
  }
});

test('preset controls and their unit fit inside the expanded pill with larger text', async ({
  page,
}, testInfo) => {
  await openWritingPage(page);
  for (const textScale of [1, 2]) {
    for (const width of [1019, 1020, 1021, 1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 640 : 720 });
      await page.getByTestId('writing-timer-pill').evaluate((pill, scale) => {
        for (const text of pill.querySelectorAll<HTMLElement>('[dir="auto"]')) {
          const base = text.dataset.baseFontSize ?? getComputedStyle(text).fontSize;
          text.dataset.baseFontSize = base;
          text.style.fontSize = `${parseFloat(base) * scale}px`;
          text.style.lineHeight = 'normal';
        }
      }, textScale);
      await page.screenshot({ path: testInfo.outputPath(`presets-${width}-${textScale}x.png`) });
      const pill = await boxOf(page.getByTestId('writing-timer-pill'), 'expanded pill');
      const sheet = await boxOf(page.getByTestId('journal-sheet'), 'sheet');
      expect(pill.x).toBeGreaterThanOrEqual(sheet.x);
      expect(pill.x + pill.width).toBeLessThanOrEqual(sheet.x + sheet.width);
      for (const id of [
        'writing-timer-preset-10',
        'writing-timer-preset-20',
        'writing-timer-preset-30',
        'writing-timer-preset-45',
        'writing-timer-preset-unit',
      ]) {
        const control = page.getByTestId(id);
        const box = await boxOf(control, id);
        expect(box.x, `${id} leaves the pill at ${width}px/${textScale}x`).toBeGreaterThanOrEqual(
          pill.x,
        );
        expect(
          box.x + box.width,
          `${id} leaves the pill at ${width}px/${textScale}x`,
        ).toBeLessThanOrEqual(pill.x + pill.width);
        expect(box.y + box.height).toBeLessThanOrEqual(pill.y + pill.height);
        expect(await control.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    }
  }
});

test('a long habit offer scrolls without covering the page actions on a short phone', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const email = await signUp(page, 'writing-timer-many-habits');
  const token = await tokenFor(page.request, email);
  const habitIds: number[] = [];
  for (let index = 1; index <= 16; index += 1) {
    habitIds.push(await seedTimerHabit(page.request, token, `Writing habit ${index}`));
  }
  await page.reload();
  await expect(page.getByTestId('journal-new-entry')).toBeVisible();
  await page.getByTestId('journal-new-entry').click();
  await page
    .getByTestId('journal-body-input')
    .fill('A page with more habits than fit on a small screen.');
  await page.clock.install();
  const sheetHeight = (await boxOf(page.getByTestId('journal-sheet'), 'sheet')).height;
  await page.getByTestId('writing-timer-start').click();
  await page.clock.fastForward(20 * 60_000);
  await page.getByTestId('save-as-habit-accept').click();
  await expect(page.getByTestId('writing-habit-picker')).toBeVisible();
  // Resize through the full-surface scrolling path without remounting the offer.
  await page.setViewportSize({ width: 390, height: 390 });
  await expect(page.getByTestId('writing-habit-picker')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(page.getByTestId('writing-habit-picker')).toBeVisible();
  const band = await boxOf(page.getByTestId('writing-session-band'), 'floating band');
  expect(band.y, 'expanded habit offer extends above the screen').toBeGreaterThanOrEqual(64);
  expect(band.y + band.height).toBeLessThanOrEqual(640);
  const offer = page.getByTestId('writing-session-band-content');
  await expect
    .poll(() => offer.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  await offer.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.getByTestId(`writing-habit-choose-${habitIds[0]}`).scrollIntoViewIfNeeded();
  await expect(page.getByTestId(`writing-habit-choose-${habitIds[0]}`)).toBeInViewport({
    ratio: 1,
  });
  await page.getByTestId(`writing-habit-choose-${habitIds[0]}`).click({ trial: true });
  await expectReachable(page, 'journal-finish-button');
  await expectReachable(page, 'get-resonance-button');
  await page.screenshot({ path: testInfo.outputPath('many-habits-first.png') });
  await page
    .getByTestId(`writing-habit-choose-${habitIds[habitIds.length - 1]}`)
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByTestId(`writing-habit-choose-${habitIds[habitIds.length - 1]}`),
  ).toBeInViewport({ ratio: 1 });
  await page
    .getByTestId(`writing-habit-choose-${habitIds[habitIds.length - 1]}`)
    .click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath('many-habits-last.png') });
  await page.getByTestId('writing-habit-cancel').scrollIntoViewIfNeeded();
  await page.getByTestId('writing-habit-cancel').click();
  await expectReachable(page, 'journal-finish-button');
  await expectReachable(page, 'get-resonance-button');
  expect((await boxOf(page.getByTestId('journal-sheet'), 'sheet')).height).toBeCloseTo(
    sheetHeight,
    2,
  );
  await page.screenshot({ path: testInfo.outputPath('many-habits-dismiss.png') });
  await page.getByTestId('save-as-habit-accept').click();
  const linkedId = habitIds[habitIds.length - 1];
  const linkResponse = page.waitForResponse(
    (response) =>
      response.url() === `${backendUrl()}/ui-flags` &&
      response.request().method() === 'PATCH' &&
      (response.request().postDataJSON() as { writing_session_habit_id?: number })
        .writing_session_habit_id === linkedId,
  );
  await page.getByTestId(`writing-habit-choose-${linkedId}`).click();
  expect(
    (await linkResponse).status(),
    'the selected habit must be linkable on the current server',
  ).toBe(200);
  await expect(page.getByTestId('save-as-habit-linked')).toContainText('Writing habit 16');
  const storedLink = await page.request.get(`${backendUrl()}/ui-flags`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(storedLink.ok()).toBe(true);
  expect(await storedLink.json()).toEqual(
    expect.objectContaining({ writing_session_habit_id: linkedId }),
  );
  await page.getByTestId('writing-session-banner-dismiss').click();
  await expect(page.getByTestId('writing-session-banner')).toHaveCount(0);
});

for (const width of [844, 1280]) {
  for (const textScale of [1, 2]) {
    for (const height of textScale === 2 ? [390, 560] : [390]) {
      test(`finished session stays usable in a ${width}x${height} window at ${textScale}x text`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height });
        await openWritingPage(page);
        await page.clock.install();
        await page.getByTestId('writing-timer-start').click();
        await page.clock.fastForward(20 * 60_000);
        const surface = page.getByTestId('writing-session-band-content');
        await expect(page.getByTestId('writing-session-banner')).toBeVisible();
        await surface.evaluate((node, scale) => {
          for (const text of node.querySelectorAll<HTMLElement>('[dir="auto"]')) {
            text.style.fontSize = `${parseFloat(getComputedStyle(text).fontSize) * scale}px`;
            text.style.lineHeight = 'normal';
          }
        }, textScale);
        // Let ResizeObserver/onLayout settle after finishing and enlarged text.
        await page.clock.fastForward(4_000);
        await expect
          .poll(() =>
            page.getByTestId('writing-session-offer-scroll').evaluate((node) => node.clientHeight),
          )
          .toBeGreaterThan(0);
        await expect
          .poll(() => surface.evaluate((node) => node.scrollHeight > node.clientHeight))
          .toBe(true);
        await expectReachable(page, 'journal-finish-button');
        await expectReachable(page, 'get-resonance-button');
        await surface.evaluate((node) => {
          node.scrollTop = 0;
        });
        await expect(page.getByText('You wrote for 20 minutes.', { exact: true })).toBeInViewport({
          ratio: 1,
        });
        await page.screenshot({ path: testInfo.outputPath('finished-summary.png') });
        for (const id of [
          'save-as-habit-accept',
          'writing-session-banner-dismiss',
          'writing-timer-compact',
        ]) {
          const control = page.getByTestId(id);
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport({ ratio: 1 });
          if (id !== 'save-as-habit-accept')
            expect((await boxOf(control, id)).height).toBeGreaterThanOrEqual(44);
          await control.click({ trial: true });
          if (id === 'writing-timer-compact') {
            expect(
              await page
                .getByTestId('writing-timer-readout')
                .evaluate((node) => node.scrollWidth <= node.clientWidth),
              'the completed timer readout must not ellipsize at enlarged text',
            ).toBe(true);
          }
          await page.screenshot({ path: testInfo.outputPath(`${id}.png`) });
        }
        await expectReachable(page, 'journal-finish-button');
        await expectReachable(page, 'get-resonance-button');
        await page.getByTestId('journal-finish-button').click();
        await expect(page.getByTestId('journal-edit-button')).toBeVisible();
      });
    }
  }
}
