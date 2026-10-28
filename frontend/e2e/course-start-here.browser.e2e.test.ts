import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

interface Resource {
  slug: string;
  title: string;
  order: number;
  is_read: boolean;
}
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];

/** Exercise rendered text enlargement only; this is not an OS text-scaling claim. */
async function doubleText(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    for (const child of element.querySelectorAll<HTMLElement>('*')) {
      if (
        ![...child.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )
      )
        continue;
      const computed = getComputedStyle(child);
      child.style.fontSize = `${Number.parseFloat(computed.fontSize) * 2}px`;
      if (computed.lineHeight !== 'normal')
        child.style.lineHeight = `${Number.parseFloat(computed.lineHeight) * 2}px`;
    }
  });
}

async function expectVisibleGlyphs(target: Locator): Promise<void> {
  const clipped = await target.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        if (
          ![...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
          )
        )
          return false;
        const rect = node.getBoundingClientRect();
        return (
          node.scrollWidth > node.clientWidth + 1 || rect.left < -1 || rect.right > innerWidth + 1
        );
      })
      .map((node) => node.textContent),
  );
  expect(clipped).toEqual([]);
}

async function markResource(page: Page): Promise<void> {
  await expect(page.getByTestId('reader-markdown')).toBeVisible();
  await page.mouse.move(page.viewportSize()!.width / 2, page.viewportSize()!.height / 2);
  await page.mouse.wheel(0, 100_000);
  const mark = page.getByTestId('resource-mark-read-button');
  await expect(mark).toBeEnabled();
  const persisted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/course\/site-resources\/[^/]+\/mark-read$/.test(response.url()),
  );
  await mark.click();
  expect((await persisted).status()).toBe(200);
  await expect(page.getByText('✓ Read', { exact: true })).toBeVisible();
}

async function openNextResource(page: Page, resource: Resource, index: number, textScale: number) {
  if (index === 0) {
    const card = page.getByTestId(`start-here-resource-${resource.slug}`);
    if (textScale === 2) {
      await card.focus();
      await page.keyboard.press('Enter');
    } else {
      await card.click();
    }
  } else {
    await page.getByTestId('read-next').click();
  }
}

for (const viewport of VIEWPORTS) {
  for (const textScale of [1, 2]) {
    test(`Start Here persists reading and hands off to the Course at ${viewport.width}px and ${textScale}x text`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize(viewport);
      const email = await signUp(page, 'course-start-here');
      const token = await tokenFor(request, email);
      const response = await request.get(`${backendUrl()}/course/site-resources`, {
        headers: bearer(token),
      });
      expect(response.status()).toBe(200);
      const resources = (await response.json()) as Resource[];
      expect(resources.length).toBeGreaterThan(0);
      expect(resources.map((row) => row.order)).toEqual(
        resources.map((row) => row.order).sort((a, b) => a - b),
      );
      await page.goto(`${frontendUrl()}/course`);
      const section = page.getByTestId('start-here-section');
      await expect(section).toBeVisible();
      await expect(
        section.getByText(`0 of ${resources.length} read`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('From Aptitude Guru', { exact: true })).toHaveCount(0);
      const pill = page.getByTestId('start-here-pill');
      await expect(pill).toHaveCSS('border-top-color', 'rgb(165, 87, 47)');
      if (textScale === 2) {
        await doubleText(pill);
        await doubleText(section);
      }
      await page.screenshot({
        path: `e2e/artifacts/start-here-before-geometry-${viewport.width}-${textScale}x.png`,
      });
      const escapedPillText = await pill.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('*')].some((node) => {
          if (!node.textContent?.trim()) return false;
          const rect = node.getBoundingClientRect();
          return (
            rect.top < box.top - 1 ||
            rect.bottom > box.bottom + 1 ||
            rect.left < box.left - 1 ||
            rect.right > box.right + 1
          );
        });
      });
      expect(escapedPillText).toBe(false);
      await expectVisibleGlyphs(pill);
      await expectVisibleGlyphs(section);
      const targetBox = await pill.boundingBox();
      expect(targetBox?.width).toBeGreaterThanOrEqual(44);
      expect(targetBox?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: `e2e/artifacts/start-here-${viewport.width}-${textScale}x.png`,
      });
      await pill.click();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('stage-pill-1')).toBeFocused();
      await page.screenshot({
        path: `e2e/artifacts/start-here-keyboard-${viewport.width}-${textScale}x.png`,
      });
      await page.keyboard.press('Shift+Tab');
      await expect(pill).toBeFocused();
      for (const [index, resource] of resources.entries()) {
        await expect(page.getByTestId('read-next')).toHaveAttribute(
          'aria-label',
          `Read next: ${resource.title}`,
        );
        await openNextResource(page, resource, index, textScale);
        await markResource(page);
        await page.getByTestId('reader-back-button').click();
        await expect(
          section.getByText(`${index + 1} of ${resources.length} read`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId(`start-here-resource-${resource.slug}`)).toHaveAttribute(
          'aria-label',
          `Open ${resource.title}, read`,
        );
        if (index === 0 && resources.length > 1) {
          await page.reload();
          await expect(page.getByTestId(`start-here-resource-${resource.slug}`)).toHaveAttribute(
            'aria-label',
            `Open ${resource.title}, read`,
          );
        }
      }
      const marks = await request.get(`${backendUrl()}/course/site-resources`, {
        headers: bearer(token),
      });
      expect(((await marks.json()) as Resource[]).every((row) => row.is_read)).toBe(true);
      const next = await request.get(`${backendUrl()}/course/next-unread`, {
        headers: bearer(token),
      });
      const chapter = (await next.json()) as { kind: string; title: string };
      expect(chapter.kind).toBe('chapter');
      await page.getByTestId('read-next').click();
      await expect(page.getByTestId('chapter-reader')).toContainText(chapter.title);
    });
  }
}

for (const viewport of VIEWPORTS) {
  test(`Start Here drawer and Energy hand-off respect the Habits ring at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const email = await signUp(page, 'course-start-here-energy');
    const token = await tokenFor(request, email);
    await page.goto(`${frontendUrl()}/course`);
    await expect(page.getByTestId('start-here-section')).toBeVisible();
    await page.getByRole('button', { name: 'Open Course menu' }).click();
    const drawer = page.getByRole('dialog');
    const resources = drawer.getByTestId('course-drawer-start-here');
    await expect(resources.getByText('Start Here', { exact: true })).toBeVisible();
    // A visible sliding panel can still be outside the viewport mid-transition.
    await expect
      .poll(() =>
        page
          .getByTestId('screen-drawer-panel')
          .evaluate((panel) => new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41),
      )
      .toBe(0);
    await doubleText(resources);
    await expectVisibleGlyphs(resources);
    await page.screenshot({ path: `e2e/artifacts/start-here-drawer-${viewport.width}-2x.png` });
    await resources.getByRole('button', { name: 'Open Energy Scaffolding', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('reader-markdown')).toBeVisible();
    await page.getByRole('button', { name: 'Open Course menu' }).click();
    const activeResource = page
      .getByRole('dialog')
      .getByRole('button', { name: 'Open Energy Scaffolding', exact: true });
    await expect(activeResource).toHaveCSS('background-color', 'rgb(243, 236, 223)');
    await expect
      .poll(() =>
        page
          .getByTestId('screen-drawer-panel')
          .evaluate((panel) => new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41),
      )
      .toBe(0);
    await doubleText(page.getByRole('dialog').getByTestId('course-drawer-start-here'));
    await expectVisibleGlyphs(activeResource);
    await page.screenshot({
      path: `e2e/artifacts/start-here-drawer-active-${viewport.width}-2x.png`,
    });
    await activeResource.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByTestId('reader-back-button').click();
    const energy = page.getByRole('button', { name: 'Start Energy Scaffolding', exact: true });
    await energy.scrollIntoViewIfNeeded();
    await doubleText(energy);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(async () => {
        const button = await energy.boundingBox();
        const fade = await page.locator('[data-testid="bottom-fade"]:visible').boundingBox();
        if (!button || !fade) throw new Error('Energy control or fade has no rendered bounds');
        return button.y + button.height <= fade.y + 1 && button.y >= 0;
      })
      .toBe(true);
    await expectVisibleGlyphs(energy);
    await page.screenshot({ path: `e2e/artifacts/start-here-energy-${viewport.width}-2x.png` });
    await energy.click();
    const modal = page.getByTestId('onboarding-modal-content');
    await expect(modal).toBeVisible();
    await page.getByTestId('onboarding-close').click();
    await page.getByTestId('discard-exit').click();
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Habits menu' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Course', exact: true }).click();
    await energy.click();
    await expect(modal).toBeVisible();
    await page.getByTestId('onboarding-close').click();
    await page.getByTestId('discard-exit').click();
    const disabled = await request.patch(`${backendUrl()}/depth-preferences`, {
      headers: bearer(token),
      data: { enable_habits: false },
    });
    expect(disabled.status()).toBe(200);
    await page.goto(`${frontendUrl()}/course`);
    await expect(page.getByTestId('start-here-section')).toBeVisible();
    await expect(energy).toHaveCount(0);
    const preferences = await request.get(`${backendUrl()}/depth-preferences`, {
      headers: bearer(token),
    });
    expect(((await preferences.json()) as { enable_habits: boolean }).enable_habits).toBe(false);
  });
}

test('a held preference hydration cannot open Energy onboarding for a server-disabled Habits ring', async ({
  page,
  request,
}) => {
  await page.setViewportSize(VIEWPORTS[0]!);
  const email = await signUp(page, 'course-start-here-held-ring');
  const token = await tokenFor(request, email);
  const disabled = await request.patch(`${backendUrl()}/depth-preferences`, {
    headers: bearer(token),
    data: { enable_habits: false },
  });
  expect(disabled.status()).toBe(200);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  let serverConfirmedDisabled = false;
  await page.route('**/depth-preferences', async (route) => {
    if (route.request().method() !== 'GET' || intercepted) {
      await route.continue();
    } else {
      intercepted = true;
      const response = await route.fetch();
      serverConfirmedDisabled =
        ((await response.json()) as { enable_habits: boolean }).enable_habits === false;
      await hold;
      await route.fulfill({ response });
    }
  });
  try {
    await page.goto(`${frontendUrl()}/course`);
    await expect(page.getByTestId('start-here-section')).toBeVisible();
    await expect.poll(() => serverConfirmedDisabled).toBe(true);
    await page.getByRole('button', { name: 'Start Energy Scaffolding', exact: true }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const disabledMessage = page.getByText(
      'Habits is turned off. You can change this in Settings.',
      { exact: true },
    );
    await expect(disabledMessage).toBeVisible();
    await page.mouse.move(195, 500);
    await page.mouse.wheel(0, 200);
    await expect
      .poll(async () => {
        const message = await disabledMessage.boundingBox();
        const fade = await page.locator('[data-testid="bottom-fade"]:visible').boundingBox();
        if (!message || !fade) throw new Error('Disabled message or fade has no rendered bounds');
        return message.y + message.height <= fade.y + 1;
      })
      .toBe(true);
    await page.screenshot({ path: 'e2e/artifacts/start-here-held-disabled-ring.png' });
    await expect(page.getByTestId('onboarding-modal-content')).toBeHidden();
  } finally {
    release();
  }
  await expect(
    page.getByRole('button', { name: 'Start Energy Scaffolding', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('onboarding-modal-content')).toBeHidden();
  const unchanged = await request.get(`${backendUrl()}/depth-preferences`, {
    headers: bearer(token),
  });
  expect(((await unchanged.json()) as { enable_habits: boolean }).enable_habits).toBe(false);
});

test('a failed Start Here lookup leaves an explicit Frequency usable and retries from the drawer', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS[0]!);
  await signUp(page, 'course-start-here-retry');
  // Controlled transport failure only; no successful Course payload is replaced.
  await page.route('**/course/start-here/progress', (route) =>
    route.fulfill({ status: 503, json: { detail: 'controlled_start_here_unavailable' } }),
  );
  await page.goto(`${frontendUrl()}/course/1`);
  await expect(page.getByTestId('stage-cover')).toBeVisible();
  await expect(page.getByTestId('stage-pill-1')).toHaveCSS('border-top-color', 'rgb(165, 87, 47)');
  await page.getByRole('button', { name: 'Open Course menu' }).click();
  const section = page.getByRole('dialog').getByTestId('course-drawer-start-here');
  const retry = section.getByRole('button', {
    name: "Start Here couldn't load. Tap to retry.",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await doubleText(section);
  await expectVisibleGlyphs(section);
  const box = await retry.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'e2e/artifacts/start-here-drawer-retry-390-2x.png' });
  await page.unroute('**/course/start-here/progress');
  await retry.click();
  await expect(
    section.getByRole('button', { name: 'Open Energy Scaffolding', exact: true }),
  ).toBeVisible();
  await expect(retry).toHaveCount(0);
  await section.getByRole('button', { name: 'Open Energy Scaffolding', exact: true }).click();
  await expect(page.getByTestId('reader-markdown')).toBeVisible();
});
