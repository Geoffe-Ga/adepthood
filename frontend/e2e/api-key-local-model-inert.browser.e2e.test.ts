import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

import {
  LOCAL_MODEL_SWITCH_LABEL,
  LOCAL_MODEL_UNAVAILABLE_NOTE,
} from '../src/features/Settings/localModelCopy';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { readLaneState, type LaneState } from './laneState';

/**
 * Adepthood's own model is shown as coming soon, and a stale device preference
 * cannot make it anything more (#3032).
 *
 * An earlier build let a person switch "Use Adepthood's own model" on, and the
 * choice was kept in device storage. While that was on, `ApiKeyContext`'s
 * getter answered `null`, so a saved key stopped riding `X-LLM-API-Key` and the
 * request fell back to BotMason's shared provider -- which is not self-hosted.
 * The release gate (`LOCAL_MODEL_AVAILABLE`) now closes that option, and the
 * guard has three halves that unit tests pin separately but nothing had joined
 * up: the screen renders the control off and disabled, the key area stays
 * live, and the context keeps handing the saved key to the request.
 *
 * So this journey starts from the worst device state an upgrade can leave
 * behind -- the legacy preference already `true` before the app boots -- and
 * walks it to the request wire:
 *
 * 1. The preference is seeded where the web build's AsyncStorage keeps it, then
 *    the app is loaded from scratch so the context mounts over it.
 * 2. API-key Settings shows the coming-soon control off and disabled, with the
 *    unavailable note, and a forced press does not move it.
 * 3. The key area is editable, and a key is saved through it.
 * 4. A real resonance pass leaves the browser carrying that key and reaches the
 *    lane's loopback provider, whose canned answer comes back as an own-key
 *    receipt.
 * 5. Asking for a margin note's letter -- a request that passes no key and so
 *    reads the session getter the stale preference used to empty -- still
 *    carries the key. That request is answered in the browser.
 *
 * The seeded value is read back after each step, so every "the option stayed
 * off" is said about a device that still held `true` -- not one where the
 * preference was quietly gone.
 *
 * The pass uses the fake's opt-in happy path (`enable-receipt-reflection`) with
 * the throttled key, the same arrangement as the care/receipt journey in
 * `privacy-choices`: it answers 200 without moving any of the fake's attempt
 * counters, which `resonance-credit-exhausted` asserts start at zero. The path
 * is switched off again in a `finally`, and the counters are checked to be as
 * this spec found them.
 */

/**
 * The legacy preference, under the key `storage/localModelStorage.ts` names
 * (`LOCAL_MODEL_PREFERRED_KEY`). Restated rather than imported because that
 * module pulls in React Native's AsyncStorage, which a Node test process cannot
 * load; the bite check that lets the context read it again shows the literal is
 * the one the app reads.
 */
const LEGACY_PREFERENCE_KEY = '@adepthood/local_model_preferred';
/** What an older build wrote while the switch was on. */
const STALE_PREFERENCE = 'true';

const LLM_KEY_HEADER = 'x-llm-api-key'; // pragma: allowlist secret
const HTTP_OK = 200;
/** Non-transient and neither 401 (token refresh) nor 402 (refill invitation). */
const CONTROL_REFUSAL_STATUS = 422;
/** A margin note's letter: the one request here whose key comes from the getter. */
const ESSAY_PATH = /\/journal\/marginalia\/\d+\/essay$/u;

/** The margin note the fake's receipt reflection writes, so the dial is observed. */
const FAKE_PROVIDER_NOTE = 'The quiet image sits beside a heavy feeling.';

/**
 * Opens with the sentence the fake's canned note quotes, so the margin note it
 * returns anchors to this page instead of being dropped as unquotable.
 */
const READABLE_PAGE =
  'The heron stood in the shallows. I stood with it until the light changed, ' +
  'and for once did not reach for anything.';

interface Attempts {
  openaiSpent: number;
  openaiThrottled: number;
  openaiUnrecognised: number;
  anthropicSpent: number;
  anthropicUnrecognised: number;
}

interface ResonanceReply {
  provenance: { paid_by: string; notes: { provider?: string; source?: string } | null };
  marginalia: { id: number }[];
}

function lane(): LaneState {
  const state = readLaneState();
  if (state === null) throw new Error('the browser lane wrote no state; global setup did not run');
  if (!state.providerUrl) throw new Error('the browser lane booted no fake provider to reach');
  return state;
}

async function readAttempts(request: APIRequestContext): Promise<Attempts> {
  const response = await request.get(`${lane().providerUrl}/__lane/attempts`);
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as Attempts;
}

async function setReceiptReflection(
  request: APIRequestContext,
  state: 'enable' | 'disable',
): Promise<void> {
  const response = await request.post(`${lane().providerUrl}/__lane/${state}-receipt-reflection`);
  expect(response.status()).toBe(HTTP_OK);
}

async function writeFinishedPage(request: APIRequestContext, token: string): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The heron', message: READABLE_PAGE },
  });
  expect(created.ok()).toBe(true);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.ok()).toBe(true);
  return entryId;
}

/** What the device holds under the legacy key right now. */
async function storedPreference(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LEGACY_PREFERENCE_KEY);
}

/** Every POST this browser sends whose path matches `route`, in order. */
function recordPosts(page: Page, route: RegExp): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && route.test(new URL(request.url()).pathname)) {
      sent.push(request);
    }
  });
  return sent;
}

/**
 * Answer `route` in the browser with a plain refusal, so its headers are seen
 * on a real outgoing request while nothing reaches the backend or the fake.
 */
async function refuseInBrowser(page: Page, route: RegExp): Promise<() => Promise<void>> {
  const matcher = (url: URL): boolean => route.test(url.pathname);
  await page.route(matcher, (answer) =>
    answer.fulfill({
      status: CONTROL_REFUSAL_STATUS,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'lane_control_refused' }),
    }),
  );
  return () => page.unroute(matcher);
}

/** The coming-soon control, off and refusing a press, with the note that says why. */
async function expectInertControl(page: Page): Promise<void> {
  const choice = page.getByTestId('local-model-choice');
  await expect(choice).toContainText(LOCAL_MODEL_SWITCH_LABEL);
  const control = page.getByTestId('local-model-switch').getByRole('switch');
  await expect(control).not.toBeChecked();
  await expect(control).toBeDisabled();
  await expect(page.getByTestId('local-model-note')).toHaveText(LOCAL_MODEL_UNAVAILABLE_NOTE);
}

test("a stale local-model preference cannot enable the coming-soon option or withhold the writer's key", async ({
  page,
}) => {
  const { throttledOpenaiKey } = lane();
  const attemptsBefore = await readAttempts(page.request);
  const email = await signUp(page, 'local-model-inert');
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(page.request, token);
  const passes = recordPosts(page, new RegExp(`/journal/${String(entryId)}/resonance$`, 'u'));

  // 1. The device state an older build left behind, in place before the app
  //    that reads it boots: `goto` below is a full load, so the context mounts
  //    over a preference that already says "on".
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [
    LEGACY_PREFERENCE_KEY,
    STALE_PREFERENCE,
  ] as const);
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
  expect(await storedPreference(page)).toBe(STALE_PREFERENCE);

  // 2. Off, disabled, and saying the key is the way. A forced press goes past
  //    Playwright's own actionability wait to the element itself, and the
  //    control still does not move.
  await expectInertControl(page);
  await page.getByTestId('local-model-switch').getByRole('switch').click({ force: true });
  await expectInertControl(page);

  // 3. The key area is live -- not the greyed, pointer-less area an active
  //    local model makes of it -- and a key saved through it is kept.
  const keyArea = page.getByTestId('api-key-area');
  await expect(keyArea).not.toHaveAttribute('aria-disabled', 'true');
  const input = page.getByTestId('api-key-input');
  await expect(input).toBeEditable();
  await expect(page.getByTestId('save-key-button')).toBeEnabled();
  await input.fill(throttledOpenaiKey);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('api-key-status')).toHaveText('API key saved on this device.');
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
  await expectInertControl(page);
  expect(await storedPreference(page)).toBe(STALE_PREFERENCE);

  // 4. The request wire. The fake's happy path answers this one key with a
  //    canned reflection; it is armed only for this pass.
  await setReceiptReflection(page.request, 'enable');
  try {
    await page.goto(`${frontendUrl()}/journal`);
    await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/journal/${String(entryId)}/resonance`,
    );
    await page.getByRole('button', { name: 'Get resonance' }).click();
    // The disclosure is the context's own answer: a key it still returns pays.
    await expect(page.getByTestId('resonance-explainer-cost')).toContainText(
      'Your own API key pays',
    );
    await page.getByTestId('resonance-explainer-continue').click();
    const response = await answered;
    expect(response.status()).toBe(HTTP_OK);

    expect(passes).toHaveLength(1);
    expect(passes[0]?.headers()[LLM_KEY_HEADER]).toBe(throttledOpenaiKey);
    const reply = (await response.json()) as ResonanceReply;
    expect(reply.provenance.paid_by).toBe('own_key');
    expect(reply.provenance.notes).toMatchObject({ source: 'app_provider', provider: 'openai' });
    expect(reply.marginalia.length).toBeGreaterThan(0);
    await expect(
      page.getByTestId('resonance-pass-receipt').getByTestId('resonance-pass-payer'),
    ).toHaveText('Your provider key');
    await expect(page.getByText(FAKE_PROVIDER_NOTE).first()).toBeVisible();

    // 5. The session getter. The pass above hands the context's key over
    //    explicitly, so it alone cannot see the getter `ApiKeyContext`
    //    registers -- the one the stale preference used to empty. Asking for
    //    the note's letter passes no key, so whatever rides this request came
    //    from that getter. It is answered here in the browser: the header is
    //    the observation, and the letter would be one more provider dial.
    const essays = recordPosts(page, ESSAY_PATH);
    const releaseEssay = await refuseInBrowser(page, ESSAY_PATH);
    try {
      await page.locator('[data-testid^="margin-note-open-"]').first().click();
      await page.getByTestId('essay-ask').click();
      await expect.poll(() => essays.length).toBe(1);
      expect(essays[0]?.headers()[LLM_KEY_HEADER]).toBe(throttledOpenaiKey);
    } finally {
      await releaseEssay();
    }
  } finally {
    await setReceiptReflection(page.request, 'disable');
  }

  // The stale value was there the whole way through, so none of the above is a
  // claim about a device that had already forgotten it.
  expect(await storedPreference(page)).toBe(STALE_PREFERENCE);
  // And the fake's shared counters are as this spec found them.
  expect(await readAttempts(page.request)).toEqual(attemptsBefore);
});
