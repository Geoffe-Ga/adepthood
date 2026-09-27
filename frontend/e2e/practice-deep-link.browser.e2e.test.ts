import { expect, test } from '@playwright/test';

import { frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { adoptPractice, SEEDED_PRACTICE } from './routeWalk';

/**
 * Issue #2958 -- a stage deep link opens that stage.
 *
 * React Navigation hands a path segment to the screen as a string, while the
 * screens compare stage numbers with strict equality. Before the linking
 * config parsed `:stageNumber`, `/practice/1` showed "No practice set for this
 * stage yet." to an account whose adopted practice is stage 1 (the #2948
 * census finding), and `/course/1` rendered with no stage cover, no metadata
 * and no stage chip selected.
 *
 * Only a real page load proves this: the unit specs resolve params through the
 * same `linking` config, but only the browser takes the URL from the address
 * bar through the web linking layer to the screen and on to a real server.
 */

/** The seeded account's adopted stage, and the stage both deep links ask for. */
const LINKED_STAGE = 1;
const EMPTY_STATE = 'No practice set for this stage yet.';
/** An unselected stage pill's border (`Course.styles.ts` stagePill: 'transparent'). */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
/** Stage 1's cover names its chapter, as `map-continue-course` pins too. */
const LINKED_STAGE_CHAPTER = 'Chapter 1';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

test('a /practice and /course stage deep link opens that stage', async ({ page }) => {
  const email = await signUp(page, 'practice-deep-link');
  const token = await tokenFor(page.request, email);
  await adoptPractice(page.request, token);

  await page.goto(`${frontendUrl()}/practice/${String(LINKED_STAGE)}`);

  await expect(page.getByTestId('practice-identity-title')).toContainText(
    new RegExp(escapeRegExp(SEEDED_PRACTICE), 'iu'),
  );
  await expect(page.getByTestId('ritual-start')).toBeVisible();
  await expect(page.getByText(EMPTY_STATE)).toHaveCount(0);

  await page.goto(`${frontendUrl()}/course/${String(LINKED_STAGE)}`);

  await expect(page.getByTestId('stage-cover')).toBeVisible();
  await expect(page.getByTestId('stage-metadata')).toBeVisible();
  await expect(page.getByTestId('stage-cover')).toContainText(LINKED_STAGE_CHAPTER);
  // react-native-web emits no aria-selected for a TouchableOpacity, so the
  // selection is read from what a sighted person sees: only the selected pill
  // carries the accent border (`stagePillActive`); the rest stay transparent.
  const borderOf = (stage: number) =>
    page
      .getByTestId(`stage-pill-${String(stage)}`)
      .evaluate((pill) => getComputedStyle(pill).borderTopColor);
  await expect.poll(() => borderOf(LINKED_STAGE)).not.toBe(TRANSPARENT);
  await expect.poll(() => borderOf(LINKED_STAGE + 1)).toBe(TRANSPARENT);
});
