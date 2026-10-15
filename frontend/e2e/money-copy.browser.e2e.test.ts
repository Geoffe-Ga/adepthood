import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

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

for (const width of WIDTHS) {
  test(`real app-provider keyless reading and letter open Settings without sending an ask at ${width}`, async ({
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
    let asks = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/resonance$|\/essay$/u.test(request.url())) asks += 1;
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
          response.url().endsWith(`/journal/${id}/resonance`) &&
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
      expect(written.request().postDataJSON()).toEqual({ price_acknowledged: true });
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
        expect(response.request().postDataJSON()).toEqual({ price_acknowledged: true });
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
    let asks = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/journal/${id}/resonance`))
        asks += 1;
    });
    // Only affordability is a controlled client response. The canonical route still comes from the real owner resolver.
    await page.route('**/user/usage', async (route) => {
      const actual = await route.fetch();
      const usage = await actual.json();
      expect(usage.resonance_route).toBe('vault_bound');
      await route.fulfill({
        response: actual,
        json: { ...usage, monthly_messages_remaining: 0, offering_balance: 0 },
      });
    });
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
    expect(asks).toBe(0);
    expect(wallet()).toEqual(before);
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
        response.url().endsWith(`/journal/${id}/resonance`) &&
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
      if (request.method() === 'POST' && request.url().endsWith(`/journal/${id}/resonance`))
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
