import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { readLaneState } from './laneState';

/**
 * Real persistence is proved with the stub and the bound Creek contract process.
 * The controlled metadata matrix below proves client validation only: it never
 * claims a real vendor answered, a wallet charge stood, or a model was local.
 */
const PAGE_BODY = 'The heron stood in the shallows until the light changed.';
const ARTIFACTS = join(__dirname, 'artifacts', 'inference-receipts');
const DEMO = 'Demo — not a real reflection';

async function writeFinishedPage(page: Page, token: string, message = PAGE_BODY): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'The heron', message },
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

async function monthlyUsed(page: Page, token: string): Promise<number> {
  const response = await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { monthly_messages_used: number }).monthly_messages_used;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

async function requestPass(page: Page, entryId: number) {
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/journal/${entryId}/resonance`,
  );
  const invitationRead = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/corpus/invitation',
  );
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const continueButton = page.getByTestId('resonance-explainer-continue');
  await continueButton.click();
  const received = await response;
  expect(received.status()).toBe(200);
  const invitation = await invitationRead;
  expect(invitation.status()).toBe(200);
  if ((await invitation.json()).offer) {
    // A writer can set aside this separate invitation before reading the margin.
    const declined = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/corpus/invitation',
    );
    await page.getByTestId('journal-corpus-invitation-dismiss').click();
    expect((await declined).status()).toBe(200);
    await expect(page.getByTestId('journal-corpus-invitation')).toHaveCount(0);
  }
  return received.json();
}

async function frame(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

for (const width of [390, 1280]) {
  test(`real demo receipt, uncharged wallet and independent letter survive reload at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'receipt-demo');
    const token = await tokenFor(page.request, email);
    const entryId = await writeFinishedPage(page, token);
    const before = await monthlyUsed(page, token);
    await openEntry(page, entryId);
    const pass = await requestPass(page, entryId);
    expect(pass.provenance.paid_by).toBe('free');
    expect(pass.provenance.notes).toMatchObject({
      source: 'demo',
      provider: 'stub',
      receipt_version: 1,
    });
    const noteId = pass.marginalia[0].id as number;
    const receipt = page.getByTestId('resonance-pass-receipt');
    await expect(receipt.getByTestId('resonance-pass-payer')).toHaveText(
      'No Adepthood wallet charge',
    );
    await expect(receipt.getByText('Reported provider: Demo', { exact: true })).toBeVisible();
    expect(await monthlyUsed(page, token)).toBe(before);
    await receipt.scrollIntoViewIfNeeded();
    await frame(page, `real-demo-${width}-pass`);

    await page.reload();
    await openEntry(page, entryId);
    const note = page.getByTestId(`margin-note-${noteId}`);
    await expect(note.getByTestId(`margin-note-source-${noteId}`)).toHaveText(DEMO);
    await expect(note.getByText('Reported provider: Demo', { exact: true })).toBeVisible();
    await expect(page.getByTestId('resonance-pass-receipt')).toHaveCount(0);
    const persisted = await page.request.get(`${backendUrl()}/journal/${entryId}/marginalia`, {
      headers: bearer(token),
    });
    expect(persisted.ok()).toBe(true);
    expect((await persisted.json()).items[0]).toMatchObject({
      source: 'demo',
      source_provider: 'stub',
      receipt_version: 1,
    });
    await note.scrollIntoViewIfNeeded();
    await frame(page, `real-demo-${width}-reload`);

    await note.click();
    const essayWrite = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/journal/marginalia/${noteId}/essay`,
    );
    await page.getByTestId('essay-ask').click();
    const letterResponse = await essayWrite;
    expect(letterResponse.status()).toBe(200);
    expect((await letterResponse.json()).essay_source).toBe('demo');
    await expect(page.getByTestId('essay-source')).toHaveText(DEMO);
    await frame(page, `real-demo-${width}-letter`);
    await page.getByTestId('essay-close').click();
    const shelfRead = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' && new URL(r.url()).pathname === '/journal/voice-drafts',
    );
    await page.getByRole('button', { name: 'Open Journal menu' }).click();
    await page.getByTestId('journal-drawer-voice-drafts').click();
    expect((await shelfRead).status()).toBe(200);
    await expect(page.getByTestId(`voice-draft-source-${noteId}`)).toHaveText(DEMO);
    await frame(page, `real-demo-${width}-shelf`);
  });
}

test('bound Creek source and unrecorded model survive a real backend reload', async ({ page }) => {
  const lane = readLaneState();
  if (!lane) throw new Error('Missing lane vault owner');
  const login = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: lane.vaultOwnerEmail, password: lane.vaultOwnerPassword },
  });
  expect(login.ok()).toBe(true);
  const token = ((await login.json()) as { token: string }).token;
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(lane.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(lane.vaultOwnerPassword);
  const flagsRead = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/ui-flags',
  );
  await page.getByRole('button', { name: 'Log in' }).click();
  const flagsResponse = await flagsRead;
  expect(flagsResponse.status()).toBe(200);
  const flags = await flagsResponse.json();
  const skip = page.getByRole('button', { name: 'Skip the welcome' });
  if (!flags.has_seen_welcome) {
    const savedFlags = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/ui-flags',
    );
    await skip.click();
    expect((await savedFlags).status()).toBe(200);
  }
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  const entryId = await writeFinishedPage(page, token);
  const usedBefore = await monthlyUsed(page, token);
  await openEntry(page, entryId);
  const pass = await requestPass(page, entryId);
  expect(pass.provenance.paid_by).toBe('wallet');
  expect(await monthlyUsed(page, token)).toBe(usedBefore + 1);
  expect(pass.provenance.notes).toMatchObject({
    source: 'creek_vault',
    provider: 'creek',
    model: null,
    receipt_version: 1,
  });
  await expect(page.getByTestId('resonance-notes-source')).toHaveText('From your Creek vault');
  await expect(
    page.getByTestId('resonance-pass-receipt').getByText('Model not recorded'),
  ).toBeVisible();
  await frame(page, 'real-creek-pass');
  await page.reload();
  await openEntry(page, entryId);
  await expect(page.locator('[data-testid^="margin-note-source-"]').first()).toHaveText(
    'From your Creek vault',
  );
  await expect(page.getByTestId('resonance-pass-receipt')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Get resonance' })).toBeEnabled();
  await expect
    .poll(() =>
      page.getByTestId('journal-screen').evaluate((node) => {
        let opacity = 1;
        for (
          let current: HTMLElement | null = node as HTMLElement;
          current;
          current = current.parentElement
        ) {
          opacity *= Number(getComputedStyle(current).opacity);
        }
        return opacity;
      }),
    )
    .toBe(1);
  await frame(page, 'real-creek-reload');
});

interface ControlledCase {
  name: string;
  noteMetadata: Record<string, unknown>;
  provenance: unknown;
  noteSource: string;
  passSource: string;
  payer: string;
  completion: string;
}

const NONE = { source: 'none', provider: null, model: null, receipt_version: 1 };
const APP = {
  source: 'app_provider',
  provider: 'openai',
  model: 'reported-model',
  receipt_version: 1,
};
const APP_NOTE = {
  source: 'app_provider',
  source_provider: 'openai',
  source_model: 'reported-model',
  receipt_version: 1,
};
const PASS = { notes: APP, detection: NONE, detection_checked: false, paid_by: 'wallet' };
const UNRECORDED = 'Source not recorded';
const CASES: ControlledCase[] = [
  {
    name: 'app-wallet',
    noteMetadata: APP_NOTE,
    provenance: PASS,
    noteSource: "From the app's AI provider",
    passSource: "From the app's AI provider",
    payer: 'Adepthood wallet',
    completion: 'No AI completion check was sent.',
  },
  {
    name: 'app-own-key-attempt',
    noteMetadata: APP_NOTE,
    provenance: {
      ...PASS,
      detection: { ...APP, provider: 'anthropic', model: 'completion-model' },
      paid_by: 'own_key',
    },
    noteSource: "From the app's AI provider",
    passSource: "From the app's AI provider",
    payer: 'Your provider key',
    completion: 'A check was attempted; completion was not confirmed.',
  },
  {
    name: 'missing-legacy',
    noteMetadata: {
      source: null,
      source_provider: null,
      source_model: null,
      receipt_version: null,
    },
    provenance: null,
    noteSource: UNRECORDED,
    passSource: UNRECORDED,
    payer: 'Payment route not recorded',
    completion: 'Check completion not recorded.',
  },
  {
    name: 'legacy-source-only',
    noteMetadata: {
      source: 'creek_vault',
      source_provider: null,
      source_model: null,
      receipt_version: null,
    },
    provenance: {
      ...PASS,
      notes: { source: 'creek_vault', provider: 'creek', model: null, receipt_version: 1 },
      paid_by: 'free',
    },
    noteSource: 'From your Creek vault',
    passSource: 'From your Creek vault',
    payer: 'No Adepthood wallet charge',
    completion: 'No AI completion check was sent.',
  },
  {
    name: 'contradictory-provider',
    noteMetadata: { ...APP_NOTE, source: 'creek_vault' },
    provenance: { ...PASS, notes: { ...APP, source: 'creek_vault' } },
    noteSource: UNRECORDED,
    passSource: UNRECORDED,
    payer: 'Adepthood wallet',
    completion: 'No AI completion check was sent.',
  },
  {
    name: 'future-version',
    noteMetadata: { ...APP_NOTE, receipt_version: 2 },
    provenance: { ...PASS, notes: { ...APP, receipt_version: 2 } },
    noteSource: UNRECORDED,
    passSource: UNRECORDED,
    payer: 'Adepthood wallet',
    completion: 'No AI completion check was sent.',
  },
  {
    name: 'malformed-completion',
    noteMetadata: APP_NOTE,
    provenance: {
      ...PASS,
      detection: { ...APP, model: { forged: true } },
      detection_checked: null,
    },
    noteSource: "From the app's AI provider",
    passSource: "From the app's AI provider",
    payer: 'Adepthood wallet',
    completion: 'Check completion not recorded.',
  },
  {
    name: 'demo-payer-contradiction',
    noteMetadata: {
      source: 'demo',
      source_provider: 'stub',
      source_model: 'stub',
      receipt_version: 1,
    },
    provenance: {
      ...PASS,
      notes: { source: 'demo', provider: 'stub', model: 'stub', receipt_version: 1 },
    },
    noteSource: DEMO,
    passSource: DEMO,
    payer: 'Payment route not recorded',
    completion: 'No AI completion check was sent.',
  },
  ...(['app_provider', 'demo'] as const).map((source) => ({
    name: `legacy-unversioned-model-${source}`,
    noteMetadata: {
      source,
      source_provider: null,
      source_model: 'unsupported-legacy-model',
      receipt_version: null,
    },
    provenance: PASS,
    noteSource: UNRECORDED,
    passSource: "From the app's AI provider",
    payer: 'Adepthood wallet',
    completion: 'No AI completion check was sent.',
  })),
];

/** These overrides are intentionally hermetic client-boundary evidence, never server persistence proof. */
async function controlledResponses(
  page: Page,
  entryId: number,
  scenario: ControlledCase,
): Promise<void> {
  await page.route(`**/journal/${entryId}/resonance`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        marginalia: payload.marginalia.map((note: Record<string, unknown>) => ({
          ...note,
          ...scenario.noteMetadata,
          essay: 'The letter has its own source.',
          essay_source: 'demo',
          essay_generated_at: '2026-10-01T00:00:00Z',
        })),
        provenance: scenario.provenance,
      },
    });
  });
  await page.route(`**/journal/${entryId}/marginalia`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        items: payload.items.map((note: Record<string, unknown>) => ({
          ...note,
          ...scenario.noteMetadata,
          essay: 'The letter has its own source.',
          essay_source: 'demo',
          essay_generated_at: '2026-10-01T00:00:00Z',
        })),
      },
    });
  });
}

for (const width of [390, 1280]) {
  for (const scenario of CASES) {
    test(`controlled metadata ${scenario.name} preserves prose and independent operations at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const email = await signUp(page, 'receipt-controlled');
      const token = await tokenFor(page.request, email);
      const entryId = await writeFinishedPage(page, token);
      await controlledResponses(page, entryId, scenario);
      await openEntry(page, entryId);
      const pass = await requestPass(page, entryId);
      const noteId = pass.marginalia[0].id as number;
      const noteProse = pass.marginalia[0].note as string;
      const receipt = page.getByTestId('resonance-pass-receipt');
      await expect(receipt.getByTestId('resonance-pass-payer')).toHaveText(scenario.payer);
      await expect(receipt.getByText(scenario.completion, { exact: true })).toBeVisible();
      await expect(
        receipt.locator(
          '[data-testid="resonance-notes-source"], [data-testid="resonance-pass-source"]',
        ),
      ).toHaveText(scenario.passSource);
      await receipt.scrollIntoViewIfNeeded();
      await frame(page, `${scenario.name}-${width}-pass`);
      await page.reload();
      await openEntry(page, entryId);
      const note = page.getByTestId(`margin-note-${noteId}`);
      await expect(note.getByTestId(`margin-note-source-${noteId}`)).toHaveText(
        scenario.noteSource,
      );
      await expect(note).toContainText(noteProse);
      await expect(page.getByTestId('resonance-pass-receipt')).toHaveCount(0);
      await note.scrollIntoViewIfNeeded();
      await frame(page, `${scenario.name}-${width}-reload`);
      await note.click();
      await expect(page.getByTestId('essay-source')).toHaveText(DEMO);
      await expect(page.getByTestId('essay-text')).toHaveText('The letter has its own source.');
      await page.getByTestId('essay-close').click();
    });
  }
}

const LONG_MODEL = `reported-${'m'.repeat(55)}`;

async function enlargeMarginText(page: Page): Promise<void> {
  await page.getByTestId('journal-margin-column').evaluate((root) => {
    for (const node of root.querySelectorAll<HTMLElement>('*')) {
      if (node.childElementCount || !node.textContent?.trim()) continue;
      const style = getComputedStyle(node);
      node.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
      node.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
    }
  });
}

for (const width of [390, 1280]) {
  test(`long reported identity remains readable with 200% receipt text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'receipt-large-text');
    const token = await tokenFor(page.request, email);
    const entryId = await writeFinishedPage(page, token);
    const scenario = {
      ...CASES[0]!,
      name: 'long-model',
      noteMetadata: { ...APP_NOTE, source_model: LONG_MODEL },
      provenance: { ...PASS, notes: { ...APP, model: LONG_MODEL } },
    };
    await controlledResponses(page, entryId, scenario);
    await openEntry(page, entryId);
    await requestPass(page, entryId);
    await enlargeMarginText(page);
    const receipt = page.getByTestId('resonance-pass-receipt');
    const model = receipt.getByText(`Reported model: ${LONG_MODEL}`, { exact: true });
    await model.scrollIntoViewIfNeeded();
    await expect(model).toBeInViewport({ ratio: 1 });
    const bounds = await model.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await frame(page, `long-model-${width}-200-percent-top`);
    await receipt.getByTestId('resonance-pass-payer').scrollIntoViewIfNeeded();
    await expect(receipt.getByTestId('resonance-pass-payer')).toBeInViewport({ ratio: 1 });
    await frame(page, `long-model-${width}-200-percent-bottom`);
    await page.reload();
    await openEntry(page, entryId);
    await enlargeMarginText(page);
    const noteModel = page
      .locator('[data-testid^="margin-note-"]')
      .getByText(`Reported model: ${LONG_MODEL}`, { exact: true })
      .first();
    await noteModel.scrollIntoViewIfNeeded();
    await expect(noteModel).toBeInViewport({ ratio: 1 });
    await frame(page, `long-model-${width}-200-percent-reload`);
  });
}

for (const width of [390, 1280]) {
  test(`a real empty result differs from controlled request failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'receipt-empty');
    const token = await tokenFor(page.request, email);
    const entryId = await writeFinishedPage(
      page,
      token,
      'the heron waiting in the shallows without a sentence boundary',
    );
    const usedBefore = await monthlyUsed(page, token);
    await openEntry(page, entryId);
    const pass = await requestPass(page, entryId);
    expect(pass.marginalia).toEqual([]);
    expect(pass.provenance.paid_by).toBe('free');
    await expect(page.getByTestId('journal-resonance-no-notes')).toBeVisible();
    await expect(page.getByTestId('resonance-pass-payer')).toHaveText('No Adepthood wallet charge');
    expect(await monthlyUsed(page, token)).toBe(usedBefore);
    await frame(page, `empty-${width}`);
    let failedRequests = 0;
    await page.route(`**/journal/${entryId}/resonance`, async (route) => {
      failedRequests += 1;
      await route.fulfill({ status: 503, json: { detail: 'reflection_source_unavailable' } });
    });
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const continueButton = page.getByTestId('resonance-explainer-continue');
    const error = page.getByTestId('journal-resonance-error');
    await expect(continueButton.or(error)).toBeVisible();
    if (await continueButton.isVisible()) await continueButton.click();
    await expect(error).toBeVisible();
    expect(failedRequests).toBeGreaterThan(0);
    await expect(page.getByTestId('journal-resonance-no-notes')).toHaveCount(0);
    await expect(page.getByTestId('resonance-pass-receipt')).toHaveCount(0);
    await frame(page, `failure-${width}`);
  });
}
