import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { signUp } from './journalHabitsBrowserSupport';

const PHONE = { width: 390, height: 844 } as const;
const PHONE_AT_200 = { width: 195, height: 422 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

const JOURNAL_GAIN =
  'Start your first page. With corpus sorting enabled, every eligible page not marked Intimate joins your private corpus, whether new or already written. Higher Self may draw a few passages from it for a reflection.';
const HABIT_GAIN =
  'Choose one habit. A minute a day begins the practice; you can build from there.';
const MAP_LEAD =
  'The Map is a wheel, not a ladder: its ten stages revisit different capacities, never ranking you or the stages.';
const PRACTICE_GAINS = [
  {
    key: 'presets',
    title: 'No presets here',
    body: 'Curated practices that fit this view land here, ready to try.',
  },
  {
    key: 'drafts',
    title: 'No drafts yet',
    body: 'Practices you author land here, ready to shape and use.',
  },
  {
    key: 'imported',
    title: 'Nothing imported',
    body: 'Practices shared with you will land here, ready to explore.',
  },
] as const;

interface Profile {
  label: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

const PROFILES: readonly Profile[] = [
  { label: '390x844', viewport: PHONE, deviceScaleFactor: 1 },
  { label: '390x844-200pct', viewport: PHONE_AT_200, deviceScaleFactor: 2 },
  { label: '1280x800', viewport: DESKTOP, deviceScaleFactor: 1 },
];

/** Reach a tab through the current screen's drawer, exactly as a reader does. */
async function openTab(page: Page, tab: 'Habits' | 'Practice' | 'Map'): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/u }).click();
  await page.getByRole('dialog').getByRole('button', { name: tab, exact: true }).click();
  await expect(page.getByRole('button', { name: `Open ${tab} menu` })).toBeVisible();
}

/** Copy may wrap, but no glyph or surface may clip sideways. */
async function expectReadable(surface: Locator): Promise<void> {
  await surface.scrollIntoViewIfNeeded();
  await expect(surface).toBeVisible();
  const overflow = await surface.evaluate((root) => {
    const rootBox = root.getBoundingClientRect();
    const failures: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount > 0 || !element.textContent?.trim()) continue;
      const box = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth + 1) failures.push(element.textContent.trim());
      if (box.left < rootBox.left - 1 || box.right > rootBox.right + 1) {
        failures.push(element.textContent.trim());
      }
    }
    return failures;
  });
  expect(overflow).toEqual([]);
  expect(await pageHorizontalOverflow(surface.page())).toBeLessThanOrEqual(0);
}

/**
 * Pin the pixels readers actually see instead of the inline EmptyState host,
 * whose React Native Web measurement box can collapse inside a SectionList.
 */
async function expectVisiblePracticeCluster(
  surface: Locator,
  gain: (typeof PRACTICE_GAINS)[number],
): Promise<void> {
  const failures = await surface.evaluate((root, expected) => {
    const leaves = [...root.querySelectorAll<HTMLElement>('*')].filter(
      (element) => element.childElementCount === 0,
    );
    const title = leaves.find((element) => element.textContent?.trim() === expected.title);
    const body = leaves.find((element) => element.textContent?.trim() === expected.body);
    const cta = root.querySelector<HTMLElement>(
      `[data-testid="practice-catalog-section-${expected.key}-create"]`,
    );
    const targets = { title, body, cta };
    const outsideViewport = (box: DOMRect): boolean =>
      [box.top < 0, box.left < 0, box.bottom > innerHeight, box.right > innerWidth].some(Boolean);
    const centreIsObscured = (element: HTMLElement, box: DOMRect): boolean => {
      const x = Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2));
      const hit = document.elementFromPoint(x, y);
      return hit === null || (!element.contains(hit) && !hit.contains(element));
    };
    const inspect = (name: string, element: HTMLElement | undefined | null): string[] => {
      if (!element) {
        return [`${name}: missing`];
      }
      const box = element.getBoundingClientRect();
      const problems: string[] = [];
      if (box.width <= 0 || box.height <= 0) problems.push(`${name}: empty rect`);
      if (outsideViewport(box)) {
        problems.push(
          `${name}: outside viewport (${box.left}, ${box.top}, ${box.right}, ${box.bottom})`,
        );
      }
      if (centreIsObscured(element, box)) problems.push(`${name}: centre is obscured`);
      return problems;
    };

    return Object.entries(targets).flatMap(([name, element]) => inspect(name, element));
  }, gain);
  expect(failures).toEqual([]);
}

async function pageHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function capture(
  surface: Locator,
  info: TestInfo,
  profile: string,
  name: string,
): Promise<void> {
  await surface.scrollIntoViewIfNeeded();
  await surface.screenshot({ path: info.outputPath(`${profile}-${name}.png`) });
}

/** A scrolled control is not merely visible: the pixels at its centre belong to it. */
async function expectReachable(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  expect(
    await control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === node || (hit != null && node.contains(hit));
    }),
  ).toBe(true);
}

async function inspectProfile(browser: Browser, profile: Profile, info: TestInfo): Promise<void> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await signUp(page, `empty-copy-${profile.label}`);

    const journal = page.getByTestId('journal-shelf-empty');
    await expectReachable(journal.getByText('Your journal is empty', { exact: true }));
    await expect(journal.getByText(JOURNAL_GAIN, { exact: true })).toBeVisible();
    await expect(journal.getByTestId('journal-empty-cta')).toHaveAccessibleName('Start a page');
    await expectReadable(journal);
    await capture(journal, info, profile.label, 'journal');
    await expectReachable(journal.getByTestId('journal-empty-cta'));
    await expectReachable(journal.getByTestId('journal-empty-first-prompt'));

    await openTab(page, 'Habits');
    const habits = page.getByTestId('habits-empty-state');
    await expectReachable(habits.getByText('No habits yet', { exact: true }));
    await expect(habits.getByText(HABIT_GAIN, { exact: true })).toBeVisible();
    await expect(habits.getByText(/three weeks?/iu)).toHaveCount(0);
    await expect(habits.getByText(/no pressure/iu)).toHaveCount(0);
    await expectReadable(habits);
    await capture(habits, info, profile.label, 'habits');
    await expectReachable(habits.getByTestId('habits-empty-add'));

    await openTab(page, 'Practice');
    await page.getByTestId('practice-tab-catalog').click();
    const catalog = page.getByTestId('practice-embedded-catalog');
    await expect(catalog).toBeVisible();
    await page.getByTestId('practice-catalog-search').fill('no-such-practice-3105');
    for (const gain of PRACTICE_GAINS) {
      const practice = page.getByTestId(`practice-catalog-section-${gain.key}-empty`);
      const title = practice.getByText(gain.title, { exact: true });
      const body = practice.getByText(gain.body, { exact: true });
      const cta = practice.getByTestId(`practice-catalog-section-${gain.key}-create`);
      await expectReachable(title);
      await expect(body).toBeVisible();
      await expectReadable(practice);
      await expectReachable(cta);
      await expectVisiblePracticeCluster(practice, gain);
      // The footer's React Native Web host has a collapsed measurement box while
      // its children remain visible. A locator screenshot either clips to that box
      // or re-scrolls the catalog. Capture the unchanged page viewport after the
      // simultaneous title/body/CTA assertions instead.
      await page.screenshot({ path: info.outputPath(`${profile.label}-practice-${gain.key}.png`) });
    }

    await openTab(page, 'Map');
    await page.getByRole('button', { name: 'Open Map menu' }).click();
    const drawer = page.getByTestId('map-drawer');
    const lead = drawer.getByTestId('map-drawer-lead');
    await expect(lead).toHaveText(MAP_LEAD);
    await expect(drawer.getByText(MAP_LEAD, { exact: true })).toHaveCount(1);
    await expect(lead).not.toContainText(/full|thin/iu);
    await expectReadable(drawer);
    const order = await drawer.evaluate((root) => {
      const bottom = (id: string): number =>
        root.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect().bottom ??
        0;
      const top = (id: string): number =>
        root.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? 0;
      return {
        journeyBeforeLead: bottom('map-drawer-journey') <= top('map-drawer-lead') + 1,
        leadBeforeFirstStage: bottom('map-drawer-lead') <= top('map-drawer-stage-1') + 1,
      };
    });
    expect(order).toEqual({ journeyBeforeLead: true, leadBeforeFirstStage: true });
    await capture(drawer, info, profile.label, 'map-drawer');
  } finally {
    await context.close();
  }
}

test('the four first-use gains stay readable from phone through desktop and 200% zoom', async ({
  browser,
}, info) => {
  for (const profile of PROFILES) await inspectProfile(browser, profile, info);
});
