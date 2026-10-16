import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { backendUrl, frontendUrl } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

/**
 * A vault-bound writer asks for a margin note's first letter and the vault's
 * acute-distress guard answers instead (#3380, #3379).
 *
 * The lane vault answers that one letter request with Creek's own published
 * `letters` care-escalation cell, so everything between the wire and the pixels
 * is production: the adapter's raise, the route's refund and reviewed care
 * surface, the Zod schema, and the modal. The writer must see adepthood's
 * reviewed care copy -- never a blank-letter error, and never Creek's prose --
 * and, because nothing was stored, a later ask for the same note is written.
 */
const BODY = 'The river kept moving under the ice. I watched it a long time this morning.';
const ARTIFACTS =
  process.env.LETTER_CARE_ARTIFACTS ?? join(__dirname, 'artifacts', 'letter-care-3380');
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const CREEK_LETTER_ESCALATION = join(
  __dirname,
  '..',
  '..',
  'backend',
  'tests',
  'fixtures',
  'creek_v1',
  'examples',
  'letters',
  'care-escalation.json',
);

interface CareResource {
  kind: string;
  name: string;
  contact: string;
  what_it_is: string;
}

interface EssayAnswer {
  essay: string | null;
  care: { title: string; message: string; resources: CareResource[] } | null;
}

function lane() {
  const state = readLaneState();
  if (!state) throw new Error('letter care-escalation lane state is missing');
  return state;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Creek's own care message, which adepthood must drop at the adapter. */
function creekCareMessage(): string {
  const cell = JSON.parse(readFileSync(CREEK_LETTER_ESCALATION, 'utf8')) as {
    care_signal: { message: string };
  };
  return cell.care_signal.message;
}

async function loginVaultOwner(page: Page): Promise<string> {
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(200);
  const token = ((await response.json()) as { token: string }).token;
  const flags = await page.request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  expect(flags.status()).toBe(200);
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return token;
}

/** A finished Personal page with one margin note the lane vault wrote; returns the note id. */
async function pageWithNote(
  page: Page,
  token: string,
): Promise<{ entryId: number; noteId: number }> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'Under the ice', message: BODY, classification: 'personal' },
  });
  expect(created.status()).toBe(201);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await page.request.patch(`${backendUrl()}/journal/${entryId}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(200);
  const reading = await page.request.post(`${backendUrl()}/journal/${entryId}/resonance`, {
    headers: bearer(token),
  });
  expect(reading.status()).toBe(200);
  const note = ((await reading.json()) as { marginalia: { id: number }[] }).marginalia[0];
  if (note === undefined) throw new Error('the lane vault returned no margin note');
  return { entryId, noteId: note.id };
}

async function openNote(page: Page, entryId: number, noteId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${entryId}`).click();
  await page.getByTestId(`margin-note-open-${noteId}`).click();
  await expect(page.getByTestId('essay-ask')).toBeEnabled();
}

async function monthlyUsed(page: Page, token: string): Promise<number> {
  const response = await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { monthly_messages_used: number }).monthly_messages_used;
}

async function armEscalation(page: Page): Promise<void> {
  const armed = await page.request.post(`${lane().vaultUrl}/__lane/escalate-next-letter`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(armed.status()).toBe(200);
}

async function askForTheLetter(page: Page, noteId: number): Promise<EssayAnswer> {
  const answer = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/marginalia/${noteId}/essay`,
  );
  await page.getByTestId('essay-ask').click();
  const response = await answer;
  expect(response.status()).toBe(200);
  return (await response.json()) as EssayAnswer;
}

/** Each text node doubled from its first computed size: a 200% text-zoom stand-in. */
async function doubleText(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      const style = getComputedStyle(element);
      element.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
      const line = Number.parseFloat(style.lineHeight);
      if (Number.isFinite(line)) element.style.lineHeight = `${line * 2}px`;
    }
  });
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: false });
}

for (const viewport of VIEWPORTS) {
  test(`a letter the vault's care guard answered shows reviewed care at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const token = await loginVaultOwner(page);
    const { entryId, noteId } = await pageWithNote(page, token);
    await openNote(page, entryId, noteId);
    const usedBefore = await monthlyUsed(page, token);

    await armEscalation(page);
    const answer = await askForTheLetter(page, noteId);

    expect(answer.essay).toBeNull();
    expect(answer.care).not.toBeNull();
    const care = answer.care!;
    const dialog = page.getByTestId('essay-modal');
    const card = dialog.getByTestId('care-support-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: care.title })).toBeVisible();
    await expect(card.getByText(care.message, { exact: true })).toBeVisible();
    for (const resource of care.resources) {
      await expect(card.getByText(resource.name, { exact: false }).first()).toBeAttached();
    }
    await expect(dialog.getByText(creekCareMessage())).toHaveCount(0);
    await expect(dialog.getByTestId('essay-error')).toHaveCount(0);
    await expect(dialog.getByTestId('essay-retry')).toHaveCount(0);
    expect(await monthlyUsed(page, token)).toBe(usedBefore);
    await capture(page, `after-${viewport.width}-care`);
    await doubleText(page);
    await capture(page, `after-${viewport.width}-care-200-percent`);

    // Nothing was stored, so nothing is owed: after a reload the same note is
    // offered again, and the vault writes the letter this time.
    await openNote(page, entryId, noteId);
    const written = await askForTheLetter(page, noteId);
    expect(written.essay).not.toBeNull();
    expect(written.care).toBeNull();
    await expect(dialog.getByTestId('essay-text')).toHaveText(written.essay!);
    await expect(dialog.getByTestId('care-support-card')).toHaveCount(0);
  });
}
