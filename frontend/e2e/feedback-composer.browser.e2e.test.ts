import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  asShown,
  captureFeedbackPosts,
  feedbackControl,
  fillBrokenReport,
  HTTP_OK,
  NARROW_VIEWPORT,
  openComposerFrom,
  plantJournalFailure,
  readPreviewContext,
  readReference,
  tabTo,
  typeInto,
  WIDE_VIEWPORT,
  type OriginPath,
} from './feedbackBrowserSupport';
import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

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
 *
 * #2899 adds the epic's exit journeys: an origin matrix across all five tabs
 * and Settings, a compact report filed from a Journal that has just failed --
 * double-clicked, and proven to put exactly one request on the wire whose
 * context is exactly what the preview showed -- and a keyboard-only
 * "confusing" report from the wide Map.
 */

/** Bounding boxes are sub-pixel; a fraction of a pixel is not an overlap. */
const SUBPIXEL_TOLERANCE = 1;
/** A double click is two presses; the in-flight guard must make it one request. */
const ONE_REQUEST = 1;
/** Long enough for a second, unguarded request to have left after the first. */
const SETTLE_MS = 1_500;

const HEADER_CONTROL = 'shell.header.send_feedback';
const SETTINGS_CONTROL = 'settings.row.send_feedback';

interface Origin {
  path: OriginPath;
  screen: string;
  control: string;
}

/** Every place the composer opens from, and the envelope each must attach. */
const ORIGINS: readonly Origin[] = [
  { path: 'journal', screen: 'journal.shelf', control: HEADER_CONTROL },
  { path: 'habits', screen: 'habits.grid', control: HEADER_CONTROL },
  { path: 'practice', screen: 'practice.player', control: HEADER_CONTROL },
  { path: 'course', screen: 'course.reader', control: HEADER_CONTROL },
  { path: 'map', screen: 'map.stages', control: HEADER_CONTROL },
  { path: 'settings', screen: 'settings.hub', control: SETTINGS_CONTROL },
];
/** The two origins the epic names at both viewport profiles. */
const COMPACT_ORIGINS = ORIGINS.filter((origin) => ['journal', 'map'].includes(origin.path));

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

/** Open the composer from each origin and read the envelope it would attach. */
async function expectOrigins(
  page: Page,
  origins: readonly Origin[],
  viewportClass: string,
): Promise<void> {
  for (const origin of origins) {
    await openComposerFrom(page, origin.path);
    // The preview renders once a category is chosen; the envelope does not depend on which.
    await page.getByRole('radio', { name: 'Something worked well' }).click();
    const preview = page.getByTestId('feedback-attached-preview');
    await expect(preview.getByTestId('feedback-attached-screen'), origin.path).toHaveText(
      `Screen: ${origin.screen}`,
    );
    await expect(preview.getByTestId('feedback-attached-control'), origin.path).toHaveText(
      `Control: ${origin.control}`,
    );
    await expect(preview.getByTestId('feedback-attached-viewport_class'), origin.path).toHaveText(
      `Viewport class: ${viewportClass}`,
    );
  }
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

test('at 1280x720 every origin attaches its own screen and control', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  await signUp(page, 'feedback-origins-wide');

  await expectOrigins(page, ORIGINS, 'expanded');
});

test('at 390x844 Journal and Map attach their screens as compact', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await signUp(page, 'feedback-origins-narrow');

  await expectOrigins(page, COMPACT_ORIGINS, 'compact');
});

test('at 390x844 a failed Journal is reported once, with exactly the context shown', async ({
  page,
}) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  const email = await signUp(page, 'feedback-journal-broken');
  await plantJournalFailure(page);
  await page.reload();
  await expect(page.getByTestId('journal-shelf-error')).toBeVisible();

  const posts = captureFeedbackPosts(page);
  await page.getByRole('button', { name: 'Send feedback' }).filter({ visible: true }).click();
  await fillBrokenReport(page, 'The journal shelf would not load');
  const preview = page.getByTestId('feedback-attached-preview');
  await expect(preview.getByTestId('feedback-attached-screen')).toHaveText('Screen: journal.shelf');
  await expect(preview.getByTestId('feedback-attached-viewport_class')).toHaveText(
    'Viewport class: compact',
  );
  const shown = await readPreviewContext(page);

  await page.getByTestId('feedback-send').dblclick();
  const publicId = await readReference(page);
  await page.waitForTimeout(SETTLE_MS);

  expect(posts).toHaveLength(ONE_REQUEST);
  const sent = posts[0]?.body.context ?? {};
  // The preview claims exactly what the request carries: same keys, same values, no extras.
  expect(Object.keys(sent).sort()).toEqual(Object.keys(shown).sort());
  expect(asShown(sent)).toEqual(shown);

  const token = await tokenFor(page.request, email);
  const receipt = await page.request.get(`${backendUrl()}/feedback/${publicId}/receipt`, {
    headers: bearer(token),
  });
  expect(receipt.status()).toBe(HTTP_OK);
  expect(await receipt.json()).toMatchObject({ public_id: publicId, category: 'broken' });
});

test('keyboard-only at 1280x720: report something confusing from the Map', async ({ page }) => {
  await page.setViewportSize(WIDE_VIEWPORT);
  const email = await signUp(page, 'feedback-map-confusing');
  await page.goto(`${frontendUrl()}/map`);
  await expect(page.getByRole('button', { name: 'Open Map menu' })).toBeVisible();

  const control = feedbackControl(page);
  await tabTo(page, control);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('feedback-composer-heading')).toBeFocused();

  await tabTo(page, page.getByRole('radio', { name: 'Something was confusing' }));
  await page.keyboard.press('Enter');
  await typeInto(page, 'feedback-field-summary', 'I could not tell which stage I was on');
  await typeInto(page, 'feedback-field-intent', 'Where the current stage begins');
  await typeInto(page, 'feedback-field-actual', 'Two stages looked equally highlighted');
  await typeInto(page, 'feedback-field-expected', 'One clearly marked current stage');
  await tabTo(page, page.getByRole('radio', { name: 'I could carry on' }));
  await page.keyboard.press('Enter');

  const preview = page.getByTestId('feedback-attached-preview');
  await expect(preview.getByTestId('feedback-attached-screen')).toHaveText('Screen: map.stages');
  await expect(preview.getByTestId('feedback-attached-viewport_class')).toHaveText(
    'Viewport class: expanded',
  );

  await tabTo(page, page.getByTestId('feedback-send'));
  await page.keyboard.press('Enter');
  const publicId = await readReference(page);

  const token = await tokenFor(page.request, email);
  const receipt = await page.request.get(`${backendUrl()}/feedback/${publicId}/receipt`, {
    headers: bearer(token),
  });
  expect(await receipt.json()).toMatchObject({
    public_id: publicId,
    category: 'confusing',
    impact: 'can_continue',
  });

  await tabTo(page, page.getByTestId('feedback-done'));
  await page.keyboard.press('Enter');
  await expect(feedbackControl(page)).toBeFocused();
});
