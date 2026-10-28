import { spawnSync } from 'node:child_process';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  bearer,
  frontendUrl,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';
import { BACKEND_DIR, pythonExecutable, readLaneState, type LaneState } from './laneState';

/**
 * A writer asks for resonance while the balance that pays for it is spent.
 *
 * What shipped was "BotMason's AI provider is having trouble connecting. Give
 * it a moment and tap retry" — a transient story for a permanent, billing-level
 * refusal. The retry it pointed at could never work, and the real cause reached
 * nobody. The fix is a carve-out that recognises each provider's own way of
 * saying "this account has no credit" and answers with copy that names the
 * condition and the one action that clears it, split by whose key it was.
 *
 * Every layer of that fix was already tested, and the bug still shipped, because
 * every one of those tests built the provider's refusal by hand. Injecting a
 * typed error proves the routing and *assumes* the classification, and the
 * classification is the whole claim: "this 429 means the balance is gone" and
 * "this 429 means slow down" are the same status carrying a different code, and
 * getting them the wrong way round tells every rate-limited writer to go top up
 * an account that is not empty. So this journey never raises the typed error.
 * The lane points the production SDK clients at a loopback fake through their
 * own `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, the fake answers with the
 * providers' real refusal bodies, and `openai.RateLimitError` /
 * `anthropic.BadRequestError` are built by the SDKs out of those bytes. What the
 * classifier sees here is what it would see from the real thing.
 *
 * Three claims, in three accounts:
 *
 * 1. The writer's own key is refused (402): the copy names the spent balance and
 *    offers no retry, and the caller-paid pass never touches either wallet.
 * 2. The same provider, same status, a *different* code: a genuine rate limit
 *    keeps its transient copy and its retry. This is the counterweight — without
 *    it, a carve-out that swallowed every 429 would pass the test above.
 * 3. The server's own key is never spent on a writer's page (ADR 0009 phase (a),
 *    #3067): with that key and the retired provider-probe marker both still
 *    armed on the lane's server, a keyless page reaches no provider at all.
 *
 * A fourth account proves the privacy floor holds while all of this is armed: an
 * intimate page cannot reach a provider even when the server has a live one to
 * reach and the page is marked for it.
 *
 * Vacuity is the failure mode this file guards hardest against. BYOK must leave
 * no audit rows, and a keyless page must reach no provider at all; either result
 * is meaningless unless the counters can see a dial when one happens. So
 * every press is bracketed by the fake's own attempt counters and by the wallet
 * audit trail, and the copy is read out of the margin before anything is
 * asserted absent from it.
 */

/** The fake's per-shape counters, which is how a press is proved to have landed. */
interface Attempts {
  openaiSpent: number;
  openaiThrottled: number;
  openaiUnrecognised: number;
  anthropicSpent: number;
  anthropicUnrecognised: number;
}

/** One row of `walletaudit`, as `tests.e2e.wallet_audit` reports it. */
interface WalletRow {
  bucket: string;
  reason: string;
  delta: string;
  balance_before: string;
  balance_after: string;
}

/** An account's wallet and its whole audit trail, read out of band. */
interface Wallet {
  user_id: number;
  monthly_messages_used: number;
  offering_balance: number;
  rows: WalletRow[];
}

const HTTP_OK = 200;
/** The retired probe's length floor (`MIN_PROBE_TOKEN_LENGTH`): the lane mints a token past it. */
const MIN_PROBE_TOKEN_LENGTH = 16;

/** A finished page with sentences in it, so nothing but the refusal is unusual. */
const READABLE_PAGE =
  'The willow bent all night and did not break. I slept badly and woke grateful, ' +
  'which is not the trade I would have chosen.';

/**
 * The lane's own coordinates, or a thrown error naming what did not get set up.
 *
 * Every field below is part of the arrangement rather than a convenience: with
 * any of them missing the presses in this file would quietly reach the stub
 * provider and succeed, and a spec that tested a success path while claiming to
 * test a refusal is worse than no spec.
 */
function lane(): LaneState {
  const state = readLaneState();
  if (state === null) throw new Error('API lane state is missing; global setup did not run');
  if (!state.providerUrl) throw new Error('the lane booted no fake provider to be refused by');
  return state;
}

/**
 * Read the fake's counters, failing loudly when it is not there to be read.
 *
 * This doubles as the arrange check the whole file leans on: if the fake never
 * came up, or came up somewhere else, this throws here rather than letting a
 * press fall through to the stub and produce a green success.
 */
async function readAttempts(request: APIRequestContext): Promise<Attempts> {
  const response = await request.get(`${lane().providerUrl}/__lane/attempts`);
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as Attempts;
}

/**
 * Read an account's wallet and audit trail straight out of the lane's database.
 *
 * `walletaudit` has no API by design — it is a forensic surface for operators —
 * and it is also the only place that distinguishes caller-paid "never charged"
 * from "charged and put back". A spec that could see only the final balance
 * would pass against either policy and could not verify who paid.
 */
function readWallet(email: string): Wallet {
  const state = lane();
  const result = spawnSync(
    pythonExecutable(),
    ['-m', 'tests.e2e.wallet_audit', 'show', '--email', email],
    {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: state.databaseUrl },
    },
  );
  if (result.status !== 0) {
    throw new Error(`wallet audit read failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Wallet;
}

/** A caller-owned key must leave both wallet buckets and their audit trail alone. */
function expectWalletUntouched(before: Wallet, after: Wallet): void {
  expect(after.monthly_messages_used).toBe(before.monthly_messages_used);
  expect(after.offering_balance).toBe(before.offering_balance);
  expect(after.rows.slice(before.rows.length)).toEqual([]);
}

/** Write a finished page for `email`'s account and return its id. */
async function writeFinishedPage(
  request: APIRequestContext,
  token: string,
  message: string,
  classification?: string,
): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The willow', message, ...(classification ? { classification } : {}) },
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

/**
 * Paste a key into Settings the way a writer does, and wait for it to be stored.
 *
 * Driven through the real screen rather than written into storage directly: the
 * 402 half of this journey is *about* the caller's own key, and a key that the
 * app never accepted would send the server the same request as no key at all —
 * which reaches no provider, silently.
 */
async function storeApiKey(page: Page, apiKey: string): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(apiKey);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

/** Open a finished entry from the Journal shelf. */
async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
}

/**
 * The sentence the margin is showing, read before anything is asserted about it.
 *
 * "There is no retry affordance" is the assertion most at risk of passing
 * vacuously here: an error that never rendered at all satisfies it perfectly.
 * Returning the text — and failing if there is none — means every negative
 * assertion in this file is made about copy that demonstrably reached the page.
 */
async function marginErrorText(page: Page): Promise<string> {
  const margin = page.getByTestId('journal-resonance-error');
  await expect(margin).toBeVisible();
  const text = await margin.textContent();
  expect(text ?? '').not.toBe('');
  return text ?? '';
}

test("a spent balance behind the writer's own key is named, and a rate limit is not", async ({
  page,
}) => {
  const { spentOpenaiKey, throttledOpenaiKey } = lane();
  const before = await readAttempts(page.request);
  // The fake is per-run, so these really are the starting values, and a press
  // that never reached a provider cannot hide behind a counter that was already
  // non-zero.
  expect(before.openaiSpent).toBe(0);
  expect(before.openaiThrottled).toBe(0);

  const email = await signUp(page, 'credit-exhausted');
  const token = await tokenFor(page.request, email);
  const spentEntry = await writeFinishedPage(page.request, token, READABLE_PAGE);
  const throttledEntry = await writeFinishedPage(page.request, token, READABLE_PAGE);

  // --- The refusal under test: the account behind the writer's key is empty.
  const walletBeforeSpent = readWallet(email);
  await storeApiKey(page, spentOpenaiKey);
  await openEntry(page, spentEntry);
  await askForResonance(page);

  const spentCopy = await marginErrorText(page);
  // The condition, and the one action that clears it. Named before anything is
  // asserted absent, so "no retry" is a claim about copy that actually rendered.
  expect(spentCopy).toContain('has run out of credit');
  expect(spentCopy).toContain('Top it up with whoever issued the key');
  // The affordance is the sentence: there is no retry button in this margin, so
  // pointing the writer at a retry means saying the word. The transient story
  // the bug told must be gone in full -- both halves of it, because either half
  // alone still reads as "this will pass, try again".
  expect(spentCopy).not.toContain("can't reach the AI service");
  expect(spentCopy).not.toMatch(/tap retry/iu);
  expect(spentCopy).not.toMatch(/retry/iu);
  // And no control offering one either, in this margin or anywhere on the page.
  await expect(page.getByRole('button', { name: /retry/iu })).toHaveCount(0);
  // What the margin does still say, and should: the completion check ran even
  // though the reflection did not. That sentence is the completion path's claim
  // about what happened, not the pass's advice about what to do next -- it is
  // read here so a later reader knows it was seen rather than missed.
  expect(spentCopy).toContain('We still checked it for completed habits');

  const afterSpent = await readAttempts(page.request);
  // The press really reached a provider, and it was asked exactly once: a
  // permanent refusal is never retried, which is half of why the carve-out
  // exists at all.
  expect(afterSpent.openaiSpent).toBe(1);
  expectWalletUntouched(walletBeforeSpent, readWallet(email));

  // --- The counterweight: same provider, same 429, a different code.
  const walletBeforeThrottled = readWallet(email);
  await storeApiKey(page, throttledOpenaiKey);
  await openEntry(page, throttledEntry);
  await askForResonance(page);

  const throttledCopy = await marginErrorText(page);
  // A rate limit is transient, so this one keeps the retry it was always owed.
  // A carve-out that read the status instead of the code would have swallowed
  // this into the spent-balance copy and told the writer to go buy credit they
  // already have.
  expect(throttledCopy).toContain("can't reach the AI service");
  expect(throttledCopy).toMatch(/tap retry/iu);
  expect(throttledCopy).not.toContain('run out of credit');

  const afterThrottled = await readAttempts(page.request);
  // Retried, where the spent balance was not: the same status behaving
  // differently is the observable difference between the two classifications.
  expect(afterThrottled.openaiThrottled).toBeGreaterThan(1);
  expect(afterThrottled.openaiSpent).toBe(1);
  expectWalletUntouched(walletBeforeThrottled, readWallet(email));
  // A key the fake did not recognise would mean the lane wired the wrong
  // credential and every assertion above described the wrong account.
  expect(afterThrottled.openaiUnrecognised).toBe(0);
});

test("the server's own key is never spent on a writer's page, even with the retired probe marker", async ({
  page,
}) => {
  const { providerProbeToken } = lane();
  // The arrangement that used to dial: before ADR 0009 phase (a) (#3067) a
  // keyless page carrying this marker went past the stub to the provider on the
  // server's own (spent) key and came back 503. The token and that key are both
  // still set on this lane's server, and nothing reads either any more.
  expect(providerProbeToken.length).toBeGreaterThanOrEqual(MIN_PROBE_TOKEN_LENGTH);
  const before = await readAttempts(page.request);

  const email = await signUp(page, 'server-key-unspent');
  const token = await tokenFor(page.request, email);
  const entryId = await writeFinishedPage(
    page.request,
    token,
    `${providerProbeToken}:anthropic — ${READABLE_PAGE}`,
  );
  const walletBefore = readWallet(email);

  // Asked directly, with no key of the writer's own: the lane's armed stub seam
  // answers, as a demo, and nothing leaves the process.
  const response = await page.request.post(`${backendUrl()}/journal/${String(entryId)}/resonance`, {
    headers: bearer(token),
  });
  expect(response.status()).toBe(HTTP_OK);
  const body = (await response.json()) as { provenance: { paid_by: string } };
  expect(body.provenance.paid_by).toBe('free');

  // No provider was reached, on any surface the fake listens on -- in
  // particular not the spent Anthropic account behind the server's own key.
  expect(await readAttempts(page.request)).toEqual(before);
  // And the writer kept every unit: whatever the demo pass staged was put back.
  const walletAfter = readWallet(email);
  expect(walletAfter.monthly_messages_used).toBe(walletBefore.monthly_messages_used);
  expect(walletAfter.offering_balance).toBe(walletBefore.offering_balance);
});

test('an intimate page never reaches the provider, even with one armed and the page marked for it', async ({
  page,
}) => {
  const { providerProbeToken, throttledOpenaiKey } = lane();
  const before = await readAttempts(page.request);

  const email = await signUp(page, 'intimate-privacy-floor');
  const token = await tokenFor(page.request, email);
  // Deliberately the hardest version of the page: it carries the marker that,
  // before ADR 0009 phase (a), sent a keyless entry to a live provider, on a
  // server whose own key is still set and whose provider is reachable. The
  // intimate floor answers before any payer or provider question is asked.
  const entryId = await writeFinishedPage(
    page.request,
    token,
    `${providerProbeToken}:anthropic — ${READABLE_PAGE}`,
    'intimate',
  );
  const walletBefore = readWallet(email);

  await openEntry(page, entryId);
  // The screen's own half of the floor: the affordance is present but inert, and
  // it says why rather than simply refusing to work.
  await expect(page.getByTestId('privacy-resonance-reason')).toBeVisible();
  const button = page.getByTestId('get-resonance-button');
  await expect(button).toBeDisabled();

  // The server's half, asked directly, because a disabled button proves only
  // that this client did not send the request. The floor that matters is the one
  // the route keeps for every client. The request carries the writer's own key
  // -- since ADR 0009 phase (a) the only thing that can reach a provider -- so
  // the intimate floor is the one thing standing between this page and a live
  // dial, and the attempt counters below mean something.
  const response = await page.request.post(`${backendUrl()}/journal/${String(entryId)}/resonance`, {
    headers: { ...bearer(token), 'X-LLM-API-Key': throttledOpenaiKey },
  });
  expect(response.status()).toBe(HTTP_OK);
  expect((await response.json()) as { private: boolean }).toMatchObject({ private: true });

  // Nothing left the process: not to the provider the marker named, and not to
  // any other surface the fake is listening on.
  expect(await readAttempts(page.request)).toEqual(before);
  // And nothing was charged, so there was nothing to put back either -- the
  // floor returns before the deduction rather than compensating one.
  const walletAfter = readWallet(email);
  expect(walletAfter.rows.length).toBe(walletBefore.rows.length);
  expect(walletAfter.monthly_messages_used).toBe(walletBefore.monthly_messages_used);
});
