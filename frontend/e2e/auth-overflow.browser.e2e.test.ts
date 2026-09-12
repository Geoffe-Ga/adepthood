import { expect, test, type Locator } from '@playwright/test';

import { frontendUrl, signUp } from './journalHabitsBrowserSupport';

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

const AUTH_ROUTES = [
  ['get-started', 'get-started'],
  ['login', 'login'],
  ['signup', 'signup'],
  ['forgot-password', 'forgot-password'],
  ['reset-password', 'reset-password'],
  ['cancel-reset', 'cancel-reset'],
] as const;

async function metrics(scroll: Locator): Promise<ScrollMetrics> {
  return scroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
}

test('auth content centres when it fits and every auth route scrolls when space is tight', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1200 });
  await page.goto(`${frontendUrl()}/get-started`);

  const scroll = page.getByTestId('get-started-scroll');
  const form = page.getByTestId('get-started-form');
  const first = page.getByText('Adepthood', { exact: true });
  const last = page.getByRole('link', { name: 'Go to log-in screen' });
  await expect(scroll).toBeVisible();
  await expect.poll(async () => (await metrics(scroll)).scrollHeight).toBeLessThanOrEqual(1200);

  const [scrollBox, formBox] = await Promise.all([scroll.boundingBox(), form.boundingBox()]);
  expect(scrollBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  if (scrollBox === null || formBox === null) return;
  const topGap = formBox.y - scrollBox.y;
  const bottomGap = scrollBox.y + scrollBox.height - (formBox.y + formBox.height);
  expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 320 });
  await expect.poll(async () => (await metrics(scroll)).scrollHeight).toBeGreaterThan(320);
  const atStart = await first.boundingBox();
  const shortScrollBox = await scroll.boundingBox();
  expect(atStart).not.toBeNull();
  expect(shortScrollBox).not.toBeNull();
  if (atStart === null || shortScrollBox === null) return;
  expect(atStart.y).toBeGreaterThanOrEqual(shortScrollBox.y);

  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(async () => (await metrics(scroll)).scrollTop).toBeGreaterThan(0);
  const atEnd = await last.boundingBox();
  expect(atEnd).not.toBeNull();
  if (atEnd === null) return;
  expect(atEnd.y + atEnd.height).toBeLessThanOrEqual(shortScrollBox.y + shortScrollBox.height + 1);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, testID] of AUTH_ROUTES) {
    await page.goto(`${frontendUrl()}/${path}`);
    await expect(page.getByTestId(`${testID}-scroll`)).toBeVisible();
  }

  await signUp(page, 'auth-overflow');
});
