import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  BYOK_DETAIL_DISCLOSURE,
  BYOK_HUB_DISCLOSURE,
} from '../src/features/Settings/byokDisclosure';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';
import { runBackendModule } from './laneDatabase';
import { readLaneState } from './laneState';

/** Real persistence/withdrawal observations are separate from explicitly controlled client refusals. */
const BODY = 'The heron stood in the shallows.';
const CARE_BODY = `${BODY} I keep thinking I want to kill myself and end my life tonight.`;
const ARTIFACTS = join(__dirname, 'artifacts', 'privacy-choices-3275');

function lane() {
  const state = readLaneState();
  if (!state) throw new Error('Missing isolated browser lane');
  return state;
}

async function vaultControl(page: Page, command: 'hold' | 'release'): Promise<void> {
  const state = lane();
  const response = await page.request.post(
    `${state.vaultUrl}/__lane/${command}-journal-withdrawals`,
    {
      headers: bearer(state.vaultApiKey),
    },
  );
  expect(response.status()).toBe(200);
}

interface Ledger {
  received: Array<{ method: string; externalId: string | null; action?: string }>;
  fragments: Array<{ kind: string; externalId: string }>;
}

async function vaultLedger(page: Page): Promise<Ledger> {
  const state = lane();
  const response = await page.request.get(`${state.vaultUrl}/__lane/uploads`, {
    headers: bearer(state.vaultApiKey),
  });
  expect(response.status()).toBe(200);
  return response.json();
}

function retains(ledger: Ledger, id: number): boolean {
  return ledger.fragments.some((row) => row.kind === 'journal' && row.externalId === String(id));
}

async function frame(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

/** A fixed band can cover a mid-scroll control; prove both edges clear at the real scroll end. */
async function finishReachable(page: Page): Promise<void> {
  const finish = page.getByTestId('journal-finish-button');
  await expect(finish).toBeEnabled();
  await expect
    .poll(
      async () => {
        await page.getByTestId('journal-page-scroll').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return finish.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return [box.top + 2, box.bottom - 2].every((y) => {
            const hit = document.elementFromPoint(box.left + box.width / 2, y);
            return hit !== null && (hit === node || node.contains(hit));
          });
        });
      },
      { message: 'Finish must clear the floating timer at its top and bottom' },
    )
    .toBe(true);
}

/** Double rendered text from one computed snapshot; no compounded inheritance or OS zoom claim. */
async function enlargeText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const entries = [...document.querySelectorAll<HTMLElement>('[dir="auto"]')]
      .filter((node) => node.dataset.e2eTextEnlarged !== 'true')
      .map((node) => {
        const style = getComputedStyle(node);
        return { node, size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
      });
    for (const { node, size, line } of entries) {
      node.style.fontSize = `${size * 2}px`;
      if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`;
      node.dataset.e2eTextEnlarged = 'true';
    }
  });
}

async function loginOwner(page: Page): Promise<string> {
  const state = lane();
  const response = await page.request.post(`${backendUrl()}/auth/login`, {
    data: { email: state.vaultOwnerEmail, password: state.vaultOwnerPassword },
  });
  expect(response.status()).toBe(200);
  const token = ((await response.json()) as { token: string }).token;
  // Set only the welcome flag through its real API; owner signup precedes browser startup.
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

async function createPage(page: Page, token: string, message = BODY): Promise<number> {
  const response = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: 'At the shallows', message, classification: 'personal' },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

async function openPage(page: Page, id: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${id}`).click();
}

async function editFinishedPage(page: Page): Promise<void> {
  await page.getByTestId('journal-edit-button').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Edit this entry', exact: true })
    .click();
  await expect(page.getByTestId('journal-body-input')).toBeVisible();
}

function tier(page: Page) {
  return page.locator('[data-testid="privacy-tier-intimate"]:visible');
}

/** Arrange only the historical missing destination; request and withdrawal paths stay real. */
function copyOrigin(command: 'mark-unrecorded' | 'show', id: number) {
  return JSON.parse(
    runBackendModule('tests.e2e.journal_copy_origin', [
      command,
      '--email',
      lane().vaultOwnerEmail,
      '--entry-id',
      String(id),
    ]),
  ) as {
    entry_id: number;
    deleted_here: boolean;
    destination: string | null;
    obligation: string | null;
    obligation_destination: string | null;
  };
}

/** Measure actual clipping ancestors, not a Text inline box that permits glyph overhang. */
async function readableHint(page: Page, testId: string, blockerId: string): Promise<void> {
  const hint = page.getByTestId(testId);
  await hint.scrollIntoViewIfNeeded();
  // Browser auto-scroll sees the scroller, not the floating timer. A writer
  // can wheel the disclosure above it using the page's existing end padding.
  const hintBox = await hint.boundingBox();
  const blockerBox = await page.getByTestId(blockerId).boundingBox();
  expect(hintBox).not.toBeNull();
  expect(blockerBox).not.toBeNull();
  if (
    hintBox!.y < blockerBox!.y + blockerBox!.height &&
    hintBox!.y + hintBox!.height > blockerBox!.y
  ) {
    const scroll = page.getByTestId(
      blockerId === 'bottom-fade' ? 'journal-shelf-list' : 'journal-page-scroll',
    );
    await scroll.hover({ position: { x: 4, y: 4 } });
    await page.mouse.wheel(0, hintBox!.y + hintBox!.height - blockerBox!.y + 4);
    await expect
      .poll(async () => {
        const moved = await hint.boundingBox();
        const band = await page.getByTestId(blockerId).boundingBox();
        return moved !== null && band !== null && moved.y + moved.height <= band.y;
      })
      .toBe(true);
  }
  await expect(hint).toBeInViewport({ ratio: 0.99 });
  const geometry = await hint.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    let left = 0;
    let right = innerWidth;
    let top = 0;
    let bottom = innerHeight;
    for (let parent: Element | null = node; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/^(hidden|clip|auto|scroll)$/u.test(style.overflowX)) {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (/^(hidden|clip|auto|scroll)$/u.test(style.overflowY)) {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    return {
      left,
      right,
      top,
      bottom,
      lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({
        left,
        right,
        top,
        bottom,
      })),
    };
  });
  expect(geometry.lines.length).toBeGreaterThan(0);
  const blocker = await page.getByTestId(blockerId).boundingBox();
  expect(blocker).not.toBeNull();
  await test.info().attach(`${testId}-geometry`, {
    body: JSON.stringify({ geometry, blocker }),
    contentType: 'application/json',
  });
  await frame(page, `diagnostic-${testId}-${String(page.viewportSize()?.width)}`);
  for (const line of geometry.lines) {
    expect(line.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(line.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(line.top).toBeGreaterThanOrEqual(geometry.top - 1);
    expect(line.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
    expect(line.bottom <= blocker!.y || line.top >= blocker!.y + blocker!.height).toBe(true);
  }
}

for (const width of [390, 1280]) {
  test(`real pending Intimate keeps editing while its vault copy remains, then independently confirms removal at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const token = await loginOwner(page);
    const id = await createPage(page, token);
    await expect.poll(async () => retains(await vaultLedger(page), id)).toBe(true);
    await vaultControl(page, 'hold');
    try {
      await openPage(page, id);
      const changed = page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/journal/${id}`,
      );
      await tier(page).click();
      expect((await changed).status()).toBe(503);
      await expect(tier(page)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('journal-save-hint')).toContainText('not been confirmed');
      expect(retains(await vaultLedger(page), id)).toBe(true);
      await enlargeText(page);
      await page.getByTestId('journal-save-hint').scrollIntoViewIfNeeded();
      await frame(page, `pending-intimate-${width}-200-percent`);
      await finishReachable(page);
      await frame(page, `pending-intimate-${width}-200-percent-finish-clear`);
      const finished = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          new URL(r.url()).pathname === `/journal/${id}` &&
          r.request().postDataJSON()?.status === 'finished',
      );
      await page.getByTestId('journal-finish-button').click();
      expect((await finished).status()).toBe(200);
      await expect(page.getByTestId('journal-body-read')).toBeVisible();
      await editFinishedPage(page);
      await page.getByTestId('journal-body-input').fill(`${BODY} I stayed a while.`);
      await expect(page.getByTestId('journal-save-hint')).toHaveText('Saved');
      await page.reload();
      await openPage(page, id);
      await expect(page.getByTestId('journal-body-read')).toBeVisible();
      await editFinishedPage(page);
      await expect(tier(page)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('journal-body-input')).toHaveValue(`${BODY} I stayed a while.`);
      const stored = await page.request.get(`${backendUrl()}/journal/${id}`, {
        headers: bearer(token),
      });
      expect((await stored.json()).classification).toBe('intimate');
      // GET's tier and editable prose do not establish remote withdrawal: the vault still holds it.
      expect(retains(await vaultLedger(page), id)).toBe(true);
      await frame(page, `pending-intimate-${width}-reload`);
    } finally {
      await vaultControl(page, 'release');
    }
    // Observe the application's real background sweep; no manual tier resend or mocked GET.
    await expect
      .poll(async () => retains(await vaultLedger(page), id), { timeout: 65_000 })
      .toBe(false);
    expect(
      (await vaultLedger(page)).received.some(
        (row) =>
          row.method === 'DELETE' && row.externalId === String(id) && row.action === 'withdrawn',
      ),
    ).toBe(true);
  });

  test(`real unrecorded pending DELETE gives neutral save and Finish hints and reachable recovery at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const token = await loginOwner(page);
    const id = await createPage(page, token);
    await expect.poll(async () => retains(await vaultLedger(page), id)).toBe(true);
    for (let index = 0; index < 12; index += 1)
      await createPage(page, token, `A later page ${index}.`);
    await vaultControl(page, 'hold');
    try {
      expect(copyOrigin('mark-unrecorded', id).destination).toBeNull();
      await openPage(page, id);
      const deletion = await page.request.delete(`${backendUrl()}/journal/${id}`, {
        headers: bearer(token),
      });
      expect(deletion.status()).toBe(503);
      expect((await deletion.json()).detail).toBe('vault_withdrawal_unrecorded_vault');
      expect(copyOrigin('show', id)).toMatchObject({
        deleted_here: false,
        obligation: 'pending_delete',
        obligation_destination: null,
      });
      const save = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/journal/${id}`,
      );
      await page.getByTestId('journal-body-input').fill(`${BODY} These words cannot be saved.`);
      expect((await save).status()).toBe(409);
      const hint = page.getByTestId('journal-save-hint');
      await expect(hint).toContainText('Deletion has not finished');
      await expect(hint).not.toContainText(/once|vault confirms|reconnect/iu);
      await expect(page.getByTestId('journal-save-retry')).toHaveCount(0);
      await enlargeText(page);
      await readableHint(page, 'journal-save-hint', 'writing-session-band-content');
      await frame(page, `unrecorded-delete-save-${width}-200-percent`);
      await finishReachable(page);
      const finish = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/journal/${id}`,
      );
      await page.getByTestId('journal-finish-button').click();
      expect((await finish).status()).toBe(409);
      await expect(page.getByTestId('journal-finish-error')).toContainText(
        'Deletion has not finished',
      );
      await expect(page.getByTestId('journal-finish-error')).not.toContainText(
        /once|vault confirms|reconnect/iu,
      );
      // The failure mounts after the first text snapshot; enlarge its new glyphs too.
      await enlargeText(page);
      await readableHint(page, 'journal-finish-error', 'writing-session-band-content');
      await frame(page, `unrecorded-delete-finish-${width}-200-percent`);
      const stored = await page.request.get(`${backendUrl()}/journal/${id}`, {
        headers: bearer(token),
      });
      expect(stored.status()).toBe(200);
      expect((await stored.json()).message).toBe(BODY);

      await page.goto(`${frontendUrl()}/journal`);
      const shelf = page.getByTestId('journal-shelf-list');
      const remove = page.getByTestId(`journal-shelf-delete-${id}`);
      await remove.scrollIntoViewIfNeeded();
      expect(await shelf.evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
      await remove.click();
      await page.getByTestId('journal-delete-confirm').click();
      await expect(page.getByTestId('journal-delete-error')).toContainText(
        'cannot identify the vault',
      );
      await expect(page.getByTestId('journal-delete-error')).toBeInViewport();
      await expect(page.getByTestId('journal-unreachable-reconnect')).toHaveCount(0);
      await enlargeText(page);
      // The long explanation is in the shelf's scrollable header; read it above
      // the fixed action band just as a person scrolls the shelf.
      await page.getByTestId('journal-unreachable-explainer').hover();
      await page.mouse.wheel(0, 200);
      await readableHint(page, 'journal-unreachable-explainer', 'bottom-fade');
      const erase = page.getByTestId('journal-unreachable-erase');
      await erase.scrollIntoViewIfNeeded();
      await expect(erase).toBeInViewport();
      const eraseBox = await erase.boundingBox();
      expect(eraseBox).not.toBeNull();
      expect(eraseBox!.height).toBeGreaterThanOrEqual(44);
      expect(eraseBox!.width).toBeGreaterThanOrEqual(44);
      await readableHint(page, 'journal-unreachable-erase', 'bottom-fade');
      await erase.click({ trial: true });
      await frame(page, `unrecorded-delete-recovery-${width}-200-percent`);
      if (width === 1280) {
        await erase.focus();
        await expect(erase).toBeFocused();
        await page.keyboard.press('Enter');
      } else {
        await erase.click();
      }
      await expect(page.getByTestId('journal-erasure-receipt')).toContainText(
        'a copy may still be in a Creek vault you connected earlier',
      );
      expect(copyOrigin('show', id)).toMatchObject({
        deleted_here: true,
        obligation: 'unconfirmed',
        obligation_destination: null,
      });
      expect(retains(await vaultLedger(page), id)).toBe(true);
      expect(
        (
          await page.request.get(`${backendUrl()}/journal/${id}`, { headers: bearer(token) })
        ).status(),
      ).toBe(404);
    } finally {
      await vaultControl(page, 'release');
    }
  });

  test(`real pending DELETE locks editing until recorded vault removal confirms at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const token = await loginOwner(page);
    const id = await createPage(page, token);
    await expect.poll(async () => retains(await vaultLedger(page), id)).toBe(true);
    await vaultControl(page, 'hold');
    try {
      await page.goto(`${frontendUrl()}/journal`);
      await page.getByTestId(`journal-shelf-delete-${id}`).click();
      await expect(page.getByTestId('journal-delete-dialog-body')).toContainText(
        'may remain until the vault confirms',
      );
      const removed = page.waitForResponse(
        (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/journal/${id}`,
      );
      await page.getByTestId('journal-delete-confirm').click();
      expect((await removed).status()).toBe(503);
      await expect(page.getByTestId('journal-delete-error')).toContainText(
        'set to be deleted and cannot be edited',
      );
      expect(retains(await vaultLedger(page), id)).toBe(true);
      const edit = await page.request.patch(`${backendUrl()}/journal/${id}`, {
        headers: bearer(token),
        data: { message: 'Refused edit.' },
      });
      expect(edit.status()).toBe(409);
      expect((await edit.json()).detail).toBe('journal_entry_deletion_pending');
      await frame(page, `pending-delete-${width}`);
    } finally {
      await vaultControl(page, 'release');
    }
    await expect
      .poll(async () => retains(await vaultLedger(page), id), { timeout: 65_000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          (
            await page.request.get(`${backendUrl()}/journal/${id}`, { headers: bearer(token) })
          ).status(),
        { timeout: 10_000 },
      )
      .toBe(404);
  });

  test(`controlled deep-shelf unrecorded DELETE never offers reconnect as confirmation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'unrecorded-delete');
    const token = await tokenFor(page.request, email);
    const id = await createPage(page, token);
    for (let index = 0; index < 12; index += 1)
      await createPage(page, token, `Another page ${index}.`);
    // This controls a historical refusal's client presentation, not actual remote state.
    await page.route(`**/journal/${id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'vault_withdrawal_unrecorded_vault' }),
      });
    });
    await page.goto(`${frontendUrl()}/journal`);
    const shelf = page.getByTestId('journal-shelf-list');
    await expect
      .poll(async () => {
        await shelf.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return page.getByTestId(`journal-shelf-delete-${id}`).isVisible();
      })
      .toBe(true);
    await page.getByTestId(`journal-shelf-delete-${id}`).scrollIntoViewIfNeeded();
    expect(await shelf.evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
    await page.getByTestId(`journal-shelf-delete-${id}`).click();
    await page.getByTestId('journal-delete-confirm').click();
    const notice = page.getByTestId('journal-delete-error');
    // A refusal must come into view without asking someone to guess where it went.
    await expect(notice).toBeInViewport();
    await expect(notice).toContainText('cannot identify the vault');
    await expect(notice).toContainText('removal cannot be confirmed');
    await expect(page.getByTestId('journal-unreachable-reconnect')).toHaveCount(0);
    await expect(page.getByTestId(`journal-shelf-card-${id}`)).toBeVisible();
    await enlargeText(page);
    await notice.scrollIntoViewIfNeeded();
    await frame(page, `controlled-unrecorded-delete-${width}-200-percent-notice`);
    const erase = page.getByTestId('journal-unreachable-erase');
    await erase.scrollIntoViewIfNeeded();
    await expect(erase).toBeInViewport();
    await erase.click({ trial: true });
    await expect(page.getByTestId('journal-unreachable-explainer')).toContainText("can't confirm");
    await frame(page, `controlled-unrecorded-delete-${width}-200-percent-choice`);
    const explainer = page.getByTestId('journal-unreachable-explainer');
    await explainer.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(explainer).toBeInViewport({ ratio: 0.99 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await frame(page, `controlled-unrecorded-delete-${width}-200-percent-explainer-settled`);
    const lastLine = await explainer.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = [...range.getClientRects()].filter((box) => box.height > 0);
      const last = lines[lines.length - 1];
      if (last === undefined) throw new Error('The privacy explainer has no rendered text line');
      return { top: last.top, bottom: last.bottom };
    });
    const fade = await page.getByTestId('bottom-fade').boundingBox();
    expect(fade).not.toBeNull();
    expect(
      lastLine.bottom <= fade!.y || lastLine.top >= fade!.y + fade!.height,
      'The final privacy explainer line must clear the fixed bottom fade',
    ).toBe(true);
  });

  for (const detail of [
    'vault_withdrawal_previous_vault',
    'vault_withdrawal_disconnected_vault',
    'vault_withdrawal_unrecorded_vault',
  ]) {
    test(`controlled ${detail} remains editable and gives only its supported destination advice at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const email = await signUp(page, 'privacy-destination');
      const token = await tokenFor(page.request, email);
      const id = await createPage(page, token);
      await page.route(
        (url) => url.pathname === `/journal/${id}`,
        async (route) => {
          if (
            route.request().method() !== 'PATCH' ||
            route.request().postDataJSON()?.classification !== 'intimate'
          )
            return route.continue();
          const original = await route.fetch();
          expect(original.status()).toBe(200);
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ detail }),
          });
        },
      );
      await openPage(page, id);
      await tier(page).click();
      const hint = page.getByTestId('journal-save-hint');
      if (detail === 'vault_withdrawal_unrecorded_vault') {
        await expect(hint).toContainText('cannot identify the vault');
        await expect(hint).not.toContainText('reconnect that vault');
      } else await expect(hint).toContainText('reconnect that vault in Settings');
      await expect(page.getByTestId('journal-body-input')).toBeEditable();
      await expect(tier(page)).toHaveAttribute('aria-checked', 'true');
      await enlargeText(page);
      await hint.scrollIntoViewIfNeeded();
      await frame(page, `controlled-${detail}-${width}-200-percent`);
      await finishReachable(page);
      await frame(page, `controlled-${detail}-${width}-200-percent-finish-clear`);
    });
  }

  test(`real care and own-key inference receipts coexist and persisted identity reloads at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const state = lane();
    const email = await signUp(page, 'care-receipt');
    const token = await tokenFor(page.request, email);
    const id = await createPage(page, token, CARE_BODY);
    expect(
      (
        await page.request.patch(`${backendUrl()}/journal/${id}`, {
          headers: bearer(token),
          data: { status: 'finished' },
        })
      ).status(),
    ).toBe(200);
    expect(
      (await page.request.post(`${state.providerUrl}/__lane/enable-receipt-reflection`)).status(),
    ).toBe(200);
    try {
      await page.goto(`${frontendUrl()}/api-key-settings`);
      await page.getByTestId('api-key-input').fill(state.throttledOpenaiKey);
      await page.getByTestId('save-key-button').click();
      await expect(page.getByTestId('stored-key-card')).toBeVisible();
      await openPage(page, id);
      const invitationRead = page.waitForResponse(
        (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/corpus/invitation',
      );
      const answered = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === `/journal/${id}/resonance`,
      );
      await page.getByRole('button', { name: 'Get resonance' }).click();
      await page.getByTestId('resonance-explainer-continue').click();
      const response = await answered;
      expect(response.status()).toBe(200);
      const result = await response.json();
      const invitation = await invitationRead;
      expect(invitation.status()).toBe(200);
      if ((await invitation.json()).offer) {
        const declined = page.waitForResponse(
          (r) =>
            r.request().method() === 'PUT' && new URL(r.url()).pathname === '/corpus/invitation',
        );
        await page.getByTestId('journal-corpus-invitation-dismiss').click();
        expect((await declined).status()).toBe(200);
        await expect(page.getByTestId('journal-corpus-invitation')).toHaveCount(0);
      }
      expect(result.care).not.toBeNull();
      expect(result.provenance.paid_by).toBe('own_key');
      expect(result.provenance.notes).toMatchObject({
        source: 'app_provider',
        provider: 'openai',
        receipt_version: 1,
      });
      expect(result.marginalia.length).toBeGreaterThan(0);
      await expect(page.getByTestId('care-support-card')).toBeVisible();
      const receipt = page.getByTestId('resonance-pass-receipt');
      await expect(receipt.getByTestId('resonance-pass-payer')).toHaveText('Your provider key');
      await frame(page, `care-and-receipt-${width}-care`);
      await page.getByTestId('care-dismiss').click();
      await expect(page.getByTestId('care-reopen')).toBeVisible();
      await receipt.scrollIntoViewIfNeeded();
      await expect(receipt.getByTestId('resonance-pass-payer')).toBeInViewport();
      await frame(page, `care-and-receipt-${width}-receipt`);
      await page.getByTestId('care-reopen').click();
      await expect(page.getByTestId('care-support-card')).toBeVisible();
      await page.reload();
      await openPage(page, id);
      await expect(page.getByTestId('resonance-pass-receipt')).toHaveCount(0);
      const note = page.getByTestId(`margin-note-${result.marginalia[0].id}`);
      await expect(note).toContainText('Reported provider: OpenAI');
      await note.scrollIntoViewIfNeeded();
      await frame(page, `care-and-receipt-${width}-reload`);
    } finally {
      expect(
        (
          await page.request.post(`${state.providerUrl}/__lane/disable-receipt-reflection`)
        ).status(),
      ).toBe(200);
    }
  });

  test(`Settings shows the approved page-direct and server-relay disclosure before saving a key at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const email = await signUp(page, 'privacy-disclosure');
    const token = await tokenFor(page.request, email);
    // Skip is an actual UI action; await its persisted flag before a hard navigation.
    await expect
      .poll(async () => {
        const response = await page.request.get(`${backendUrl()}/ui-flags`, {
          headers: bearer(token),
        });
        expect(response.status()).toBe(200);
        return (await response.json()).has_seen_welcome;
      })
      .toBe(true);
    await page.goto(`${frontendUrl()}/settings`);
    await expect(page.getByText(BYOK_HUB_DISCLOSURE, { exact: true })).toBeVisible();
    await page.goto(`${frontendUrl()}/api-key-settings`);
    await expect(page.getByTestId('api-key-input')).toBeEmpty();
    await expect(page.getByText(BYOK_DETAIL_DISCLOSURE, { exact: true })).toBeVisible();
    await enlargeText(page);
    await page.getByText(BYOK_DETAIL_DISCLOSURE, { exact: true }).scrollIntoViewIfNeeded();
    await frame(page, `settings-disclosure-${width}-200-percent-copy`);
    await page.getByTestId('api-key-input').scrollIntoViewIfNeeded();
    await frame(page, `settings-disclosure-${width}-200-percent`);
  });

  for (const detail of ['ai_access_revoked', 'other_forbidden']) {
    test(`controlled photograph admission ${detail} has its truthful retry affordance at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await signUp(page, 'privacy-transcription');
      await page.goto(`${frontendUrl()}/api-key-settings`);
      await page.getByTestId('api-key-input').fill(lane().throttledOpenaiKey);
      await page.getByTestId('save-key-button').click();
      await expect(page.getByTestId('stored-key-card')).toBeVisible();
      let requests = 0;
      await page.route('**/journal/transcribe-page/direct-admission', async (route) => {
        requests += 1;
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ detail }),
        });
      });
      await page.goto(`${frontendUrl()}/journal`);
      await page.getByRole('button', { name: 'Open Journal menu' }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('journal-photograph-entry').click();
      await (
        await chooser
      ).setFiles(join(__dirname, '..', 'assets', 'cards', 'rws', 'the_sun.png'));
      await expect(page.getByTestId('capture-transcribe')).toBeEnabled();
      await page.getByTestId('capture-transcribe').click();
      const error = page.getByTestId('photograph-block-1-error');
      if (detail === 'ai_access_revoked') {
        await expect(error).toContainText('membership is no longer active. Nothing was charged.');
        await expect(page.getByTestId('photograph-block-1-retry')).toHaveCount(0);
        await expect(page.getByTestId('photograph-typed-entry')).toBeVisible();
      } else {
        await expect(page.getByTestId('photograph-block-1-retry')).toBeVisible();
        await page.getByTestId('photograph-block-1-retry').click();
        await expect.poll(() => requests).toBe(2);
        await expect(error).toContainText("Something didn't work while reading this page.");
      }
      await enlargeText(page);
      await error.scrollIntoViewIfNeeded();
      await frame(page, `controlled-transcription-${detail}-${width}-200-percent`);
      const wayOut =
        detail === 'ai_access_revoked'
          ? page.getByTestId('photograph-typed-entry')
          : page.getByTestId('photograph-block-1-retry');
      await wayOut.scrollIntoViewIfNeeded();
      await expect(wayOut).toBeInViewport();
      expect(
        await wayOut.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          return [box.top + 2, box.bottom - 2].every((y) => {
            const hit = document.elementFromPoint(x, y);
            return hit !== null && (hit === node || node.contains(hit));
          });
        }),
      ).toBe(true);
      await frame(page, `controlled-transcription-${detail}-${width}-200-percent-actions`);
      await wayOut.click();
      if (detail === 'ai_access_revoked')
        await expect(page.getByTestId('journal-body-input')).toBeVisible();
      else await expect.poll(() => requests).toBe(3);
    });
  }
}
