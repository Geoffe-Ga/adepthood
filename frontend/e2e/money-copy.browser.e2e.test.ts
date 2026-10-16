import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

import { backendUrl, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

const BODY = 'The willow bent all night and did not break. I woke grateful beside the water.';
const ARTIFACTS =
  process.env.MONEY_COPY_ARTIFACTS ?? join(__dirname, 'artifacts', 'money-copy-3262');
const WIDTHS = [390, 1280];

function lane() {
  const state = readLaneState();
  if (!state) throw new Error('money-copy browser lane state is missing');
  return state;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function createPage(page: Page, token: string): Promise<number> {
  const response = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'A price before a reading', message: BODY, classification: 'personal' },
  });
  expect(response.status()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  // Passage navigation and its explicit Open note action belong to read mode.
  const finished = await page.request.patch(`${backendUrl()}/journal/${id}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(200);
  expect(await finished.json()).toMatchObject({ id, status: 'finished' });
  return id;
}

async function openPage(page: Page, id: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${id}`).click();
}

async function loginVaultOwner(page: Page): Promise<string> {
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(200);
  const token = ((await response.json()) as { token: string }).token;
  expect(
    (
      await page.request.patch(`${backendUrl()}/ui-flags`, {
        headers: bearer(token),
        data: { has_seen_welcome: true },
      })
    ).status(),
  ).toBe(200);
  await page.goto(`${frontendUrl()}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(state.vaultOwnerEmail);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(state.vaultOwnerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Open Journal menu' })).toBeVisible();
  return token;
}

async function storeOwnKey(page: Page, key: string = lane().spentOpenaiKey): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key-button').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

/** Each text node uses its first computed snapshot, so a later modal cannot double it twice. */
async function doubleText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')].map((element) => {
      const style = getComputedStyle(element);
      element.dataset.moneyFont ??= style.fontSize;
      element.dataset.moneyLine ??= style.lineHeight;
      return {
        element,
        font: Number.parseFloat(element.dataset.moneyFont),
        line: Number.parseFloat(element.dataset.moneyLine),
      };
    });
    for (const { element, font, line } of sizes) {
      element.style.fontSize = `${font * 2}px`;
      if (Number.isFinite(line)) element.style.lineHeight = `${line * 2}px`;
    }
  });
}

async function reachable(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return (
        rect.width >= 44 &&
        rect.height >= 44 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        hit !== null &&
        element.contains(hit)
      );
    }),
  ).toBe(true);
  await locator.click({ trial: true });
}

async function capture(
  page: Page,
  name: string,
  root: Locator = page.getByRole('dialog').last(),
): Promise<void> {
  // Validate settled pixels, including a newly opened modal's first frame.
  await expect
    .poll(() =>
      root.evaluate((root) => {
        if (
          root
            .getAnimations({ subtree: true })
            .some(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
        )
          return false;
        let node: Element | null = root;
        while (node !== null) {
          if (Number(getComputedStyle(node).opacity) !== 1) return false;
          node = node.parentElement;
        }
        return true;
      }),
    )
    .toBe(true);
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: false });
}

async function completeCopy(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const bounds = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    type GlyphBounds = Pick<
      DOMRect,
      'x' | 'y' | 'width' | 'height' | 'top' | 'right' | 'bottom' | 'left'
    >;
    const visibleFailures: { character: string; rect: GlyphBounds }[] = [];
    const whitespaceOverflow: { character: string; rect: GlyphBounds }[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let visibleCharacters = 0;
    while (node !== null) {
      let offset = 0;
      for (const character of node.textContent ?? '') {
        const range = document.createRange();
        range.setStart(node, offset);
        offset += character.length;
        range.setEnd(node, offset);
        const whitespace = /\s/u.test(character);
        visibleCharacters += whitespace ? 0 : 1;
        const failures = whitespace ? whitespaceOverflow : visibleFailures;
        failures.push(
          ...[...range.getClientRects()]
            .filter(
              (glyph) =>
                glyph.left < box.left - 1 ||
                glyph.right > box.right + 1 ||
                glyph.top < box.top - 1 ||
                glyph.bottom > box.bottom + 1,
            )
            .map((rect) => ({ character, rect: rect.toJSON() as GlyphBounds })),
        );
      }
      node = walker.nextNode();
    }
    return {
      box: box.toJSON(),
      viewportFits:
        box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      visibleCharacters,
      visibleFailures,
      whitespaceOverflow,
    };
  });
  expect(
    bounds.viewportFits && bounds.visibleCharacters > 0 && bounds.visibleFailures.length === 0,
    JSON.stringify(bounds),
  ).toBe(true);
}

async function settingsHintFrames(page: Page, width: number): Promise<void> {
  await expect(page.getByTestId('essay-modal')).toHaveCount(0);
  await expect(page.getByTestId('resonance-explainer')).toHaveCount(0);
  const hint = page.getByTestId('no-key-hint');
  await expect(hint).toContainText('Resonance notes and letters can still come from your vault');
  await completeCopy(hint);
  await capture(
    page,
    `settings-no-key-${width}-normal`,
    page.getByTestId('api-key-settings-screen'),
  );
  await doubleText(page);
  await completeCopy(hint);
  await capture(
    page,
    `settings-no-key-${width}-200-percent`,
    page.getByTestId('api-key-settings-screen'),
  );
}

async function removeKeyFrames(page: Page, width: number): Promise<void> {
  await page.goto(`${frontendUrl()}/api-key-settings`);
  await page.getByTestId('remove-key-button').click();
  const dialog = page.getByTestId('remove-key-dialog');
  await expect(dialog).toContainText('Resonance notes and letters can still come from your vault');
  const message = dialog.getByText(/Without your own key/u);
  await completeCopy(message);
  await capture(page, `settings-remove-key-${width}-normal`);
  await doubleText(page);
  await completeCopy(message);
  await reachable(page.getByTestId('remove-key-confirm'));
  await reachable(page.getByTestId('remove-key-cancel'));
  await capture(page, `settings-remove-key-${width}-200-percent`);
  await page.getByTestId('remove-key-cancel').click();
  await expect(page.getByTestId('stored-key-card')).toBeVisible();
}

interface VaultLedger {
  received: Array<{ method: string; path: string }>;
  fragments: unknown[];
}

async function vaultLedger(page: Page): Promise<VaultLedger> {
  const response = await page.request.get(`${lane().vaultUrl}/__lane/uploads`, {
    headers: bearer(lane().vaultApiKey),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as VaultLedger;
}

function wallet(): { monthly_messages_used: number; offering_balance: number; rows: unknown[] } {
  return JSON.parse(
    runBackendModule('tests.e2e.wallet_audit', ['show', '--email', lane().vaultOwnerEmail]),
  );
}

/** Control only affordability; the canonical route still comes from the real owner resolver. */
async function serveEmptyVaultWallet(page: Page): Promise<void> {
  await page.route('**/user/usage', async (route) => {
    const actual = await route.fetch();
    const usage = await actual.json();
    expect(usage.resonance_route).toBe('vault_bound');
    await route.fulfill({
      response: actual,
      json: { ...usage, monthly_messages_remaining: 0, offering_balance: 0 },
    });
  });
}

/** Every resonance POST for ``id``, whatever query string it carries. */
function recordResonanceAsks(page: Page, id: number): Request[] {
  const asks: Request[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/journal/${id}/resonance`
    )
      asks.push(request);
  });
  return asks;
}

/** The single free-exits ask an empty-wallet press sends (#3389): no key, no charge. */
async function expectOneFreeExitsAsk(asks: Request[], status: number): Promise<void> {
  expect(asks).toHaveLength(1);
  const [ask] = asks;
  expect(new URL(ask!.url()).searchParams.get('free_only')).toBe('true');
  expect(ask!.headers()['x-llm-api-key']).toBeUndefined();
  expect((await ask!.response())?.status()).toBe(status);
}

/** The vault's generation traffic: a free answer must never dial it. */
async function vaultReflections(page: Page): Promise<VaultLedger['received']> {
  return (await vaultLedger(page)).received.filter(
    (item) => item.path === '/v1/reflections' || item.path.startsWith('/v1/letters/'),
  );
}

for (const width of WIDTHS) {
  test(`real armed demo reading and first letter stay free at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, `money-demo-${width}`);
    const token = await tokenFor(page.request, email);
    await page.goto(`${frontendUrl()}/api-key-settings`);
    await expect(page.getByTestId('no-key-hint')).toBeVisible();
    await expect(page.getByTestId('stored-key-card')).toHaveCount(0);
    const id = await createPage(page, token);
    const usage = () => page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) });
    const beforeResponse = await usage();
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json();
    expect(before.resonance_route).toBe('app_provider');
    expect(before.resonance_demo_available).toBe(true);
    expect(before.monthly_messages_remaining > 0 || before.offering_balance > 0).toBe(true);
    const providerBefore = await (
      await page.request.get(`${lane().providerUrl}/__lane/attempts`)
    ).json();
    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const cost = page.getByTestId('resonance-explainer-cost');
    await expect(cost).toHaveText('Demo — not a real reflection. No Adepthood wallet charge.');
    await doubleText(page);
    await completeCopy(cost);
    await capture(page, `demo-reading-${width}-200-percent-cost`);
    await reachable(page.getByTestId('resonance-explainer-cancel'));
    const proceed = page.getByTestId('resonance-explainer-continue');
    await reachable(proceed);
    await capture(page, `demo-reading-${width}-200-percent-actions`);
    expect(await (await usage()).json()).toEqual(before);
    const settled = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        new URL(reply.url()).pathname === `/journal/${id}/resonance`,
    );
    const invitationRead = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'GET' &&
        new URL(reply.url()).pathname === '/corpus/invitation',
    );
    await proceed.click();
    const response = await settled;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['x-llm-api-key']).toBeUndefined();
    const pass = await response.json();
    expect(pass.provenance.paid_by).toBe('free');
    expect(pass.provenance.notes).toMatchObject({ source: 'demo', provider: 'stub' });
    const invitation = await invitationRead;
    expect(invitation.status()).toBe(200);
    if ((await invitation.json()).offer) {
      const dismissed = page.waitForResponse(
        (reply) =>
          reply.request().method() === 'PUT' &&
          new URL(reply.url()).pathname === '/corpus/invitation',
      );
      await page.getByTestId('journal-corpus-invitation-dismiss').click();
      expect((await dismissed).status()).toBe(200);
      await expect(page.getByTestId('journal-corpus-invitation')).toHaveCount(0);
    }
    await expect(page.getByTestId('resonance-pass-source')).toContainText('Demo');
    expect(await (await usage()).json()).toEqual(before);
    const note = pass.marginalia[0] as { id: number } | undefined;
    expect(note).toBeDefined();
    await page.getByTestId(`margin-note-open-${note!.id}`).click();
    const letterCost = page.getByTestId('essay-ask-cost');
    await expect(letterCost).toHaveText(
      'Demo — not a real reflection. No Adepthood wallet charge.',
    );
    await doubleText(page);
    await completeCopy(letterCost);
    await capture(page, `demo-letter-${width}-200-percent-cost`);
    await reachable(page.getByTestId('essay-not-now'));
    const ask = page.getByTestId('essay-ask');
    await reachable(ask);
    await capture(page, `demo-letter-${width}-200-percent-actions`);
    expect(await (await usage()).json()).toEqual(before);
    const letterResponse = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        reply.url().endsWith(`/marginalia/${note!.id}/essay`),
    );
    await ask.click();
    const written = await letterResponse;
    expect(written.status()).toBe(200);
    expect(written.request().headers()['x-llm-api-key']).toBeUndefined();
    expect(written.request().postDataJSON()).toEqual({
      price_acknowledged: true,
      disclosed_route: 'app_provider',
    });
    expect((await written.json()).essay_source).toBe('demo');
    await expect(page.getByTestId('essay-source')).toHaveText('Demo — not a real reflection');
    await expect(page.getByTestId('essay-text')).toBeVisible();
    const letterText = await page.getByTestId('essay-text').innerText();
    await page.getByTestId('essay-close').click();
    await page.reload();
    await openPage(page, id);
    await expect(page.getByTestId(`margin-note-source-${note!.id}`)).toHaveText(
      'Demo — not a real reflection',
    );
    await page.getByTestId(`margin-note-open-${note!.id}`).click();
    await expect(page.getByTestId('essay-source')).toHaveText('Demo — not a real reflection');
    await expect(page.getByTestId('essay-text')).toHaveText(letterText);
    expect(await (await usage()).json()).toEqual(before);
    expect(await (await page.request.get(`${lane().providerUrl}/__lane/attempts`)).json()).toEqual(
      providerBefore,
    );
  });
}

for (const width of WIDTHS) {
  test(`controlled production app-provider keyless reading and letter open Settings without an ask at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, `money-keyless-${width}`);
    const token = await tokenFor(page.request, email);
    const id = await createPage(page, token);
    const usageResponse = await page.request.get(`${backendUrl()}/user/usage`, {
      headers: bearer(token),
    });
    expect(usageResponse.status()).toBe(200);
    const before = await usageResponse.json();
    expect(before.resonance_route).toBe('app_provider');
    // The lane allows demos. Control only that capability to exercise the
    // production key-required admission; the real backend is not claimed keyless.
    await page.route('**/user/usage', async (route) => {
      const actual = await route.fetch();
      const usage = await actual.json();
      expect(usage.resonance_route).toBe('app_provider');
      await route.fulfill({
        response: actual,
        json: { ...usage, resonance_demo_available: false },
      });
    });
    let asks = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/resonance$|\/essay$/u.test(new URL(request.url()).pathname)
      )
        asks += 1;
    });
    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const refill = page.getByTestId('resonance-explainer');
    await expect(refill).toContainText('This needs your own API key');
    await expect(refill).not.toContainText(/BotMason|buy|credit packs/iu);
    await doubleText(page);
    await capture(page, `app-keyless-reading-${width}-200-percent-lead`);
    const addKey = page.getByTestId('resonance-explainer-open-settings');
    await reachable(addKey);
    await capture(page, `app-keyless-reading-${width}-200-percent`);
    expect(asks).toBe(0);
    await addKey.focus();
    await expect(addKey).toBeFocused();
    await addKey.press('Enter');
    await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
    expect(
      await (
        await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) })
      ).json(),
    ).toEqual(before);

    // Seed only the note through the lane's declared demo seam; the UI letter ask is still counted separately.
    const seeded = await page.request.post(`${backendUrl()}/journal/${id}/resonance`, {
      headers: bearer(token),
    });
    expect(seeded.status()).toBe(200);
    const note = ((await seeded.json()) as { marginalia: { id: number }[] }).marginalia[0];
    expect(note).toBeDefined();
    asks = 0;
    await openPage(page, id);
    await page.getByTestId(`margin-note-open-${note!.id}`).click();
    await expect(page.getByTestId('essay-ask-cost')).toHaveText(
      'This needs your own API key. Add one in Settings to ask for this letter.',
    );
    await expect(page.getByTestId('essay-ask')).toHaveCount(0);
    await doubleText(page);
    await capture(page, `app-keyless-letter-${width}-200-percent-lead`);
    const letterAddKey = page.getByTestId('essay-open-settings');
    await reachable(letterAddKey);
    await capture(page, `app-keyless-letter-${width}-200-percent`);
    await letterAddKey.focus();
    await expect(letterAddKey).toBeFocused();
    await letterAddKey.press('Enter');
    await expect(page.getByTestId('api-key-settings-screen')).toBeVisible();
    expect(asks).toBe(0);
    await settingsHintFrames(page, width);
  });

  for (const hasKey of [false, true]) {
    test(`real vault reading and first letter use credits, own key=${hasKey} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const token = await loginVaultOwner(page);
      if (hasKey) await storeOwnKey(page);
      const id = await createPage(page, token);
      const route = await page.request.get(`${backendUrl()}/user/usage`, {
        headers: bearer(token),
      });
      expect((await route.json()).resonance_route).toBe('vault_bound');
      await openPage(page, id);
      await page.getByRole('button', { name: 'Get resonance' }).click();
      await expect(page.getByTestId('resonance-explainer-cost')).toContainText('BotMason');
      await expect(page.getByTestId('resonance-explainer-cost')).not.toContainText(
        /key pays|pays instead/u,
      );
      await doubleText(page);
      const proceed = page.getByTestId('resonance-explainer-continue');
      await capture(
        page,
        `vault-reading-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent-initial`,
      );
      await reachable(proceed);
      await capture(page, `vault-reading-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent`);
      const before = wallet();
      const providerBefore = await (
        await page.request.get(`${lane().providerUrl}/__lane/attempts`)
      ).json();
      const settled = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/journal/${id}/resonance` &&
          response.request().method() === 'POST',
      );
      const invitationRead = page.waitForResponse(
        (reply) =>
          reply.request().method() === 'GET' &&
          new URL(reply.url()).pathname === '/corpus/invitation',
      );
      await proceed.click();
      const response = await settled;
      expect(response.status()).toBe(200);
      const invitation = await invitationRead;
      expect(invitation.status()).toBe(200);
      if ((await invitation.json()).offer) {
        // Set aside the separate invitation before reading the margin.
        const declined = page.waitForResponse(
          (reply) =>
            reply.request().method() === 'PUT' &&
            new URL(reply.url()).pathname === '/corpus/invitation',
        );
        await page.getByTestId('journal-corpus-invitation-dismiss').click();
        expect((await declined).status()).toBe(200);
        await expect(page.getByTestId('journal-corpus-invitation')).toHaveCount(0);
      }
      expect(Boolean(response.request().headers()['x-llm-api-key'])).toBe(hasKey);
      const payload = (await response.json()) as {
        marginalia: { id: number }[];
        provenance: { paid_by: string };
      };
      expect(payload.provenance.paid_by).toBe('wallet');
      expect(
        await (await page.request.get(`${lane().providerUrl}/__lane/attempts`)).json(),
      ).toEqual(providerBefore);
      const note = payload.marginalia[0];
      expect(note).toBeDefined();
      const after = wallet();
      expect(after.monthly_messages_used).toBe(before.monthly_messages_used + 1);
      expect(after.offering_balance).toBe(before.offering_balance);
      expect(after.rows.length).toBe(before.rows.length + 1);
      await page.getByTestId(`margin-note-open-${note!.id}`).click();
      await expect(page.getByTestId('essay-ask-cost')).toContainText('This letter spends one');
      await expect(page.getByTestId('essay-ask-cost')).not.toContainText(/key pays|not available/u);
      await expect(page.getByTestId('essay-open-settings')).toHaveCount(0);
      await doubleText(page);
      await page.getByTestId('essay-ask-cost').scrollIntoViewIfNeeded();
      await capture(
        page,
        `vault-letter-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent-cost`,
      );
      await reachable(page.getByTestId('essay-not-now'));
      const ask = page.getByTestId('essay-ask');
      await reachable(ask);
      await capture(page, `vault-letter-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent`);
      expect(wallet()).toEqual(after);
      // Neither a stored key nor opening the offer consents to the one-unit charge.
      const vaultBefore = await vaultLedger(page);
      const letterResponse = page.waitForResponse((reply) =>
        reply.url().endsWith(`/marginalia/${note!.id}/essay`),
      );
      await ask.focus();
      await expect(ask).toBeFocused();
      await ask.press('Enter');
      const written = await letterResponse;
      expect(written.status()).toBe(200);
      expect(written.request().postDataJSON()).toEqual({
        price_acknowledged: true,
        disclosed_route: 'vault_bound',
      });
      expect(Boolean(written.request().headers()['x-llm-api-key'])).toBe(hasKey);
      await expect(page.getByTestId('essay-text')).toHaveText(
        'The lane vault wrote this letter back to you.',
      );
      const paidLetter = wallet();
      expect(paidLetter.monthly_messages_used).toBe(after.monthly_messages_used + 1);
      expect(paidLetter.offering_balance).toBe(after.offering_balance);
      expect(paidLetter.rows.length).toBe(after.rows.length + 1);
      expect(
        await (await page.request.get(`${lane().providerUrl}/__lane/attempts`)).json(),
      ).toEqual(providerBefore);
      const ledger = await vaultLedger(page);
      expect(ledger.received.filter((item) => item.path.startsWith('/v1/letters/'))).toHaveLength(
        vaultBefore.received.filter((item) => item.path.startsWith('/v1/letters/')).length + 1,
      );
      await page.getByTestId('essay-close').click();
      await expect(page.getByTestId('essay-modal')).toHaveCount(0);
      const cachedOpen = page.getByTestId(`margin-note-open-${note!.id}`);
      await reachable(cachedOpen);
      await cachedOpen.click();
      await expect(page.getByTestId('essay-text')).toHaveText(
        'The lane vault wrote this letter back to you.',
      );
      await expect(page.getByTestId('essay-ask')).toHaveCount(0);
      expect(wallet()).toEqual(paidLetter);
      expect(await vaultLedger(page)).toEqual(ledger);
      await doubleText(page);
      await completeCopy(page.getByTestId('essay-text'));
      await capture(
        page,
        `vault-cached-letter-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent`,
      );
    });
  }
}

for (const width of WIDTHS) {
  for (const hasKey of [false, true]) {
    test(`missing vault letter capability refuses without charge or fallback, key=${hasKey} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const token = await loginVaultOwner(page);
      if (hasKey) await storeOwnKey(page);
      const id = await createPage(page, token);
      const reading = await page.request.post(`${backendUrl()}/journal/${id}/resonance`, {
        headers: bearer(token),
      });
      expect(reading.status()).toBe(200);
      const note = ((await reading.json()) as { marginalia: { id: number }[] }).marginalia[0];
      expect(note).toBeDefined();
      await openPage(page, id);
      await page.getByTestId(`margin-note-open-${note!.id}`).click();
      const ask = page.getByTestId('essay-ask');
      await expect(page.getByTestId('essay-ask-cost')).toContainText('This letter spends one');
      const before = wallet();
      const vaultBefore = await vaultLedger(page);
      const providerBefore = await (
        await page.request.get(`${lane().providerUrl}/__lane/attempts`)
      ).json();
      expect(
        (
          await page.request.post(`${lane().vaultUrl}/__lane/hold-letters`, {
            headers: bearer(lane().vaultApiKey),
          })
        ).status(),
      ).toBe(200);
      try {
        const refused = page.waitForResponse((reply) =>
          reply.url().endsWith(`/marginalia/${note!.id}/essay`),
        );
        await ask.click();
        const response = await refused;
        expect(response.status()).toBe(503);
        expect(await response.json()).toMatchObject({ detail: 'reflection_source_unavailable' });
        expect(response.request().postDataJSON()).toEqual({
          price_acknowledged: true,
          disclosed_route: 'vault_bound',
        });
        await expect(page.getByTestId('essay-error')).toContainText('nothing was charged');
        await doubleText(page);
        await page.getByTestId('essay-error').scrollIntoViewIfNeeded();
        await capture(
          page,
          `vault-letter-missing-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent-lead`,
        );
        await reachable(page.getByTestId('essay-retry'));
        await capture(
          page,
          `vault-letter-missing-${hasKey ? 'own-key' : 'no-key'}-${width}-200-percent`,
        );
        expect(wallet()).toEqual(before);
        const ledger = await vaultLedger(page);
        expect(ledger.received.filter((item) => item.path.startsWith('/v1/letters/'))).toEqual(
          vaultBefore.received.filter((item) => item.path.startsWith('/v1/letters/')),
        );
        expect(
          await (await page.request.get(`${lane().providerUrl}/__lane/attempts`)).json(),
        ).toEqual(providerBefore);
      } finally {
        expect(
          (
            await page.request.post(`${lane().vaultUrl}/__lane/release-letters`, {
              headers: bearer(lane().vaultApiKey),
            })
          ).status(),
        ).toBe(200);
      }
    });
  }
}

for (const width of WIDTHS) {
  test(`controlled empty vault wallet offers only a configured credit pack at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const token = await loginVaultOwner(page);
    await storeOwnKey(page);
    const id = await createPage(page, token);
    const before = wallet();
    const vaultBefore = await vaultReflections(page);
    const asks = recordResonanceAsks(page, id);
    await serveEmptyVaultWallet(page);
    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const refill = page.getByTestId('journal-resonance-refill');
    await expect(refill).toContainText(
      'Readings your vault answers use BotMason credits, even when an API key is saved.',
    );
    await expect(page.getByTestId('journal-resonance-refill-add-key')).toHaveCount(0);
    const packUrl = process.env.EXPO_PUBLIC_CREDIT_PACK_URL ?? '';
    const pack = page.getByTestId('journal-resonance-refill-credit-pack-link');
    if (packUrl) {
      await expect(pack).toBeVisible();
      await expect(refill).toContainText(
        'Use the same email address as your Adepthood account when you buy, so the credits reach you.',
      );
    } else {
      await expect(pack).toHaveCount(0);
      await expect(refill).not.toContainText(/buy|credit packs|add more/iu);
    }
    await doubleText(page);
    const cancel = page.getByTestId('journal-resonance-refill-cancel');
    await capture(
      page,
      `vault-wallet-pack-${packUrl ? 'set' : 'unset'}-${width}-200-percent-initial`,
    );
    await reachable(cancel);
    if (packUrl) await reachable(pack);
    await capture(page, `vault-wallet-pack-${packUrl ? 'set' : 'unset'}-${width}-200-percent`);
    if (packUrl) {
      await page
        .context()
        .route(packUrl, (route) =>
          route.fulfill({ contentType: 'text/html', body: '<p>Controlled pack destination</p>' }),
        );
      const opened = page.waitForEvent('popup');
      await pack.click();
      const destination = await opened;
      await expect(destination).toHaveURL(packUrl);
      await destination.close();
    }
    await reachable(cancel);
    await cancel.click();
    await expect(refill).toHaveCount(0);
    // The press asked the server for free answers only. The real wallet is
    // funded, so the server refused to turn that ask into an undisclosed
    // charge (409), and the controlled reread still found it empty.
    await expectOneFreeExitsAsk(asks, 409);
    expect(wallet()).toEqual(before);
    expect(await vaultReflections(page)).toEqual(vaultBefore);
  });
}

const DISTRESS_BODY = 'I keep thinking I want to kill myself and end my life tonight.';
const INTIMATE_REASON =
  "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection.";

for (const width of WIDTHS) {
  test(`controlled empty vault wallet still shows a server-intimate page its privacy reason at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const token = await loginVaultOwner(page);
    await storeOwnKey(page);
    const id = await createPage(page, token);
    await serveEmptyVaultWallet(page);
    await openPage(page, id);
    await expect(page.getByRole('button', { name: 'Get resonance' })).toBeEnabled();
    // Another device makes the page intimate after this screen loaded it.
    const narrowed = await page.request.patch(`${backendUrl()}/journal/${id}`, {
      headers: bearer(token),
      data: { classification: 'intimate' },
    });
    expect(narrowed.status()).toBe(200);
    const before = wallet();
    const vaultBefore = await vaultReflections(page);
    const asks = recordResonanceAsks(page, id);

    await page.getByRole('button', { name: 'Get resonance' }).click();

    const reason = page.getByTestId('privacy-resonance-reason');
    await expect(reason).toHaveText(INTIMATE_REASON);
    await expect(page.getByTestId('journal-resonance-refill')).toHaveCount(0);
    await expect(page.getByTestId('resonance-explainer')).toHaveCount(0);
    await expectOneFreeExitsAsk(asks, 200);
    expect(await asks[0]!.response().then((reply) => reply?.json())).toMatchObject({
      private: true,
      marginalia: [],
      private_message: INTIMATE_REASON,
    });
    expect(wallet()).toEqual(before);
    expect(await vaultReflections(page)).toEqual(vaultBefore);
    await completeCopy(reason);
    await capture(page, `vault-empty-intimate-${width}`, page.locator('body'));
    await doubleText(page);
    await completeCopy(reason);
    await capture(page, `vault-empty-intimate-${width}-200-percent`, page.locator('body'));
  });

  test(`controlled empty vault wallet still gives a distressed page its care at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const token = await loginVaultOwner(page);
    await storeOwnKey(page);
    const created = await page.request.post(`${backendUrl()}/journal/`, {
      headers: bearer(token),
      data: { title: 'A heavy night', message: DISTRESS_BODY, classification: 'personal' },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    const finished = await page.request.patch(`${backendUrl()}/journal/${id}`, {
      headers: bearer(token),
      data: { status: 'finished' },
    });
    expect(finished.status()).toBe(200);
    await serveEmptyVaultWallet(page);
    const before = wallet();
    const vaultBefore = await vaultReflections(page);
    const asks = recordResonanceAsks(page, id);
    await openPage(page, id);

    await page.getByRole('button', { name: 'Get resonance' }).click();

    const card = page.getByTestId('care-support-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('988');
    await expect(page.getByTestId('journal-resonance-refill')).toHaveCount(0);
    await expectOneFreeExitsAsk(asks, 200);
    const answer = await asks[0]!.response().then((reply) => reply?.json());
    expect(answer).toMatchObject({ private: false, marginalia: [] });
    expect(answer.care).not.toBeNull();
    expect(wallet()).toEqual(before);
    expect(await vaultReflections(page)).toEqual(vaultBefore);
    await card.scrollIntoViewIfNeeded();
    await capture(page, `vault-empty-care-${width}`, page.locator('body'));
    await doubleText(page);
    await card.scrollIntoViewIfNeeded();
    await capture(page, `vault-empty-care-${width}-200-percent`, page.locator('body'));
  });
}

const PAYER_CHANGED =
  'Nothing was charged. How this would be paid for changed since you looked, so here it is again.';

/**
 * Serve ``app_provider`` as the disclosed route while ``stale()`` holds: the
 * price a writer read before another device connected this vault (#3385).
 * Only that field changes; the real owner resolver still decides every POST.
 */
async function serveRouteReadBeforeVaultConnected(page: Page, stale: () => boolean): Promise<void> {
  await page.route('**/user/usage', async (route) => {
    const actual = await route.fetch();
    const usage = await actual.json();
    expect(usage.resonance_route).toBe('vault_bound');
    const served = stale() ? { ...usage, resonance_route: 'app_provider' } : usage;
    await route.fulfill({ response: actual, json: served });
  });
}

/** Read the notice and the price at normal and doubled text, with both arms reachable. */
async function payerChangedFrames(
  page: Page,
  name: string,
  notice: Locator,
  arms: Locator[],
): Promise<void> {
  await expect(notice).toHaveText(PAYER_CHANGED);
  await completeCopy(notice);
  await capture(page, `${name}-normal`);
  await doubleText(page);
  await completeCopy(notice);
  for (const arm of arms) await reachable(arm);
  await capture(page, `${name}-200-percent`);
}

for (const width of WIDTHS) {
  test(`controlled route change after a key-funded disclosure asks again before any charge at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const token = await loginVaultOwner(page);
    await storeOwnKey(page);
    const id = await createPage(page, token);
    const asks = recordResonanceAsks(page, id);
    let letterAsks = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/essay'))
        letterAsks += 1;
    });
    let staleFor: 'reading' | 'letter' | null = 'reading';
    await serveRouteReadBeforeVaultConnected(
      page,
      () =>
        (staleFor === 'reading' && asks.length === 0) ||
        (staleFor === 'letter' && letterAsks === 0),
    );
    const providerAttempts = async (): Promise<unknown> =>
      (await page.request.get(`${lane().providerUrl}/__lane/attempts`)).json();
    const before = wallet();
    const vaultBefore = await vaultReflections(page);
    const providerBefore = await providerAttempts();

    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const cost = page.getByTestId('resonance-explainer-cost');
    await expect(cost).toHaveText(
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    );
    await expect(page.getByTestId('resonance-explainer-payer-changed')).toHaveCount(0);
    const refused = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        new URL(reply.url()).pathname === `/journal/${id}/resonance`,
    );
    await page.getByTestId('resonance-explainer-continue').click();
    const refusal = await refused;
    expect(refusal.status()).toBe(409);
    expect(await refusal.json()).toEqual({ detail: 'resonance_payment_unconfirmed' });
    expect(new URL(refusal.url()).searchParams.get('disclosed_route')).toBe('app_provider');
    await expect(cost).toContainText('BotMason');
    expect(wallet()).toEqual(before);
    expect(await vaultReflections(page)).toEqual(vaultBefore);
    expect(await providerAttempts()).toEqual(providerBefore);
    await payerChangedFrames(
      page,
      `route-changed-reading-${width}`,
      page.getByTestId('resonance-explainer-payer-changed'),
      [
        page.getByTestId('resonance-explainer-continue'),
        page.getByTestId('resonance-explainer-cancel'),
      ],
    );

    // Confirmed on the route now in force: one vault reading, one credit.
    const settled = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        new URL(reply.url()).pathname === `/journal/${id}/resonance`,
    );
    await page.getByTestId('resonance-explainer-continue').click();
    const reading = await settled;
    expect(reading.status()).toBe(200);
    expect(new URL(reading.url()).searchParams.get('disclosed_route')).toBe('vault_bound');
    expect(asks).toHaveLength(2);
    const paid = wallet();
    expect(paid.monthly_messages_used).toBe(before.monthly_messages_used + 1);
    expect(paid.rows.length).toBe(before.rows.length + 1);
    const note = ((await reading.json()) as { marginalia: { id: number }[] }).marginalia[0];
    expect(note).toBeDefined();

    // The letter: its offer was priced before the vault connected too.
    staleFor = 'letter';
    await openPage(page, id);
    const invitation = page.getByTestId('journal-corpus-invitation-dismiss');
    if (await invitation.isVisible()) await invitation.click();
    await page.getByTestId(`margin-note-open-${note!.id}`).click();
    const letterCost = page.getByTestId('essay-ask-cost');
    await expect(letterCost).toHaveText(
      'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
    );
    const letterRefused = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        reply.url().endsWith(`/marginalia/${note!.id}/essay`),
    );
    await page.getByTestId('essay-ask').click();
    const letterRefusal = await letterRefused;
    expect(letterRefusal.status()).toBe(409);
    expect(await letterRefusal.json()).toEqual({ detail: 'essay_price_unacknowledged' });
    expect(letterRefusal.request().postDataJSON()).toEqual({
      price_acknowledged: true,
      disclosed_route: 'app_provider',
    });
    await expect(letterCost).toContainText('This letter spends one');
    expect(wallet()).toEqual(paid);
    await payerChangedFrames(
      page,
      `route-changed-letter-${width}`,
      page.getByTestId('essay-payer-changed'),
      [page.getByTestId('essay-ask'), page.getByTestId('essay-not-now')],
    );
    const written = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' &&
        reply.url().endsWith(`/marginalia/${note!.id}/essay`),
    );
    await page.getByTestId('essay-ask').click();
    const letter = await written;
    expect(letter.status()).toBe(200);
    expect(letter.request().postDataJSON()).toEqual({
      price_acknowledged: true,
      disclosed_route: 'vault_bound',
    });
    await expect(page.getByTestId('essay-text')).toHaveText(
      'The lane vault wrote this letter back to you.',
    );
    expect(wallet().monthly_messages_used).toBe(paid.monthly_messages_used + 1);
    expect(await providerAttempts()).toEqual(providerBefore);
  });
}

for (const width of WIDTHS) {
  test(`real app-provider own key pays without a wallet debit at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, `money-own-key-${width}`);
    const token = await tokenFor(page.request, email);
    await storeOwnKey(page, lane().throttledOpenaiKey);
    const id = await createPage(page, token);
    const before = await (
      await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) })
    ).json();
    expect(before.resonance_route).toBe('app_provider');
    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    await expect(page.getByTestId('resonance-explainer-cost')).toHaveText(
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    );
    await doubleText(page);
    const proceed = page.getByTestId('resonance-explainer-continue');
    await reachable(proceed);
    await capture(page, `app-own-key-reading-${width}-200-percent`);
    const settled = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/journal/${id}/resonance` &&
        response.request().method() === 'POST',
    );
    expect(
      (await page.request.post(`${lane().providerUrl}/__lane/enable-receipt-reflection`)).status(),
    ).toBe(200);
    try {
      await proceed.click();
      const response = await settled;
      expect(response.status()).toBe(200);
      expect(Boolean(response.request().headers()['x-llm-api-key'])).toBe(true);
      expect((await response.json()).provenance.paid_by).toBe('own_key');
      expect(
        await (
          await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) })
        ).json(),
      ).toEqual(before);
    } finally {
      expect(
        (
          await page.request.post(`${lane().providerUrl}/__lane/disable-receipt-reflection`)
        ).status(),
      ).toBe(200);
    }
    await removeKeyFrames(page, width);
  });

  test(`controlled unknown route discloses no payer and sends no ask at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, `money-unknown-${width}`);
    const token = await tokenFor(page.request, email);
    await storeOwnKey(page);
    const id = await createPage(page, token);
    const before = await (
      await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) })
    ).json();
    let asks = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/journal/${id}/resonance`
      )
        asks += 1;
    });
    // A rolling server may not yet expose route metadata. This controlled response
    // removes only that field; it does not claim the backend returns an unknown route.
    await page.route('**/user/usage', async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      delete value.resonance_route;
      await route.fulfill({ response, json: value });
    });
    await openPage(page, id);
    await page.getByRole('button', { name: 'Get resonance' }).click();
    const cost = page.getByTestId('resonance-explainer-cost');
    await expect(cost).toContainText("We couldn't check how this reading would be paid for.");
    await expect(cost).not.toContainText(/spends|key pays/u);
    await expect(page.getByTestId('resonance-explainer-continue')).toBeDisabled();
    await doubleText(page);
    const cancel = page.getByTestId('resonance-explainer-cancel');
    await reachable(cancel);
    await capture(page, `unknown-route-${width}-200-percent`);
    await cancel.click();
    expect(asks).toBe(0);
    expect(
      await (
        await page.request.get(`${backendUrl()}/user/usage`, { headers: bearer(token) })
      ).json(),
    ).toEqual(before);
  });
}
