import {
  expect,
  type APIRequestContext,
  type Page,
  type Response as PlaywrightResponse,
} from '@playwright/test';

import { backendUrl, bearer, frontendUrl, isoDaysAgo } from './journalHabitsBrowserSupport';

/**
 * Every screen the app can reach, and how to reach each one from a fresh
 * page load -- the route walk `text-order.browser.e2e.test.ts` drives and
 * that #2860's action-row sweep is meant to extend rather than repeat.
 *
 * Inventory: the five tab destinations `destinations.ts` registers (Journal,
 * Habits, Practice, Course, Map -- there is no Today tab) plus every
 * `RootStack.tsx` screen a lane account can open without an admin role, a
 * camera or a paid call. Only the tabs, Settings, ApiKeySettings and
 * SharePreview have web paths (`navigation/linking.ts`); the rest are reached the
 * way the app reaches them, through Settings rows, the screen drawers and the
 * shelf's own controls. Every `open` starts with a `page.goto`, so the routes
 * are order-independent and a screen that fails to open cannot strand the
 * ones after it.
 *
 * Habits, Practice and Course are ring-gated (`destinations.ts`); a new
 * account has every ring on (`useDepthPreferencesStore` INITIAL_STATE and the
 * server default), so nothing here toggles a depth. Journal and Map always
 * render.
 */

/** The phone profile every screen is built for first. */
export const NARROW_VIEWPORT = { width: 390, height: 844 } as const;
/** The desktop profile; `playwright.config.ts` pins the same one. */
export const WIDE_VIEWPORT = { width: 1280, height: 720 } as const;
export const VIEWPORTS = [NARROW_VIEWPORT, WIDE_VIEWPORT] as const;

export type Viewport = (typeof VIEWPORTS)[number];

/** `390x844`-shaped, as the artifact folders and summary lines spell a viewport. */
export function viewportLabel(viewport: Viewport): string {
  return `${String(viewport.width)}x${String(viewport.height)}`;
}

/** What the seed left behind that a route needs in order to open. */
export interface WalkContext {
  /** A share-link token minted on the seeded practice (`SharePreview`). */
  shareToken: string;
}

export interface Route {
  /** The `RootStack` / tab name; also the artifact file stem. */
  name: string;
  /** How the summary table names the screen. */
  label: string;
  /** The root (or nearest unconditional) `testID` the walk waits on before measuring. */
  anchor: string;
  open: (page: Page, context: WalkContext) => Promise<void>;
}

export interface SkippedRoute {
  name: string;
  reason: string;
}

/** Screens or actions the walk deliberately never opens or presses. */
export const SKIPPED: readonly SkippedRoute[] = [
  {
    name: 'AdminFeedback',
    reason: 'admin capability gate: GET /admin/capabilities answers 403 for a lane account',
  },
  {
    name: 'JournalPhotograph',
    reason:
      'headless Chromium has no camera or picker to feed it, and a page it did read ' +
      'would be a paid transcription',
  },
  {
    name: 'Get resonance (JournalEntry)',
    reason: 'a press-triggered LLM pass; the walk opens the entry and presses nothing',
  },
  {
    name: 'Voice transcription (VoiceDrafts)',
    reason: 'a paid transcription; the shelf is censused, no draft is transcribed',
  },
];

const SEEDED_HABITS = [
  'High Flow Activity',
  'Meditation',
  'Movement',
  'Reading',
  'Journalling',
  'Cold Exposure',
  'Sleep Hygiene',
  'Time in Nature',
  'Gratitude Practice',
  'Deep Work',
] as const;
/** The canonical stage-1 preset the Practice player opens on. */
export const SEEDED_PRACTICE = '5-4-3-2-1 grounding';
const ENTRY_STAGE = 1;
/**
 * Every seeded habit starts today. The habits' earliest `start_date` is what
 * the app takes as the program anchor (`habitManager.ts`), and the Practice
 * and Course tabs derive their stage from that anchor -- a habit dated months
 * back would carry a fresh account into a later stage, where the stage-1
 * adoption below reads as "No practice yet".
 */
const HABIT_STARTED_DAYS_AGO = 0;
const HABIT_ICON = '\u2605';
const HABIT_ENERGY_COST = 2;
const HABIT_ENERGY_RETURN = 4;
const SEEDED_ENTRY = {
  title: 'A first page',
  message: 'Wrote a few lines before the day began, and read them back.',
} as const;

interface CatalogPractice {
  id: number;
  name: string;
}

async function seedHabit(request: APIRequestContext, token: string, name: string): Promise<void> {
  const created = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name,
      icon: HABIT_ICON,
      start_date: isoDaysAgo(HABIT_STARTED_DAYS_AGO),
      energy_cost: HABIT_ENERGY_COST,
      energy_return: HABIT_ENERGY_RETURN,
    },
  });
  if (!created.ok()) throw new Error(`seeding "${name}" failed with ${String(created.status())}`);
}

export async function adoptPractice(request: APIRequestContext, token: string): Promise<number> {
  const listed = await request.get(
    `${backendUrl()}/practices/?stage_number=${String(ENTRY_STAGE)}`,
    {
      headers: bearer(token),
    },
  );
  if (!listed.ok()) throw new Error(`listing the stage-${String(ENTRY_STAGE)} catalog failed`);
  const catalog = (await listed.json()) as CatalogPractice[];
  const preset = catalog.find((practice) => practice.name === SEEDED_PRACTICE);
  if (!preset) throw new Error(`"${SEEDED_PRACTICE}" is not in the stage catalog`);
  const adopted = await request.post(`${backendUrl()}/user-practices/`, {
    headers: bearer(token),
    data: { practice_id: preset.id, stage_number: ENTRY_STAGE },
  });
  if (!adopted.ok()) throw new Error(`adopting "${SEEDED_PRACTICE}" failed`);
  return preset.id;
}

async function mintShareLink(
  request: APIRequestContext,
  token: string,
  practiceId: number,
): Promise<string> {
  const minted = await request.post(`${backendUrl()}/practices/${String(practiceId)}/share-link`, {
    headers: bearer(token),
    data: {},
  });
  if (!minted.ok()) throw new Error(`minting a share link failed with ${String(minted.status())}`);
  return ((await minted.json()) as { token: string }).token;
}

/**
 * Fill the fresh account over HTTP so no shelf is empty: a full page of habits,
 * one adopted practice (which is what makes `PracticeDetail` and `SharePreview`
 * exist at all) and one journal entry. The same public endpoints the app uses;
 * nothing is stubbed and no provider is called.
 */
export async function seedCensusAccount(
  request: APIRequestContext,
  token: string,
): Promise<WalkContext> {
  for (const name of SEEDED_HABITS) await seedHabit(request, token, name);
  const practiceId = await adoptPractice(request, token);
  const entry = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: SEEDED_ENTRY,
  });
  if (!entry.ok()) throw new Error(`seeding a journal entry failed with ${String(entry.status())}`);
  return { shareToken: await mintShareLink(request, token, practiceId) };
}

/**
 * What `GET /vault/connection` answers a provider-managed vault: connected,
 * with no address an account may see. The app reads it as unknown, which keeps
 * the seeding picker (#3017).
 */
const MANAGED_VAULT_CONNECTION = { connected: true, vault_url: null } as const;

const goTo = async (page: Page, path: string): Promise<void> => {
  await page.goto(`${frontendUrl()}${path}`);
};

/** Open a screen drawer and press one of its rows. */
async function throughDrawer(page: Page, screen: string, rowTestId: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${screen} menu` }).click();
  await page.getByRole('dialog').getByTestId(rowTestId).click();
}

/** Open Settings and press one of its rows. */
async function throughSettings(page: Page, rowTestId: string): Promise<void> {
  await goTo(page, '/settings');
  await page.getByTestId(rowTestId).click();
}

/**
 * The Practice tab at its bare path, which derives the stage from the program
 * anchor (the seed keeps it at stage 1) -- kept bare so the census still walks
 * that derivation. A stage asked for by path (`/practice/1`) is pinned
 * separately by `practice-deep-link.browser.e2e.test.ts` (#2958).
 */
const PRACTICE_PATH = '/practice';

const tab = (name: string, label: string, path: string, anchor: string): Route => ({
  name,
  label,
  anchor,
  open: (page) => goTo(page, path),
});

const settingsRow = (name: string, label: string, row: string, anchor: string): Route => ({
  name,
  label,
  anchor,
  open: (page) => throughSettings(page, `settings-row-${row}`),
});

export const ROUTES: readonly Route[] = [
  tab('Journal', 'Journal shelf', '/journal', 'journal-shelf'),
  tab('Habits', 'Habits grid', '/habits', 'habits-list'),
  tab('Practice', 'Practice player', PRACTICE_PATH, 'practice-screen'),
  tab('Course', 'Course reader', '/course', 'content-list'),
  tab('Map', 'Map', '/map', 'journey-read'),
  {
    name: 'JournalEntry',
    label: 'Journal entry',
    anchor: 'journal-screen',
    open: async (page) => {
      await goTo(page, '/journal');
      await page.getByTestId('journal-new-entry').click();
    },
  },
  {
    name: 'VoiceDrafts',
    label: 'Voice drafts shelf',
    anchor: 'voice-drafts-shelf',
    open: async (page) => {
      await goTo(page, '/journal');
      await throughDrawer(page, 'Journal', 'journal-drawer-voice-drafts');
    },
  },
  tab('Settings', 'Settings hub', '/settings', 'settings-hub-screen'),
  tab('ApiKeySettings', 'API key settings', '/api-key-settings', 'api-key-settings-screen'),
  settingsRow('TimezoneSettings', 'Timezone settings', 'timezone', 'timezone-settings-screen'),
  settingsRow('VaultSettings', 'Vault settings', 'vault', 'vault-settings-screen'),
  {
    name: 'VaultActivation',
    label: 'Managed vault activation',
    anchor: 'private-vault-activation-screen',
    open: async (page) => {
      await throughSettings(page, 'settings-row-vault');
      await page.getByTestId('open-vault-activation').click();
    },
  },
  {
    // The walking account has no vault, so since #3017 the hub's seed row
    // opens Where your corpus lives and the screen shows an invitation in
    // place of its picker. To keep measuring the picker, the vault read is
    // answered with the managed shape (connected, no address -- which reads
    // unknown) for this one open only: the real response is still fetched so
    // its CORS headers carry over, the hub's read and the screen's own read are
    // each awaited, and the pin is removed in `finally` so nothing leaks to
    // later routes or viewports. The gate itself is covered unstubbed by
    // corpus-vault-first.browser.e2e.test.ts.
    name: 'SeedCorpus',
    label: 'Seed corpus',
    anchor: 'seed-corpus-screen',
    open: async (page) => {
      const pattern = `${backendUrl()}/vault/connection`;
      const isVaultRead = (response: PlaywrightResponse): boolean =>
        response.url() === pattern && response.request().method() === 'GET';
      await page.route(pattern, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        return route.fulfill({ response, json: MANAGED_VAULT_CONNECTION });
      });
      try {
        const hubRead = page.waitForResponse(isVaultRead);
        await goTo(page, '/settings');
        await hubRead;
        const screenRead = page.waitForResponse(isVaultRead);
        await page.getByTestId('settings-row-seed-corpus').click();
        await screenRead;
      } finally {
        await page.unroute(pattern);
      }
    },
  },
  settingsRow('CorpusConsent', 'Corpus consent', 'corpus-consent', 'corpus-consent-screen'),
  settingsRow('ExportData', 'Export data', 'export-data', 'export-data-screen'),
  // Viewed only: nothing here fills the confirmation or presses delete.
  settingsRow('DeleteAccount', 'Delete account', 'delete-account', 'delete-account-screen'),
  settingsRow('SupportCare', 'Support and care', 'support', 'support-care-screen'),
  {
    name: 'Feedback',
    label: 'Feedback composer',
    anchor: 'feedback-composer-screen',
    open: async (page) => {
      await goTo(page, '/journal');
      // The header control shortens its visible label on a phone; its
      // accessible name does not, and only the mounted tab's header is visible.
      await page.getByRole('button', { name: 'Send feedback' }).filter({ visible: true }).click();
    },
  },
  {
    name: 'CreatePractice',
    label: 'Create practice wizard',
    anchor: 'create-practice-wizard',
    open: async (page) => {
      await goTo(page, PRACTICE_PATH);
      await throughDrawer(page, 'Practice', 'practice-drawer-create');
    },
  },
  {
    name: 'Catalog',
    label: 'Practice catalog',
    anchor: 'practice-catalog-screen',
    open: async (page) => {
      await goTo(page, PRACTICE_PATH);
      await throughDrawer(page, 'Practice', 'practice-drawer-create');
      await page.getByTestId('create-practice-from-preset').click();
    },
  },
  {
    name: 'PracticeDetail',
    label: 'Practice details',
    anchor: 'practice-detail-screen',
    open: async (page) => {
      await goTo(page, PRACTICE_PATH);
      await throughDrawer(page, 'Practice', 'practice-drawer-details');
    },
  },
  {
    name: 'SharePreview',
    label: 'Shared practice preview',
    anchor: 'share-preview-screen',
    open: (page, context) => goTo(page, `/practices/share/${context.shareToken}`),
  },
];

/**
 * Open one route and wait until its anchor is visible, so the caller measures
 * a screen that has finished arriving rather than the one before it.
 */
export async function openRoute(page: Page, route: Route, context: WalkContext): Promise<void> {
  await route.open(page, context);
  await expect(page.getByTestId(route.anchor).first()).toBeVisible();
}
