import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type Page, type Request } from '@playwright/test';

import { completionsOf, readHabit } from './dayBoundaryBrowserSupport';
import {
  backendUrl,
  bearer,
  frontendUrl,
  openHabits,
  seedHabit,
  sessionFor,
  signUp,
} from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

/**
 * #2547: a device that still holds one account's cache is signed into by a
 * second account without anyone logging out -- and the second account inherits
 * nothing.
 *
 * The leak this guards is a row on the device, not a row on the server, so the
 * spec runs the real app in a real browser, where react-native-web keeps
 * AsyncStorage (and, because `expo-secure-store` has no web backing, the BYOK
 * key too) in `localStorage`. Account A is given real device state through the
 * app itself: its habits cached, a check-in queued because its POST failed at
 * the browser, and an API key saved through the settings screen.
 *
 * The door that skips logout is the one the app really has: a session that ran
 * out. The page clock is moved past the token's lifetime and the app cold
 * starts; bootstrap drops the expired token without wiping anything (the user
 * did not ask to leave), and the device is on the log-in screen with A's cache
 * still on disk. From there account B comes in through the password-reset flow
 * the journey names: Forgot password, the link out of B's captured email, Set
 * Password -- `confirmPasswordReset`, which signs in through
 * `applyAuthResponse`.
 *
 * Then the device is read back three ways: what B's screens show, what B's
 * requests carry on the wire, and what is left in storage.
 */

/** Mirrors `routers/auth._TOKEN_TTL`: how long a session token lives. */
const TOKEN_LIFETIME_DAYS = 30;
/** One day past the token's lifetime, so the stored session reads as expired. */
const PAST_TOKEN_LIFETIME_DAYS = TOKEN_LIFETIME_DAYS + 1;
const MS_PER_DAY = 86_400_000;

/** Long enough for a lost-network POST's retries to give up and queue it. */
const JOURNEY_TIMEOUT_MS = 120_000;
/** A window in which a late replay of A's queue would have been sent. */
const QUIET_WINDOW_MS = 1_500;

const OUTGOING_HABIT = 'Outgoing account dawn sit';
const INCOMING_HABIT = 'Incoming account river walk';
const INCOMING_RESET_PHRASE = 'Incoming-account-reset-passphrase';

const READABLE_PAGE =
  'The kettle ticked as it cooled. I watched the steam thin out and let the ' +
  'morning arrive without asking anything of it.';

/** `userScope.DEVICE_OWNER_KEY`: the unscoped stamp of whose caches this device holds. */
const DEVICE_OWNER_KEY = '@adepthood/device_owner';
/** `authStorage`'s session key, which secureStringStore keeps in localStorage on web. */
const TOKEN_KEY = 'adepthood_auth_token'; // pragma: allowlist secret
/** `habitStorage.HABITS_KEY_BASE`, scoped per account with `#u<id>`. */
const HABITS_KEY_BASE = '@adepthood/habits';
/** `habitStorage.PENDING_CHECKINS_KEY_BASE`, scoped per account with `#u<id>`. */
const PENDING_KEY_BASE = '@adepthood/pending_checkins';
/** `llmKeyStorage.LLM_API_KEY_STORAGE_KEY`: unscoped, so only the wipe can clear it. */
const LLM_KEY_STORAGE_KEY = 'adepthood_llm_api_key'; // pragma: allowlist secret
/** `userScope.SCOPE_MARKER`. */
const SCOPE_MARKER = '#u';

const LLM_KEY_HEADER = 'x-llm-api-key'; // pragma: allowlist secret
const KEY_ENTROPY_BYTES = 24;
/** Non-transient and neither 401 (token refresh) nor 402 (refill invitation). */
const CONTROL_REFUSAL_STATUS = 422;
const HTTP_ACCEPTED = 202;
/** Close the goal sheet by its backdrop, tapped clear of the sheet itself. */
const BACKDROP_CORNER = { x: 4, y: 4 };

const RESET_SUBJECT = 'Reset your Adepthood password';
const RESET_PATH = '/reset-password?token=';
const DEMO_COST = 'Demo — not a real reflection. No Adepthood wallet charge.';
const OFFLINE_TOAST =
  "You're offline — check-in saved on this device. It will sync when you reconnect.";

/** A queued check-in as the device stores it (`habitStorage.PendingCheckIn`). */
interface QueuedCheckIn {
  goal_id: number;
  operation_id?: string;
}

/** One request this browser sent, as the wire carried it. */
interface SentRequest {
  method: string;
  path: string;
  authorization: string | null;
  idempotencyKey: string | null;
  llmKey: string | null;
}

/** Every request this page sends from now on, headers and all. */
function recordRequests(page: Page): SentRequest[] {
  const sent: SentRequest[] = [];
  page.on('request', (request: Request) => {
    const headers = request.headers();
    sent.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      authorization: headers.authorization ?? null,
      idempotencyKey: headers['idempotency-key'] ?? null,
      llmKey: headers[LLM_KEY_HEADER] ?? null,
    });
  });
  return sent;
}

/** One `localStorage` row, raw, or null when the device holds none. */
async function deviceRow(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

/** The account the device-owner stamp names. */
async function deviceOwner(page: Page): Promise<string> {
  const owner = await deviceRow(page, DEVICE_OWNER_KEY);
  if (owner === null) throw new Error('the device has no owner stamp');
  return owner;
}

function scoped(base: string, owner: string): string {
  return `${base}${SCOPE_MARKER}${owner}`;
}

/** A well-formed key that exists only on this device and reaches no provider. */
function deviceOnlyKey(): string {
  return `sk-switch-${randomBytes(KEY_ENTROPY_BYTES).toString('hex')}`;
}

/** Save a key through the same screen a writer uses. */
async function storeApiKey(page: Page, key: string): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

/** A finished page for `token`'s account, written out of band. */
async function writeFinishedPage(page: Page, token: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The kettle', message: READABLE_PAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  return entryId;
}

/** The reset link's token, read out of the newest reset mail `email` was sent. */
function mailedResetToken(email: string): string | null {
  const state = readLaneState();
  if (state === null) throw new Error('the e2e lane wrote no state file; no mail to read');
  if (!existsSync(state.emailCaptureFile)) return null;
  const prefix = `${state.webBaseUrl}${RESET_PATH}`;
  const mail = readFileSync(state.emailCaptureFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { to: string; subject: string; body: string })
    .filter((message) => message.to === email && message.subject === RESET_SUBJECT)
    .at(-1);
  if (mail === undefined) return null;
  const start = mail.body.indexOf(prefix);
  if (start === -1) throw new Error(`the reset mail carries no "${prefix}" link`);
  return mail.body.slice(start + prefix.length).split(/\s/u)[0] ?? null;
}

test('a sign-in over a lapsed session purges the previous account from the device', async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  await page.clock.install();

  // B exists on the server before the device ever sees it, with a habit and a
  // finished page of its own.
  const otherContext = await browser.newContext();
  const incomingEmail = await signUp(await otherContext.newPage(), 'account-switch-incoming');
  await otherContext.close();
  const incoming = await sessionFor(page.request, incomingEmail);
  await seedHabit(page.request, incoming.token, INCOMING_HABIT, undefined, true);
  const incomingEntry = await writeFinishedPage(page, incoming.token);

  // A signs up on this device and makes it theirs.
  const outgoingEmail = await signUp(page, 'account-switch-outgoing');
  const outgoing = await sessionFor(page.request, outgoingEmail);
  const outgoingHabitId = await seedHabit(
    page.request,
    outgoing.token,
    OUTGOING_HABIT,
    undefined,
    true,
  );
  const outgoingKey = deviceOnlyKey();
  await storeApiKey(page, outgoingKey);
  await page.goto(`${frontendUrl()}/journal`);
  await openHabits(page);
  const outgoingTile = page.getByTestId('habit-tile').filter({ hasText: OUTGOING_HABIT });
  await expect(outgoingTile).toBeVisible();

  // A taps a check-in whose POST never reaches the server: lost at the
  // browser, it is queued on the device to replay later.
  const lostAtBrowser = (url: URL): boolean => url.pathname === '/goal_completions/';
  await page.route(lostAtBrowser, (route) =>
    route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue(),
  );
  await outgoingTile.click();
  await page.getByRole('button', { name: 'Log Units' }).click();
  await expect(page.getByText(OFFLINE_TOAST).first()).toBeVisible();
  const owner = await deviceOwner(page);
  const readQueue = async (): Promise<QueuedCheckIn[]> =>
    JSON.parse((await deviceRow(page, scoped(PENDING_KEY_BASE, owner))) ?? '[]') as QueuedCheckIn[];
  await expect.poll(readQueue).toHaveLength(1);
  const queue = await readQueue();
  const queuedOperation = queue[0]?.operation_id;
  if (queuedOperation === undefined) throw new Error('the queued tap carried no operation id');
  await page.getByTestId('goal-modal-backdrop').click({ position: BACKDROP_CORNER });
  await expect(page.getByTestId('goal-modal-backdrop')).toHaveCount(0);
  // The browser stops losing requests: from here a replay would really land.
  await page.unroute(lostAtBrowser);

  // Control: A's device state is all really there before the switch.
  await expect
    .poll(async () => (await deviceRow(page, scoped(HABITS_KEY_BASE, owner))) ?? '')
    .toContain(OUTGOING_HABIT);
  expect(await deviceRow(page, LLM_KEY_STORAGE_KEY)).toContain(outgoingKey);

  // A's session lapses. The cold start drops the expired token -- and nothing
  // else -- and the device lands on the log-in screen still holding A's cache.
  await page.clock.setSystemTime(Date.now() + PAST_TOKEN_LIFETIME_DAYS * MS_PER_DAY);
  await page.goto(`${frontendUrl()}/login`);
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect.poll(() => deviceRow(page, TOKEN_KEY)).toBeNull();
  // From here every request is the device's after A: none may be A's.
  const sent = recordRequests(page);
  expect(await deviceRow(page, scoped(PENDING_KEY_BASE, owner))).toContain(queuedOperation);
  expect(await deviceRow(page, scoped(HABITS_KEY_BASE, owner))).toContain(OUTGOING_HABIT);
  expect(await deviceRow(page, LLM_KEY_STORAGE_KEY)).toContain(outgoingKey);
  // Back to the real clock, so the session B is about to be issued is a live one.
  await page.clock.setSystemTime(Date.now());

  // B comes in through the password-reset flow.
  await page.getByRole('link', { name: 'Forgot password' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill(incomingEmail);
  const requested = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/auth/password-reset/request',
  );
  await page.getByRole('button', { name: 'Send reset link' }).click();
  expect((await requested).status()).toBe(HTTP_ACCEPTED);
  await expect.poll(() => mailedResetToken(incomingEmail)).not.toBeNull();
  const resetToken = mailedResetToken(incomingEmail) ?? '';
  await page.goto(`${frontendUrl()}${RESET_PATH}${resetToken}`);
  await page
    .getByRole('textbox', { name: 'New password', exact: true })
    .fill(INCOMING_RESET_PHRASE);
  await page.getByRole('textbox', { name: 'Confirm new password' }).fill(INCOMING_RESET_PHRASE);
  const confirmed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/auth/password-reset/confirm',
  );
  await page.getByRole('button', { name: 'Set new password' }).click();
  const incomingToken = ((await (await confirmed).json()) as { token: string }).token;
  await expect(page.getByTestId('journal-habits-tile')).toBeVisible();

  // 1. B's key context is empty: the pass is disclosed as a demo, and the pass
  //    and its completion check leave without A's key. Both are answered in the
  //    browser, so nothing reaches the lane's backend or its fake provider.
  const control = new RegExp(
    `/journal/${String(incomingEntry)}/(resonance|suggestions/detect)$`,
    'u',
  );
  await page.route(
    (url) => control.test(url.pathname),
    (route) =>
      route.fulfill({
        status: CONTROL_REFUSAL_STATUS,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'lane_control_refused' }),
      }),
  );
  await page.getByTestId(`journal-shelf-open-${String(incomingEntry)}`).click();
  await page.getByRole('button', { name: 'Get resonance' }).click();
  await expect(page.getByTestId('resonance-explainer-cost')).toHaveText(DEMO_COST);
  await page.getByTestId('resonance-explainer-continue').click();
  // Both went out -- the pass, which pins the payer it disclosed, and the
  // completion check, which reads the session's key getter -- so the header's
  // absence below is an observation of two real requests, not of none.
  await expect
    .poll(() => new Set(sent.filter((request) => control.test(request.path)).map((r) => r.path)))
    .toEqual(
      new Set([
        `/journal/${String(incomingEntry)}/resonance`,
        `/journal/${String(incomingEntry)}/suggestions/detect`,
      ]),
    );
  await expect(page.getByTestId('journal-resonance-error')).toBeVisible();

  // 2. B sees B's habits and none of A's.
  await page.getByRole('button', { name: 'Close — return to your journal' }).click();
  await openHabits(page);
  await expect(page.getByTestId('habit-tile').filter({ hasText: INCOMING_HABIT })).toBeVisible();
  await expect(page.getByTestId('habit-tile').filter({ hasText: OUTGOING_HABIT })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('incoming-account-after-switch.png'),
    fullPage: true,
  });

  // 3. On the wire: A's queued check-in was never sent, under any token, and
  //    nothing B sent carried A's key. B's requests carry B's own session.
  await page.waitForTimeout(QUIET_WINDOW_MS);
  const replayKey = `log-unit:${queuedOperation}`;
  expect(sent.filter((request) => request.idempotencyKey === replayKey)).toEqual([]);
  expect(
    sent.filter((request) => request.method === 'POST' && request.path === '/goal_completions/'),
  ).toEqual([]);
  expect(sent.filter((request) => request.llmKey !== null)).toEqual([]);
  const authorised = sent.filter((request) => request.authorization !== null);
  expect(authorised.length).toBeGreaterThan(0);
  expect(new Set(authorised.map((request) => request.authorization))).toEqual(
    new Set([`Bearer ${incomingToken}`]),
  );
  expect(completionsOf(await readHabit(page.request, outgoing.token, outgoingHabitId))).toEqual([]);

  // 4. In storage: the device names B now, and A's rows are gone.
  const newOwner = await deviceOwner(page);
  expect(newOwner).not.toBe(owner);
  expect(await deviceRow(page, scoped(HABITS_KEY_BASE, owner))).toBeNull();
  expect(await deviceRow(page, scoped(PENDING_KEY_BASE, owner))).toBeNull();
  expect(await deviceRow(page, LLM_KEY_STORAGE_KEY)).toBeNull();
  expect((await deviceRow(page, scoped(HABITS_KEY_BASE, newOwner))) ?? '').not.toContain(
    OUTGOING_HABIT,
  );

  // 5. And a cold start as B reads no key back either.
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await expect(page.getByTestId('no-key-hint')).toBeVisible();
  await expect(page.getByTestId('stored-key-card')).toHaveCount(0);
});
