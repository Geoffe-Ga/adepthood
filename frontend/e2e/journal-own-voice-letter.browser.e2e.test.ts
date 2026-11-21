import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type APIResponse, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

/**
 * A letter in the writer's own voice, the threads their entry belongs to, and
 * the related panel under a letter (#3778).
 *
 * Creek contract 0.35 writes a reflection or a letter in the owner's own voice
 * for a caller declaring it, and 0.36 names the threads an entry belongs to and,
 * on a letter, the praxis, eddies and threads it touches. adepthood declares
 * 0.36 on those two calls only to a vault whose handshake lists it. The lane's
 * vault lists it only after `POST /__lane/advertise-own-voice`, and then answers
 * with the pages of Creek's own vendored 0.36 cells; without it, the same
 * vault is a pre-0.35 vault and every call declares the 0.22 pin.
 *
 * Everything between the vault and the pixels is production: the handshake
 * negotiation, the adapter's projection, the route, the stored note, the Zod
 * schema, the hook, the band and the letter card. Nothing is routed at the
 * browser.
 */

// A routed read can still be awaiting `route.fetch()` when the test ends (#3481).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

interface OwnerWallet {
  monthly_messages_used: number;
  offering_balance: number;
}

interface PraxisPage {
  title: string;
  praxis_type: string;
  status: string;
  excerpt: string;
}

interface EddyPage {
  title: string;
  description: string;
  fragment_count: number;
  formed: string;
}

interface ThreadPage {
  id: string;
  title: string;
  status: string;
}

interface Pages {
  related_praxis: PraxisPage[];
  related_eddies: EddyPage[];
  related_threads: ThreadPage[];
}

interface OwnVoicePages {
  letter: Pages;
  reflection: Pages;
}

interface VaultCall {
  method: string;
  path: string;
  declared?: string;
}

interface EssayAnswer {
  essay: string | null;
  essay_voice: string | null;
  essay_related: { praxis: PraxisPage[]; eddies: EddyPage[]; threads: ThreadPage[] } | null;
}

const BAND = 'from-your-creek';
const OWN_VOICE_LINE = 'In your own voice';
const THREADS_HEADING = 'Threads — the currents your writing is part of';
const OWN_VOICE_MINOR = '0.36';
const PINNED_MINOR = '0.22';
const HTTP_OK = 200;
const HTTP_CREATED = 201;
test.use({ deviceScaleFactor: 2 });

const ARTIFACTS =
  process.env.OWN_VOICE_ARTIFACTS ?? join(__dirname, 'artifacts', 'own-voice-letter-3778');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const FIRST_BODY =
  'I said yes again to a week I knew would empty me. Leaving the firm keeps coming back.';
const SECOND_BODY =
  'The garden needed nothing from me today. I sat with the beans and let them climb.';

function lane() {
  const state = readLaneState();
  if (!state || state.vaultOwnerEmail === '') throw new Error('the lane recorded no vault owner');
  return state;
}

/** The bound owner's real wallet, read out of band (`tests.e2e.wallet_audit`). */
function ownerWallet(): OwnerWallet {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', lane().vaultOwnerEmail]),
  ) as OwnerWallet;
}

async function vaultControl(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
): Promise<APIResponse> {
  const url = `${lane().vaultUrl}${path}`;
  const headers = bearer(lane().vaultApiKey);
  const response = await (method === 'GET'
    ? page.request.get(url, { headers })
    : page.request.post(url, { headers }));
  expect(response.status()).toBe(HTTP_OK);
  return response;
}

/**
 * Each pass and letter here is charged to the shared vault owner's real
 * allowance, so the wallet is recorded first and given back afterwards (on
 * failure too); and the vault is returned to a pre-0.35 vault, so no later
 * spec on the shared owner hears an own-voice answer it did not ask for.
 */
let recordedWallet: OwnerWallet | undefined;

test.beforeEach(() => {
  recordedWallet = ownerWallet();
});

test.afterEach(async ({ page }) => {
  await vaultControl(page, 'POST', '/__lane/withdraw-own-voice');
  const recorded = recordedWallet;
  recordedWallet = undefined;
  if (recorded !== undefined) {
    runBackendModule('tests.e2e.restore_allowance', [
      'restore',
      '--email',
      lane().vaultOwnerEmail,
      '--monthly-messages-used',
      String(recorded.monthly_messages_used),
      '--offering-balance',
      String(recorded.offering_balance),
    ]);
  }
});

/** Every generation call the lane vault answered under ``path``, in order. */
async function calls(page: Page, path: string): Promise<VaultCall[]> {
  const ledger = (await (await vaultControl(page, 'GET', '/__lane/uploads')).json()) as {
    received: VaultCall[];
  };
  return ledger.received.filter((call) => call.path.startsWith(path));
}

/** Sign the bound owner in through the real log-in screen; returns a token. */
async function loginVaultOwner(page: Page): Promise<string> {
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(HTTP_OK);
  const token = ((await response.json()) as { token: string }).token;
  const flags = await page.request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  expect(flags.status()).toBe(HTTP_OK);
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return token;
}

/** A finished Personal page, written through the server's own journal routes. */
async function finishedPage(page: Page, token: string, message: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: message.slice(0, 24), message, classification: 'personal' },
  });
  expect(created.status()).toBe(HTTP_CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(HTTP_OK);
  return entryId;
}

/** A margin note the lane vault wrote on ``entryId``, asked for out of band. */
async function noteOn(page: Page, token: string, entryId: number): Promise<number> {
  const reading = await page.request.post(`${backendUrl()}/journal/${String(entryId)}/resonance`, {
    headers: bearer(token),
  });
  expect(reading.status()).toBe(HTTP_OK);
  const note = ((await reading.json()) as { marginalia: { id: number }[] }).marginalia[0];
  if (note === undefined) throw new Error('the lane vault returned no margin note');
  return note.id;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

/** Ask the open page for a pass, through the spend disclosure when it is shown. */
async function askForPass(page: Page, entryId: number): Promise<Pages> {
  const passed = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/${String(entryId)}/resonance`,
  );
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const explainer = page.getByTestId('resonance-explainer-continue');
  const first = await Promise.race([
    passed.then(() => 'passed' as const),
    explainer.waitFor().then(() => 'explainer' as const),
  ]);
  if (first === 'explainer') await explainer.click();
  const response = await passed;
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as Pages;
}

/** Open a margin note's letter card on its offer. */
async function openNote(page: Page, entryId: number, noteId: number): Promise<void> {
  await openEntry(page, entryId);
  await page.getByTestId(`margin-note-open-${String(noteId)}`).click();
  await expect(page.getByTestId('essay-modal')).toBeVisible();
}

async function askForTheLetter(page: Page, noteId: number): Promise<EssayAnswer> {
  const answer = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/marginalia/${String(noteId)}/essay`,
  );
  await page.getByTestId('essay-ask').click();
  const response = await answer;
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as EssayAnswer;
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: false });
}

test('a vault that writes in the owner’s voice names the threads beside a reflection', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);
  const token = await loginVaultOwner(page);
  await vaultControl(page, 'POST', '/__lane/advertise-own-voice');
  const published = (await (
    await vaultControl(page, 'GET', '/__lane/own-voice-pages')
  ).json()) as OwnVoicePages;
  const [thread] = published.reflection.related_threads;
  if (thread === undefined) throw new Error('the 0.36 reflection cell names no thread');
  const entryId = await finishedPage(page, token, FIRST_BODY);

  await openEntry(page, entryId);
  const asked = (await calls(page, '/v1/reflections')).length;
  await vaultControl(page, 'POST', '/__lane/relate-next-reflection');
  const answer = await askForPass(page, entryId);

  expect((await calls(page, '/v1/reflections')).slice(asked).map((c) => c.declared)).toEqual([
    OWN_VOICE_MINOR,
  ]);
  expect(answer.related_threads).toEqual(published.reflection.related_threads);
  const toggle = page.getByTestId(`${BAND}-toggle`);
  await expect(toggle).toContainText('3 pages');
  await toggle.click();
  const threads = page.getByTestId(`${BAND}-threads`);
  await expect(threads.getByText(THREADS_HEADING, { exact: true })).toBeVisible();
  await expect(threads.getByText(thread.title, { exact: true })).toBeVisible();
  await expect(threads.getByText('still running', { exact: true })).toBeVisible();
  await capture(page, 'reflection-threads-1280');
});

test('a letter in the owner’s voice says so, keeps its pages, and still does when reopened', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize(PHONE);
  const token = await loginVaultOwner(page);
  await vaultControl(page, 'POST', '/__lane/advertise-own-voice');
  const published = (await (
    await vaultControl(page, 'GET', '/__lane/own-voice-pages')
  ).json()) as OwnVoicePages;
  const [praxis] = published.letter.related_praxis;
  const [eddy] = published.letter.related_eddies;
  const [thread] = published.letter.related_threads;
  if (praxis === undefined || eddy === undefined || thread === undefined) {
    throw new Error('the 0.36 letter cell is missing a page');
  }
  const entryId = await finishedPage(page, token, FIRST_BODY);
  const noteId = await noteOn(page, token, entryId);

  await openNote(page, entryId, noteId);
  const asked = (await calls(page, '/v1/letters/')).length;
  const answer = await askForTheLetter(page, noteId);

  expect((await calls(page, '/v1/letters/')).slice(asked).map((c) => c.declared)).toEqual([
    OWN_VOICE_MINOR,
  ]);
  expect(answer.essay_voice).toBe('owner');
  expect(answer.essay_related).toEqual({
    praxis: published.letter.related_praxis,
    eddies: published.letter.related_eddies,
    threads: published.letter.related_threads,
  });
  const card = page.getByTestId('essay-modal');
  await expect(card.getByTestId('essay-text')).toHaveText(answer.essay ?? '');
  await expect(card.getByTestId('essay-voice')).toHaveText(OWN_VOICE_LINE);
  // The voice line sits under the letter, never above it.
  const letterBox = await card.getByTestId('essay-text').boundingBox();
  const voiceBox = await card.getByTestId('essay-voice').boundingBox();
  expect(letterBox).not.toBeNull();
  expect(voiceBox).not.toBeNull();
  if (letterBox && voiceBox) expect(voiceBox.y).toBeGreaterThanOrEqual(letterBox.y);
  // Collapsed under the letter, with nothing of the pages until asked.
  const toggle = card.getByTestId(`${BAND}-toggle`);
  await expect(toggle).toContainText('3 pages');
  await expect(card.getByText(thread.title)).toHaveCount(0);
  await capture(page, 'letter-own-voice-390');
  await toggle.click();
  await expect(card.getByText(praxis.title, { exact: true })).toBeVisible();
  await expect(card.getByText(eddy.title, { exact: true })).toBeVisible();
  await expect(card.getByText(thread.title, { exact: true })).toBeVisible();
  await capture(page, 'letter-own-voice-expanded-390');

  // Reopened after a reload: read from the stored note, the vault not asked.
  const letters = (await calls(page, '/v1/letters/')).length;
  await page.setViewportSize(DESKTOP);
  await openNote(page, entryId, noteId);
  await expect(card.getByTestId('essay-voice')).toHaveText(OWN_VOICE_LINE);
  await expect(card.getByTestId(`${BAND}-toggle`)).toContainText('3 pages');
  expect(await calls(page, '/v1/letters/')).toHaveLength(letters);
  await capture(page, 'letter-own-voice-reopened-1280');
});

test('a vault that predates 0.35 hears the pin and its letter claims no voice and no pages', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await loginVaultOwner(page);
  const entryId = await finishedPage(page, token, SECOND_BODY);
  const noteId = await noteOn(page, token, entryId);

  await openNote(page, entryId, noteId);
  const asked = (await calls(page, '/v1/letters/')).length;
  const answer = await askForTheLetter(page, noteId);

  expect((await calls(page, '/v1/letters/')).slice(asked).map((c) => c.declared)).toEqual([
    PINNED_MINOR,
  ]);
  expect(answer.essay_voice).toBeNull();
  expect(answer.essay_related).toBeNull();
  const card = page.getByTestId('essay-modal');
  await expect(card.getByTestId('essay-text')).toBeVisible();
  await expect(card.getByTestId('essay-voice')).toHaveCount(0);
  await expect(card.getByTestId(BAND)).toHaveCount(0);
});
