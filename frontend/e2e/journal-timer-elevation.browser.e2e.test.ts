import { expect, test, type Page } from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

/** Check the painted surface and the scroll viewport that can cut its shadow off. */
async function expectFloatingPaper(page: Page, testId: string): Promise<string> {
  const card = page.getByTestId(testId);
  await expect(card).toBeVisible();
  const geometry = await card.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const sheet = document.querySelector('[data-testid="journal-sheet"]');
    if (!sheet) throw new Error('the journal must be mounted');
    function shadowClip(parent: HTMLElement) {
      const css = getComputedStyle(parent);
      const frame = parent.getBoundingClientRect();
      const clipsX = /hidden|auto|scroll|clip/.test(css.overflowX);
      const clipsY = /hidden|auto|scroll|clip/.test(css.overflowY);
      if (!clipsX && !clipsY) return null;
      return {
        name: parent.dataset.testid ?? parent.tagName,
        room: [
          clipsX ? rect.left - frame.left : Infinity,
          clipsX ? frame.right - rect.right : Infinity,
          clipsY ? rect.top - frame.top : Infinity,
          clipsY ? frame.bottom - rect.bottom : Infinity,
        ],
      };
    }
    const clips = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const clip = shadowClip(parent);
      if (clip) clips.push(clip);
    }
    return {
      shadow: getComputedStyle(node).boxShadow,
      width: rect.width,
      sheetWidth: sheet.getBoundingClientRect().width,
      clips,
    };
  });
  expect(geometry.shadow, `${testId} has a visible warm shadow`).not.toBe('none');
  expect(geometry.shadow).toContain('18px');
  expect(geometry.width, `${testId} is visibly narrower than the paper`).toBeLessThanOrEqual(
    geometry.sheetWidth - 16,
  );
  const shadowRoom = [24, 24, 12, 26];
  for (const clip of geometry.clips) {
    for (const [edge, room] of clip.room.entries()) {
      expect(room, `${testId}'s shadow clears ${clip.name}`).toBeGreaterThanOrEqual(
        shadowRoom[edge] ?? 0,
      );
    }
  }
  return geometry.shadow;
}

for (const width of [390, 844, 1280]) {
  test(`timer keeps its elevation through its lifecycle at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await signUp(page, `timer-elevation-${width}`);
    await page.getByTestId('journal-new-entry').click();
    await page.getByTestId('journal-body-input').fill('A quiet page with a timer above the paper.');
    await page.clock.install();
    const shadow = await expectFloatingPaper(page, 'writing-timer-pill');
    await page.screenshot({ path: testInfo.outputPath('idle.png') });

    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
    expect(await expectFloatingPaper(page, 'writing-timer-pill')).toBe(shadow);
    await page.screenshot({ path: testInfo.outputPath('running.png') });

    await page.getByTestId('writing-timer-pause').click();
    await expect(page.getByTestId('writing-timer-resume')).toBeVisible();
    expect(await expectFloatingPaper(page, 'writing-timer-pill')).toBe(shadow);
    await page.getByTestId('writing-timer-resume').click();
    await page.clock.fastForward(20 * 60_000);
    await expect(page.getByTestId('writing-session-banner')).toBeVisible();
    expect(await expectFloatingPaper(page, 'writing-session-banner')).toBe(shadow);
    expect(await expectFloatingPaper(page, 'writing-timer-pill')).toBe(shadow);
    await page.screenshot({ path: testInfo.outputPath('completed.png') });

    await page.getByTestId('writing-session-banner-dismiss').click();
    expect(await expectFloatingPaper(page, 'writing-timer-pill')).toBe(shadow);
    await page.screenshot({ path: testInfo.outputPath('waiting.png') });
    await page.getByTestId('writing-timer-compact').click();
    await expect(page.getByTestId('writing-timer-start')).toBeVisible();
    expect(await expectFloatingPaper(page, 'writing-timer-pill')).toBe(shadow);
    await page.screenshot({ path: testInfo.outputPath('ready-again.png') });
    await page.getByTestId('writing-timer-start').click();
    await expect(page.getByTestId('writing-timer-stop')).toBeVisible();
    await page.getByTestId('writing-timer-stop').click();
    await page.getByTestId('journal-page-scroll').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.getByTestId('journal-finish-button').click();
    await expect(page.getByTestId('journal-edit-button')).toBeVisible();
  });
}
