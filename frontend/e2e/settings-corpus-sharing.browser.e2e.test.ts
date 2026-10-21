import { expect, test, type Locator } from '@playwright/test';

import {
  backendUrl,
  bearer,
  frontendUrl,
  logInInPlace,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';

// A routed read can still be awaiting `route.fetch()` when the test ends, and
// that fetch then rejects with "Test ended" outside any test (#3481). Unroute
// first so a straggler's late error is dropped rather than failing the run.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const layouts = [
  { width: 390, height: 844, scale: 1 },
  { width: 390, height: 844, scale: 2 },
  { width: 1280, height: 900, scale: 1 },
  { width: 1280, height: 900, scale: 2 },
];

/** Target rendered Settings text, leaving the physical viewport and controls unchanged. */
async function enlargeText(root: Locator, scale: number): Promise<void> {
  if (scale === 1) return;
  const measured = await root.evaluate((element, factor) => {
    const sizes: { before: number; after: number }[] = [];
    for (const node of element.querySelectorAll<HTMLElement>('*')) {
      if (node.childElementCount || !node.textContent?.trim()) continue;
      const computed = getComputedStyle(node);
      const before = parseFloat(computed.fontSize);
      const lineHeight = parseFloat(computed.lineHeight);
      node.style.fontSize = `${before * factor}px`;
      if (Number.isFinite(lineHeight)) node.style.lineHeight = `${lineHeight * factor}px`;
      sizes.push({ before, after: parseFloat(getComputedStyle(node).fontSize) });
    }
    return sizes;
  }, scale);
  expect(measured.length).toBeGreaterThan(0);
  for (const size of measured) expect(size.after).toBe(size.before * scale);
}

test('a held consent answer stays with its outgoing account in the same running app', async ({
  browser,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const context = await browser.newContext();
  const other = await context.newPage();
  const incomingEmail = await signUp(other, 'consent-owner-incoming');
  const incoming = await sessionFor(other.request, incomingEmail);
  await context.close();
  const outgoingEmail = await signUp(page, 'consent-owner-outgoing');
  const outgoing = await sessionFor(page.request, outgoingEmail);
  const arranged = await page.request.put(`${backendUrl()}/corpus/consent/journal`, {
    headers: bearer(outgoing.token),
    data: { granted: true },
  });
  expect(arranged.ok()).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.consentOwnerWitness = 'same-running-app';
  });
  let release!: () => void;
  let captured!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let first = true;
  let outgoingAuthorization = '';
  await page.route('**/corpus/consent', async (route) => {
    if (route.request().method() !== 'GET' || !first) await route.continue();
    else {
      first = false;
      outgoingAuthorization = route.request().headers().authorization ?? '';
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      expect(
        (
          (await response.json()) as { sources: { source: string; granted: boolean }[] }
        ).sources.find((row) => row.source === 'journal')?.granted,
      ).toBe(true);
      captured();
      await hold;
      await route.fulfill({ response });
    }
  });
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await ready;
  await page.getByTestId('settings-row-logout').click();
  await page.getByRole('link', { name: 'Go to log-in screen' }).click();
  await logInInPlace(page, incomingEmail);
  await expect(page.locator('html')).toHaveAttribute(
    'data-consent-owner-witness',
    'same-running-app',
  );
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  const incomingSwitch = page
    .getByTestId('settings-hub-screen')
    .getByTestId('corpus-consent-switch-journal')
    .getByRole('switch');
  await expect(incomingSwitch).not.toBeChecked();
  const oldAnswer = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/corpus/consent' &&
      response.request().headers().authorization === outgoingAuthorization,
  );
  release();
  await (await oldAnswer).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(incomingSwitch).not.toBeChecked();
  await incomingSwitch.click();
  await expect(incomingSwitch).toBeChecked();
  const confirmed = await page.request.get(`${backendUrl()}/corpus/consent`, {
    headers: bearer(incoming.token),
  });
  expect(confirmed.ok()).toBe(true);
  expect(
    ((await confirmed.json()) as { sources: { source: string; granted: boolean }[] }).sources.find(
      (row) => row.source === 'journal',
    )?.granted,
  ).toBe(true);
  await incomingSwitch.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('incoming-consent-after-held-read.png') });
  await page.reload();
  await expect(
    page
      .getByTestId('settings-hub-screen')
      .getByTestId('corpus-consent-switch-journal')
      .getByRole('switch'),
  ).toBeChecked();
});

async function assertContainedText(root: Locator): Promise<void> {
  const overflow = await root.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>('*')).flatMap((node) => {
      if (node.childElementCount || !node.textContent?.trim()) return [];
      // Whole-text ranges include trailing wrap whitespace outside the line.
      // Measure each painted non-whitespace character instead.
      const range = document.createRange();
      const text = node.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) return [];
      let offset = 0;
      const glyphs = Array.from(node.textContent).flatMap((character) => {
        const start = offset;
        offset += character.length;
        if (!/\S/u.test(character)) return [];
        range.setStart(text, start);
        range.setEnd(text, offset);
        const box = range.getBoundingClientRect();
        return [{ character, start, left: box.left, right: box.right }];
      });
      const rect = {
        left: Math.min(...glyphs.map((glyph) => glyph.left)),
        right: Math.max(...glyphs.map((glyph) => glyph.right)),
      };
      return rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1 ||
        node.scrollWidth > node.clientWidth + 1
        ? [
            {
              text: node.textContent,
              left: rect.left,
              right: rect.right,
              containerLeft: bounds.left,
              containerRight: bounds.right,
              scroll: node.scrollWidth,
              client: node.clientWidth,
              font: getComputedStyle(node).fontSize,
              rightmost: glyphs.filter((glyph) => glyph.right === rect.right),
            },
          ]
        : [];
    });
  });
  expect(overflow).toEqual([]);
}

for (const layout of layouts) {
  test(`Settings shares confirmed corpus consent at ${layout.width}px and ${layout.scale}x text`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(layout);
    await signUp(page, 'consent-sharing');
    let release!: () => void;
    let captured!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const ready = new Promise<void>((done) => {
      captured = done;
    });
    let reads = 0;
    let writes = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'PUT' &&
        new URL(request.url()).pathname === '/corpus/consent/journal'
      )
        writes += 1;
    });
    await page.route('**/corpus/consent', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      reads += 1;
      const response = await route.fetch();
      if (reads === 1) {
        captured();
        await held;
      }
      await route.fulfill({ response });
    });
    await page.goto(`${frontendUrl()}/settings`);
    await ready;
    const hub = page.getByTestId('settings-hub-screen');
    await hub.getByTestId('settings-row-corpus-consent').click();
    const detail = page.getByTestId('corpus-consent-screen');
    await expect(detail).toBeVisible();
    // Release a real backend response; neither surface substitutes a fixture.
    release();
    const detailSwitch = detail.getByTestId('corpus-consent-switch-journal').getByRole('switch');
    await expect(detailSwitch).not.toBeChecked();
    expect(reads).toBe(1);
    await enlargeText(detail, layout.scale);
    await detailSwitch.scrollIntoViewIfNeeded();
    await detailSwitch.focus();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/corpus/consent/journal',
    );
    await page.keyboard.press('Space');
    expect((await saved).status()).toBe(200);
    await expect(detailSwitch).toBeChecked();
    await assertContainedText(detail);
    await page.screenshot({
      path: testInfo.outputPath(`detail-${layout.width}-${layout.scale}x.png`),
    });
    await page.goBack();
    await expect(hub).toBeVisible();
    const hubSwitch = hub.getByTestId('corpus-consent-switch-journal').getByRole('switch');
    await expect(hubSwitch).toBeChecked();
    expect(reads).toBe(1);
    await hubSwitch.click();
    const question = hub.getByTestId('corpus-consent-revoke-journal');
    await expect(question).toBeVisible();
    await enlargeText(hub.getByTestId('settings-group-corpus'), layout.scale);
    await hub
      .getByTestId('settings-corpus-sorting-lead')
      .evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({
      path: testInfo.outputPath(`hub-lead-${layout.width}-${layout.scale}x.png`),
    });
    await assertContainedText(hub.getByTestId('settings-group-corpus'));
    const confirm = question.getByTestId('corpus-consent-revoke-confirm-journal');
    const cancel = question.getByTestId('corpus-consent-revoke-cancel-journal');
    for (const button of [confirm, cancel]) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await confirm.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`withdraw-${layout.width}-${layout.scale}x.png`),
    });
    await cancel.click();
    await expect(hubSwitch).toBeChecked();
    expect(writes).toBe(1);
    await hubSwitch.click();
    await enlargeText(question, layout.scale);
    await confirm.click();
    await expect(hubSwitch).not.toBeChecked();
    expect(writes).toBe(2);
    await page.reload();
    await expect(
      page
        .getByTestId('settings-hub-screen')
        .getByTestId('corpus-consent-switch-journal')
        .getByRole('switch'),
    ).not.toBeChecked();
    expect(reads).toBe(2);
  });
}

for (const width of [390, 1280]) {
  test(`failed consent read recovers through keyboard Retry at ${width}px and 2x text`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signUp(page, 'consent-retry');
    let refuse = true;
    let failures = 0;
    await page.route('**/corpus/consent', async (route) => {
      if (refuse) {
        failures += 1;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"detail":"Controlled read refusal"}',
        });
      } else await route.continue();
    });
    await page.goto(`${frontendUrl()}/settings`);
    await page.getByTestId('settings-row-corpus-consent').click();
    const detail = page.getByTestId('corpus-consent-screen');
    const retry = detail.getByTestId('corpus-consent-retry');
    await expect(retry).toBeVisible();
    expect(failures).toBeGreaterThan(0);
    await enlargeText(detail, 2);
    await retry.scrollIntoViewIfNeeded();
    await assertContainedText(detail);
    const bounds = await retry.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`retry-${width}-2x.png`) });
    refuse = false;
    const recovered = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/corpus/consent' &&
        response.status() === 200,
    );
    await page.keyboard.press('Enter');
    await recovered;
    await expect(retry).toHaveCount(0);
    await expect(
      detail.getByTestId('corpus-consent-switch-journal').getByRole('switch'),
    ).not.toBeChecked();
  });
}
