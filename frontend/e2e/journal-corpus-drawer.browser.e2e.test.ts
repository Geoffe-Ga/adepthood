import { expect, test, type Page } from '@playwright/test';

import { feedbackControl } from './feedbackBrowserSupport';
import { frontendUrl, signUp } from './journalHabitsBrowserSupport';

/** React Native-only accessibility props that must never reach the DOM (#2829). */
const NATIVE_PROP_NAME = /accessible|accessibilityElementsHidden|importantForAccessibility/u;
/**
 * React's dev-build complaints about such a prop: "Received `false` for a
 * non-boolean attribute `accessible`" and "React does not recognize the `x`
 * prop". Matched by phrase and prop name separately, because the console text
 * may still carry React's `%s` placeholders with the values appended after.
 */
const REACT_PROP_COMPLAINT = /non-boolean attribute|does not recognize the/u;

function isNativePropComplaint(line: string): boolean {
  return REACT_PROP_COMPLAINT.test(line) && NATIVE_PROP_NAME.test(line);
}

/**
 * Every element carrying a React Native-only accessibility prop as a DOM
 * attribute. Read from each element's own attribute names, lower-cased,
 * because an attribute selector matches case-sensitively on an <svg>.
 */
async function nativeA11yAttributes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const leaked = ['accessible', 'accessibilityelementshidden', 'importantforaccessibility'];
    return Array.from(document.querySelectorAll('*')).flatMap((element) =>
      element
        .getAttributeNames()
        .filter((name) => leaked.includes(name.toLowerCase()))
        .map(
          (name) => `<${element.tagName.toLowerCase()} ${name}="${element.getAttribute(name)}">`,
        ),
    );
  });
}

test('the corpus remains in the Journal drawer after its invitation is set aside', async ({
  page,
}) => {
  await signUp(page, 'journal-corpus-drawer');

  const band = page.getByTestId('journal-voice-readiness-band');
  await expect(band).toBeVisible();

  // The permanent drawer door exists even while the one-time explanation is
  // still present, and both neighboring writing actions carry real icons.
  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  const drawer = page.getByRole('dialog');
  const photograph = drawer.getByRole('button', { name: 'Photograph a page' });
  const corpus = drawer.getByRole('button', { name: "Everything you've written" });
  await expect(photograph.locator('svg')).toHaveCount(1);
  await expect(corpus.locator('svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close Journal menu' }).click();

  // Setting the explanatory band aside is durable, but never strands the
  // corpus: after a cold reload the drawer becomes its sole Journal surface.
  await page.getByTestId('journal-voice-readiness-dismiss').click();
  await expect(band).toHaveCount(0);
  await page.reload();
  await expect(band).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Journal menu' }).click();
  await drawer.getByRole('button', { name: "Everything you've written" }).click();
  await expect(page.getByTestId('corpus-consent-screen')).toBeVisible();
  await expect(page.getByTestId('screen-drawer')).toHaveCount(0);
});

// #3009 / #2829: a decorative glyph is hidden from the web screen reader by
// aria-hidden, and no React Native-only accessibility prop reaches the DOM --
// neither as an attribute nor as React's console error about one. The anonymous
// pages are negative controls: no drawer toggle or icon button mounts there.
test('decorative glyphs reach the DOM aria-hidden and carry no native-only prop', async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleLines.push(message.text());
    }
  });

  for (const anonymous of ['get-started', 'login']) {
    await page.goto(`${frontendUrl()}/${anonymous}`);
    await expect(page.getByRole('button').first()).toBeVisible();
    expect(await nativeA11yAttributes(page)).toEqual([]);
  }

  await signUp(page, 'decorative-glyphs');
  const toggle = page.getByRole('button', { name: 'Open Journal menu' });
  await expect(toggle.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(
    page.getByTestId('send-feedback-icon').filter({ visible: true }).first(),
  ).toHaveAttribute('aria-hidden', 'true');
  expect(await nativeA11yAttributes(page)).toEqual([]);

  await toggle.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await nativeA11yAttributes(page)).toEqual([]);
  await page.getByRole('button', { name: 'Close Journal menu' }).click();

  await feedbackControl(page).click();
  await expect(page.getByTestId('feedback-composer-heading')).toBeVisible();
  expect(await nativeA11yAttributes(page)).toEqual([]);

  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId('journal-new-entry').click();
  const close = page.getByTestId('journal-close-entry');
  await expect(close.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Close — return to your journal' })).toBeVisible();
  expect(await nativeA11yAttributes(page)).toEqual([]);

  expect(consoleLines.filter(isNativePropComplaint)).toEqual([]);
});
