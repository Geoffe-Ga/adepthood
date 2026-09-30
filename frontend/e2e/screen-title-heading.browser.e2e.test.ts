import { expect, test, type Page } from '@playwright/test';

import { backendUrl, frontendUrl, signUp } from './journalHabitsBrowserSupport';
import { openRoute, ROUTES, VIEWPORTS, viewportLabel, type Route } from './routeWalk';

/**
 * Navigation owns the screen title (#2962): on every screen whose stack header
 * paints the title, a screen reader finds exactly ONE heading by that name --
 * the stack header's -- never a second one in the body.
 *
 * Only a browser can say this. Jest renders a screen with no navigator around
 * it, so it can see the body's headings but not the stack header's; here the
 * whole page is in the accessibility tree, and react-native-web renders both
 * the stack title (`role="heading"`) and any in-body `accessibilityRole="header"`
 * as `h1`, so a body that repeats the title -- painted, or as an invisible
 * labelled header -- counts twice.
 *
 * Six of the eight screens are reached the way the text census reaches them
 * (`routeWalk.ts`). Promoted quotes opens from the Journal drawer. The beta
 * feedback inbox is reached through its Settings row, which appears only once
 * `GET /admin/capabilities` answers 200; a lane account is never an operator,
 * so that one answer is fulfilled in the browser. The screen's header does not
 * depend on it -- the inbox paints the same header for an operator and for
 * anyone else -- and nothing else is stubbed.
 */

interface TitledRoute {
  route: Route;
  /** The stack header's title for this screen, as `RootStack.tsx` sets it. */
  title: string;
}

/** Each walked screen whose body used to repeat its stack title, by route name. */
const WALKED_TITLES: Readonly<Record<string, string>> = {
  Settings: 'Settings',
  VoiceDrafts: 'Voice drafts',
  TimezoneSettings: 'Time zone',
  ExportData: 'Export my data',
  DeleteAccount: 'Delete account',
  SupportCare: 'Support & care',
};

const goTo = async (page: Page, path: string): Promise<void> => {
  await page.goto(`${frontendUrl()}${path}`);
};

const PROMOTED_QUOTES: TitledRoute = {
  title: 'Promoted quotes',
  route: {
    name: 'PromotedQuotes',
    label: 'Promoted quotes',
    anchor: 'promoted-quotes-screen',
    open: async (page) => {
      await goTo(page, '/journal');
      await page.getByRole('button', { name: 'Open Journal menu' }).click();
      await page.getByRole('dialog').getByTestId('journal-drawer-promoted-quotes').click();
    },
  },
};

const FEEDBACK_INBOX: TitledRoute = {
  title: 'Beta feedback inbox',
  route: {
    name: 'AdminFeedback',
    label: 'Beta feedback inbox',
    anchor: 'admin-feedback-screen',
    open: async (page) => {
      await goTo(page, '/settings');
      await page.getByTestId('settings-row-feedback-inbox').click();
    },
  },
};

function titledRoutes(): TitledRoute[] {
  const walked = ROUTES.filter((route) => route.name in WALKED_TITLES).map((route) => ({
    route,
    title: WALKED_TITLES[route.name] as string,
  }));
  return [...walked, PROMOTED_QUOTES, FEEDBACK_INBOX];
}

test('each screen whose stack header paints its title has exactly one heading by that name, at both viewports', async ({
  page,
}) => {
  const routes = titledRoutes();
  // Every walked screen named above must still be in the walk.
  expect(routes.map(({ route }) => route.name).sort()).toEqual(
    [...Object.keys(WALKED_TITLES), 'AdminFeedback', 'PromotedQuotes'].sort(),
  );
  await signUp(page, 'screen-title-2962');
  await page.route(`${backendUrl()}/admin/capabilities`, (route) =>
    route.fulfill({ json: { feedback_triage: true } }),
  );

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const { route, title } of routes) {
      await openRoute(page, route, { shareToken: '' });
      await expect
        .soft(
          page.getByRole('heading', { name: title, exact: true }),
          `${viewportLabel(viewport)} ${route.label}: headings named "${title}"`,
        )
        .toHaveCount(1);
    }
  }
});
