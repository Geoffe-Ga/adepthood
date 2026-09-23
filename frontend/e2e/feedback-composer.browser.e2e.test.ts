import { expect, test, type Locator, type Page } from '@playwright/test';

import { backendUrl, bearer, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * Issue #2898 — "Send feedback" is obvious and usable at both viewport profiles,
 * and a report crosses the real client and the live intake route to a
 * reference the tester can read back.
 *
 * The wide pass is keyboard-only on purpose: Tab reaches the header control,
 * Enter opens the composer with focus on its heading, the category, answers
 * and impact are chosen and typed without a pointer, and closing hands focus
 * back to the control that opened it. The narrow pass is the phone: the control
 * is found by its accessible name (its visible label shortens to "Feedback"),
 * and a report is sent from there too.
 *
 * Both passes measure the control against the fixed controls it sits nearest --
 * the screen drawer toggles, the Journal's new-page action, the Map's
 * magnifier and the Habits first-use action -- because a header control that
 * overlaps one of them is exactly the kind of regression a component test
 * cannot see.
 */

const WIDE_VIEWPORT = { width: 1280, height: 720 };
const NARROW_VIEWPORT = { width: 390, height: 844 };
/** Bounding boxes are sub-pixel; a fraction of a pixel is not an overlap. */
const SUBPIXEL_TOLERANCE = 1;
/** Upper bound on Tab presses to reach a control, so a lost focus fails fast. */
const MAX_TAB_PRESSES = 60;
const PUBLIC_ID = /^FB-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const HTTP_OK = 200;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no layout box`);
  return box;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x + a.width - SUBPIXEL_TOLERANCE > b.x &&
    b.x + b.width - SUBPIXEL_TOLERANCE > a.x &&
    a.y + a.height - SUBPIXEL_TOLERANCE > b.y &&
    b.y + b.height - SUBPIXEL_TOLERANCE > a.y
  );
}

/** The visible header control on the focused screen. */
function feedbackControl(page: Page): Locator {
  return page.getByRole('button', { name: 'Send feedback' }).filter({ visible: true });
}

async function expectClearOf(page: Page, others: ReadonlyArray<[Locator, string]>): Promise<void> {
  const control = await boxOf(feedbackControl(page), 'Send feedback');
  for (const [locator, what] of others) {
    await expect(locator).toBeVisible();
    expect(overlaps(control, await boxOf(locator, what)), `Send feedback overlaps ${what}`).toBe(
      false,
    );
  }
}

async function openScreen(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${from} menu` }).click();
  await page.getByRole('dialog').getByRole('button', { name: to, exact: true }).click();
  await expect(page.getByRole('button', { name: `Open ${to} menu` })).toBeVisible();
}

/** Measure the control on Journal, Habits and Map, ending back on Journal. */
async function expectNoOverlapAcrossScreens(page: Page): Promise<void> {
  await expectClearOf(page, [
    [page.getByRole('button', { name: 'Open Journal menu' }), 'the Journal drawer toggle'],
    // New entry sits in the shelf header and is always there; the empty-shelf
    // call to action renders beside it on a fresh account, so an either-or
    // locator would match both and trip strict mode.
    [page.getByTestId('journal-new-entry'), 'the Journal new-page action'],
  ]);
  await openScreen(page, 'Journal', 'Habits');
  await expectClearOf(page, [
    [page.getByRole('button', { name: 'Open Habits menu' }), 'the Habits drawer toggle'],
    [page.getByRole('button', { name: 'Add a habit' }).first(), 'the Habits first-use action'],
  ]);
  await openScreen(page, 'Habits', 'Map');
  await expectClearOf(page, [
    [page.getByRole('button', { name: 'Open Map menu' }), 'the Map drawer toggle'],
    [page.getByTestId('map-magnifier'), 'the Map magnifier'],
  ]);
  await openScreen(page, 'Map', 'Journal');
}

/** Press Tab until `target` holds focus. Keyboard only; bounded so it cannot spin. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TAB_PRESSES; presses += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

async function typeInto(page: Page, testID: string, text: string): Promise<void> {
  await tabTo(page, page.getByTestId(testID));
  await page.keyboard.type(text);
}

async function readReference(page: Page): Promise<string> {
  const reference = page.getByTestId('feedback-reference');
  await expect(reference).toHaveText(PUBLIC_ID);
  return (await reference.textContent()) ?? '';
}

test('keyboard-only at 1280x720: open, report something broken, read back the reference', async ({
  page,
}) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  const email = await signUp(page, 'feedback-wide');
  await expectNoOverlapAcrossScreens(page);

  const control = feedbackControl(page);
  await expect(control).toHaveText('Send feedback');
  await tabTo(page, control);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('feedback-composer-heading')).toBeFocused();

  await tabTo(page, page.getByRole('radio', { name: 'Something broke' }));
  await page.keyboard.press('Enter');
  await typeInto(page, 'feedback-field-summary', 'The Finish button did nothing');
  await typeInto(page, 'feedback-field-intent', 'Finish a morning page');
  await typeInto(page, 'feedback-field-expected', 'The page to be marked finished');
  await typeInto(page, 'feedback-field-actual', 'Nothing changed on screen');
  await tabTo(page, page.getByRole('radio', { name: 'I could carry on' }));
  await page.keyboard.press('Enter');

  const preview = page.getByTestId('feedback-attached-preview');
  await expect(preview.getByTestId('feedback-attached-screen')).toHaveText('Screen: journal.shelf');
  await expect(preview.getByTestId('feedback-attached-platform')).toHaveText('Platform: web');
  await expect(preview.getByTestId('feedback-attached-viewport_class')).toHaveText(
    'Viewport class: expanded',
  );

  await tabTo(page, page.getByTestId('feedback-send'));
  await page.keyboard.press('Enter');
  const publicId = await readReference(page);

  // The reference resolves to this account's own receipt through the live route.
  const token = await tokenFor(page.request, email);
  const receipt = await page.request.get(`${backendUrl()}/feedback/${publicId}/receipt`, {
    headers: bearer(token),
  });
  expect(receipt.status()).toBe(HTTP_OK);
  expect(await receipt.json()).toMatchObject({
    public_id: publicId,
    category: 'broken',
    impact: 'can_continue',
  });

  await tabTo(page, page.getByTestId('feedback-done'));
  await page.keyboard.press('Enter');
  await expect(feedbackControl(page)).toBeFocused();

  // The Settings hub opens the same composer, on a fresh draft, and closing it
  // hands focus back to the row that opened it.
  await tabTo(page, page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }));
  await page.keyboard.press('Enter');
  const settingsRow = page.getByTestId('settings-row-feedback');
  await tabTo(page, settingsRow);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('feedback-composer-heading')).toBeFocused();
  await expect(page.getByTestId('feedback-field-summary')).toHaveCount(0);
  await tabTo(page, page.getByRole('radio', { name: 'Something worked well' }));
  await page.keyboard.press('Enter');
  await typeInto(page, 'feedback-field-summary', 'The Settings hub');
  await typeInto(page, 'feedback-field-actual', 'Everything in one place');
  await tabTo(page, page.getByTestId('feedback-send'));
  await page.keyboard.press('Enter');
  await readReference(page);
  await tabTo(page, page.getByTestId('feedback-done'));
  await page.keyboard.press('Enter');
  await expect(settingsRow).toBeFocused();
});

test('at 390x844: find the control by name and send a report', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await signUp(page, 'feedback-narrow');
  await expectNoOverlapAcrossScreens(page);

  const control = feedbackControl(page);
  await expect(control).toHaveText('Feedback');
  await control.click();

  await page.getByRole('radio', { name: 'Something worked well' }).click();
  await page.getByTestId('feedback-field-summary').fill('The journal shelf');
  await page.getByTestId('feedback-field-actual').fill('How calm it feels to open');
  await expect(page.getByTestId('feedback-attached-viewport_class')).toHaveText(
    'Viewport class: compact',
  );
  await page.getByTestId('feedback-send').click();

  await readReference(page);
});
