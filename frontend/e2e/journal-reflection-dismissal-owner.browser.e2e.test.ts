import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

import { expectTextWithinViewport } from './declineOwnershipBrowserSupport';
import {
  backendUrl,
  bearer,
  logInInPlace,
  sessionFor,
  setProgramAnchorDaysAgo,
  signUp,
} from './journalHabitsBrowserSupport';

/**
 * Due-review dismissal is the fourth account-owned decline store (#3289,
 * #3321). The server never hears about a "Not now": `GET /reflections/due`
 * keeps naming the scope, and only this device's account-scoped flag
 * (`reflectionDismissalStorage.ts`) sets the card aside.
 *
 * Both accounts are rewound to the same program day, so the server names the
 * SAME scope key for each. That collision is the point: an unscoped flag, or a
 * late outgoing read applied after the switch, would let A's decline hide B's
 * independently due card.
 */

/** Pin the browser to the zone the rewind counts in (see the section-review spec). */
const ACCOUNT_TIMEZONE = 'UTC';
/** Elapsed day 6 is program day 7: the seventh day of stage 1 closes week 1. */
const WEEK_ONE_CLOSE_DAYS_AGO = 6;
const WEEK_LEVEL = 'week';
const WEEK_ONE_SCOPE = 'c1:w1';
const DISMISS_PREFIX = '@adepthood/reflection_dismissed:';
const UNSCOPED_KEY = `${DISMISS_PREFIX}${WEEK_ONE_SCOPE}`;
const DEVICE_OWNER_KEY = '@adepthood/device_owner';
const LEGACY_OWNER_KEY = '@adepthood/legacy_decline_owner';
/** An upgraded device whose pre-namespacing flags belong to no known account. */
const UNKNOWN_LEGACY_OWNER = JSON.stringify({ version: 1, owner: null });
const DUE_PATH = '/reflections/due';
const MORNING_PAGES = 'Begin a page of morning pages';
const TEXT_SCALE = 2;
const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const VIEWPORT_HEIGHT = 844;
const STORY_BUDGET_MS = 150_000;
const CALENDAR_EDGE =
  'calendar edge: the rewind and this read straddled a local midnight, so a different day is due';

test.use({ timezoneId: ACCOUNT_TIMEZONE });

interface DueResponse {
  due: { level: string; scope_key: string } | null;
}

/** One `/reflections*` request the running app made, and whose credential carried it. */
interface ReflectionRequest {
  method: string;
  path: string;
  owner: number | null;
}

/** The `sub` claim of a bearer credential, as the account it names. */
function credentialOwner(authorization: string | undefined): number | null {
  const payload = authorization?.replace(/^Bearer /u, '').split('.')[1];
  if (payload === undefined) return null;
  const { sub } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: unknown;
  };
  return sub === undefined ? null : Number(sub);
}

/** Assert the server, not the shelf, still names week 1 as due for this account. */
async function expectServerDue(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.get(`${backendUrl()}${DUE_PATH}`, { headers: bearer(token) });
  expect(response.ok()).toBe(true);
  const { due } = (await response.json()) as DueResponse;
  expect(due, CALENDAR_EDGE).toEqual(
    expect.objectContaining({ level: WEEK_LEVEL, scope_key: WEEK_ONE_SCOPE }),
  );
}

function band(page: Page): Locator {
  return page.getByTestId('journal-reflection-band');
}

function dismissControl(page: Page): Locator {
  return page.getByRole('button', { name: 'Not now, set this reflection invitation aside' });
}

/** The shelf settled on the daily page: the review was set aside, not still loading. */
async function expectSetAside(page: Page): Promise<void> {
  await expect(morningPages(page)).toBeVisible();
  await expect(band(page)).toHaveCount(0);
}

/** The shelf settled on the due review. */
async function expectOffered(page: Page): Promise<void> {
  await expect(band(page)).toBeVisible();
  await expect(morningPages(page)).toHaveCount(0);
}

async function deviceOwner(page: Page): Promise<number> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), DEVICE_OWNER_KEY);
  const owner = Number(raw);
  expect(Number.isInteger(owner) && owner > 0, `owner stamp ${raw}`).toBe(true);
  return owner;
}

/** Every reflection-dismissal record on this device, key to value. */
async function dismissalRecords(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate((prefix) => {
    const records: Record<string, string | null> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) records[key] = localStorage.getItem(key);
    }
    return records;
  }, DISMISS_PREFIX);
}

/** Leave the running app's account through Settings, staying in the same SPA. */
async function switchAccount(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Open settings' }).filter({ visible: true }).click();
  await page.getByTestId('settings-row-logout').click();
  await page.getByRole('link', { name: 'Go to log-in screen' }).click();
  await logInInPlace(page, email);
  await expectSameRunningApp(page);
}

/** Two frames, so a delivered response has had its chance to re-render the shelf. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Double every text leaf in the band, the targeted enlarged-text check. */
async function enlargeBandText(page: Page): Promise<void> {
  await page
    .getByTestId('journal-reflection-band')
    .locator('..')
    .evaluate((root, scale) => {
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if (element.childElementCount || !element.textContent?.trim()) continue;
        const style = getComputedStyle(element);
        element.style.fontSize = `${parseFloat(style.fontSize) * scale}px`;
        element.style.lineHeight = `${parseFloat(style.lineHeight) * scale}px`;
      }
    }, TEXT_SCALE);
}

/** The decline is reached from the open area by a real Tab, then shown whole. */
async function expectDeclineReachable(page: Page): Promise<void> {
  await band(page).focus();
  await expect(band(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dismissControl(page)).toBeFocused();
  await dismissControl(page).click({ trial: true });
  await expectTextWithinViewport(page, 'journal-reflection-band');
  const box = await dismissControl(page).boundingBox();
  expect(box).not.toBeNull();
  const width = page.viewportSize()?.width ?? 0;
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
}

interface Accounts {
  outgoingEmail: string;
  incomingEmail: string;
  outgoingToken: string;
}

/** B in its own context, then A in `page`; both rewound so week 1 is due for each. */
async function arrangeAccounts(browser: Browser, page: Page): Promise<Accounts> {
  const otherContext = await browser.newContext({ timezoneId: ACCOUNT_TIMEZONE });
  const incomingEmail = await signUp(await otherContext.newPage(), 'reflection-owner-b');
  await otherContext.close();
  setProgramAnchorDaysAgo(incomingEmail, WEEK_ONE_CLOSE_DAYS_AGO);
  const outgoingEmail = await signUp(page, 'reflection-owner-a');
  setProgramAnchorDaysAgo(outgoingEmail, WEEK_ONE_CLOSE_DAYS_AGO);
  const outgoingToken = (await sessionFor(page.request, outgoingEmail)).token;
  await expectServerDue(page.request, outgoingToken);
  await expectServerDue(page.request, (await sessionFor(page.request, incomingEmail)).token);
  return { outgoingEmail, incomingEmail, outgoingToken };
}

/** A real due read of `owner`'s, answered by the server and held from the app. */
interface HeldRead {
  /** Resolves once the server has answered the held read. */
  fetched: Promise<void>;
  /** Deliver the held answer, and resolve once the app has received it. */
  deliver: () => Promise<void>;
}

/**
 * Hold the first due read `owner` sends from now on. The server answers it for
 * real; only the delivery to the app waits. Every other request goes through.
 */
async function holdNextDueRead(page: Page, owner: number): Promise<HeldRead> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetched!: () => void;
  const serverRead = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  let heldCredential = '';
  await page.route(
    (url) => url.pathname === DUE_PATH,
    async (route) => {
      const authorization = route.request().headers().authorization ?? '';
      if (heldCredential !== '' || credentialOwner(authorization) !== owner) {
        await route.continue();
      } else {
        heldCredential = authorization;
        const response = await route.fetch();
        const { due } = (await response.json()) as DueResponse;
        expect(due?.scope_key).toBe(WEEK_ONE_SCOPE);
        fetched();
        await held;
        await route.fulfill({ response });
      }
    },
  );
  return {
    fetched: serverRead,
    deliver: async () => {
      const delivered = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === DUE_PATH &&
          r.request().headers().authorization === heldCredential,
      );
      release();
      await (await delivered).finished();
      await settleFrames(page);
    },
  };
}

/** Set A's due card aside through the real control, keyboard on phone, pointer on desktop. */
async function setAsideWith(page: Page, width: number): Promise<void> {
  if (width === PHONE_WIDTH) {
    await band(page).focus();
    await page.keyboard.press('Tab');
    await expect(dismissControl(page)).toBeFocused();
    await page.keyboard.press('Enter');
  } else {
    await dismissControl(page).click();
  }
  await expectSetAside(page);
}

/** Photograph the shelf's primary slot centred, clear of the scroller's edge fade. */
async function shoot(page: Page, slot: Locator, path: string): Promise<void> {
  await slot.evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
  });
  await page.screenshot({ path });
}

function morningPages(page: Page): Locator {
  return page.getByRole('button', { name: MORNING_PAGES });
}

function markRunningApp(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.documentElement.dataset.reflectionWitness = 'same-running-app';
  });
}

async function expectSameRunningApp(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-reflection-witness', 'same-running-app');
}

for (const width of [PHONE_WIDTH, DESKTOP_WIDTH]) {
  test(`a set-aside review belongs to its account across reload, switch and ABA at ${width}px`, async ({
    browser,
    page,
  }, testInfo) => {
    // Two sign-ups, three in-place sign-ins, three reloads and a held read.
    test.setTimeout(STORY_BUDGET_MS);
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const { outgoingEmail, incomingEmail, outgoingToken } = await arrangeAccounts(browser, page);

    const requests: ReflectionRequest[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/reflections'))
        requests.push({
          method: request.method(),
          path,
          owner: credentialOwner(request.headers().authorization),
        });
    });

    // A: the real due card, checked at normal and doubled text, then set aside.
    await page.reload();
    await expectOffered(page);
    const ownerA = await deviceOwner(page);
    expect(await dismissalRecords(page)).toEqual({});
    await expectDeclineReachable(page);
    await shoot(page, dismissControl(page), testInfo.outputPath(`a-due-${width}.png`));
    await enlargeBandText(page);
    await expectDeclineReachable(page);
    await shoot(page, dismissControl(page), testInfo.outputPath(`a-due-200-${width}.png`));
    await setAsideWith(page, width);
    await expect
      .poll(() => dismissalRecords(page))
      .toEqual({ [`${UNSCOPED_KEY}#u${ownerA}`]: 'true' });
    await shoot(page, morningPages(page), testInfo.outputPath(`a-set-aside-${width}.png`));

    // Reload: the server still names week 1; only this account's flag declines it.
    const reloadRead = page.waitForResponse((r) => new URL(r.url()).pathname === DUE_PATH);
    await page.reload();
    await (await reloadRead).finished();
    await expectSetAside(page);
    await expectServerDue(page.request, outgoingToken);

    // An upgraded device's pre-namespacing flag for the same scope, owner unknown.
    await page.evaluate(
      ([unscoped, legacyKey, legacyValue]) => {
        localStorage.setItem(unscoped, 'true');
        localStorage.setItem(legacyKey, legacyValue);
      },
      [UNSCOPED_KEY, LEGACY_OWNER_KEY, UNKNOWN_LEGACY_OWNER] as const,
    );

    // Hold A's next real due read across the replacement by B.
    const held = await holdNextDueRead(page, ownerA);
    await page.reload();
    await markRunningApp(page);
    await held.fetched;
    await switchAccount(page, incomingEmail);
    const ownerB = await deviceOwner(page);
    expect(ownerB).not.toBe(ownerA);
    await expectOffered(page);
    await held.deliver();
    // A's late answer neither hides B's card nor re-decides it.
    await expectOffered(page);
    await expectDeclineReachable(page);
    // Unknown legacy ownership stays unassigned: B neither inherits nor migrates it.
    expect(await dismissalRecords(page)).toEqual({
      [UNSCOPED_KEY]: 'true',
      [`${UNSCOPED_KEY}#u${ownerA}`]: 'true',
    });
    expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_OWNER_KEY)).toBe(
      UNKNOWN_LEGACY_OWNER,
    );
    await shoot(page, dismissControl(page), testInfo.outputPath(`b-due-after-held-a-${width}.png`));
    await enlargeBandText(page);
    await expectDeclineReachable(page);
    await shoot(
      page,
      dismissControl(page),
      testInfo.outputPath(`b-due-after-held-a-200-${width}.png`),
    );

    // Same-owner control: B's own undeclined review survives B's reload.
    await page.reload();
    await expectOffered(page);
    await markRunningApp(page);

    // A, B, A: the original account's answer is retained.
    await switchAccount(page, outgoingEmail);
    expect(await deviceOwner(page)).toBe(ownerA);
    await expectSetAside(page);
    await expectServerDue(page.request, outgoingToken);
    expect(await dismissalRecords(page)).toEqual({
      [UNSCOPED_KEY]: 'true',
      [`${UNSCOPED_KEY}#u${ownerA}`]: 'true',
    });
    await shoot(page, morningPages(page), testInfo.outputPath(`a-returned-${width}.png`));

    // The wire: every reflection request was a due read, and each account read its own.
    expect(new Set(requests.map(({ method, path }) => `${method} ${path}`))).toEqual(
      new Set([`GET ${DUE_PATH}`]),
    );
    expect(new Set(requests.map(({ owner }) => owner))).toEqual(new Set([ownerA, ownerB]));
  });
}
