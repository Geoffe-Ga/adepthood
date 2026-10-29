import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The corpus decision, offered beside the page after a first reflection, as a
 * rendered moment (#2407, #2408).
 *
 * A lane account signed up in the app has never decided about its corpus. It
 * asks a finished page for a real Resonance pass -- the lane's default provider
 * answers it with an anchored note -- and only once that reflection has landed
 * does a quiet note appear beside the page, never in its margin or over its
 * text. Not now and Do not ask again are one tap each, neither touches the
 * pass, and both are the server's to keep: ``GET /corpus/invitation`` is read
 * back after each, and a reload brings neither note back.
 *
 * One seam is the harness's: to prove the note waits for the reflection rather
 * than for the server's count, the real resonance response is held at the
 * browser after the server has answered it. The server has by then counted the
 * pass and would offer; nothing renders until the reflection lands.
 */

// A routed read can still be awaiting `route.fetch()` when the test ends (#3481).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const NOTE = 'journal-corpus-invitation';
const INVITATION_ROUTE = '/corpus/invitation';
const HTTP_OK = 200;
/** Long enough for any read a pass set off to have landed and rendered. */
const QUIET_PERIOD_MS = 1_500;
const PAGES = [
  'The heron waited at the edge of the reeds, older than the morning.',
  'A second page about the river, for the pass after a reload.',
];

interface InvitationStanding {
  offer: boolean;
  dismissed_at: string | null;
  do_not_ask_again: boolean;
}

interface PassAnswer {
  marginalia: { id: number }[];
}

function isCall(request: Request, method: string, path: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === path;
}

/** Every request the page sends, so a spec can say what was never sent. */
function recordRequests(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => sent.push(request));
  return sent;
}

function calls(sent: Request[], method: string, path: string): Request[] {
  return sent.filter((request) => isCall(request, method, path));
}

function resonancePath(entryId: number): string {
  return `/journal/${String(entryId)}/resonance`;
}

/** Write a finished page through the server's own journal routes. */
async function writeFinishedPage(page: Page, token: string, message: string): Promise<number> {
  const created = await page.request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: { title: message.slice(0, 24), message },
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

/** The server's own standing for the account, read out of band. */
async function standing(page: Page, token: string): Promise<InvitationStanding> {
  const response = await page.request.get(`${backendUrl()}${INVITATION_ROUTE}`, {
    headers: bearer(token),
  });
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as InvitationStanding;
}

/** The entry's margin notes as the server keeps them. */
async function keptNotes(page: Page, token: string, entryId: number): Promise<number[]> {
  const response = await page.request.get(`${backendUrl()}/journal/${String(entryId)}/marginalia`, {
    headers: bearer(token),
  });
  expect(response.status()).toBe(HTTP_OK);
  return ((await response.json()) as { items: { id: number }[] }).items.map((note) => note.id);
}

/** A fresh, undecided lane account with finished pages; answers its token and entry ids. */
async function undecidedWriter(
  page: Page,
  prefix: string,
): Promise<{ token: string; entryIds: number[] }> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  const entryIds: number[] = [];
  for (const message of PAGES) entryIds.push(await writeFinishedPage(page, token, message));
  expect(await standing(page, token)).toEqual({
    offer: false,
    dismissed_at: null,
    do_not_ask_again: false,
  });
  return { token, entryIds };
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

/** Press Get resonance, taking the spend disclosure's Continue when it is shown. */
async function pressGetResonance(page: Page, sent: Promise<unknown>): Promise<void> {
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const explainer = page.getByTestId('resonance-explainer-continue');
  const first = await Promise.race([
    sent.then(() => 'sent' as const),
    explainer.waitFor().then(() => 'explainer' as const),
  ]);
  if (first === 'explainer') await explainer.click();
  await sent;
}

/** Complete one pass, and wait for the invitation read it sets off. */
async function completePass(
  page: Page,
  entryId: number,
): Promise<{ pass: PassAnswer; invitation: InvitationStanding }> {
  const passed = page.waitForResponse((r) => isCall(r.request(), 'POST', resonancePath(entryId)));
  const invitationRead = page.waitForResponse((r) => isCall(r.request(), 'GET', INVITATION_ROUTE));
  await pressGetResonance(page, passed);
  const response = await passed;
  expect(response.status()).toBe(HTTP_OK);
  const read = await invitationRead;
  expect(read.status()).toBe(HTTP_OK);
  return {
    pass: (await response.json()) as PassAnswer,
    invitation: (await read.json()) as InvitationStanding,
  };
}

/** A note card in the margin column: the reflection has rendered. */
function marginNotes(page: Page) {
  return page.getByTestId('journal-margin-column').locator('[data-testid^="margin-note-open-"]');
}

/** Wait out every read a pass set off, then the note must still be absent. */
async function expectNoNote(page: Page): Promise<void> {
  await page.waitForTimeout(QUIET_PERIOD_MS);
  await expect(page.getByTestId(NOTE)).toHaveCount(0);
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Beside the page: on the screen, never in the margin column or the sheet, never over the text. */
async function expectBesideThePage(page: Page): Promise<void> {
  await expect(page.getByTestId('journal-screen').getByTestId(NOTE)).toHaveCount(1);
  await expect(page.getByTestId('journal-margin-column').getByTestId(NOTE)).toHaveCount(0);
  await expect(page.getByTestId('journal-sheet').getByTestId(NOTE)).toHaveCount(0);
  const noteBox = await page.getByTestId(NOTE).boundingBox();
  const bodyBox = await page.getByTestId('journal-body-read').boundingBox();
  expect(noteBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  if (noteBox && bodyBox) expect(overlaps(noteBox, bodyBox)).toBe(false);
}

/**
 * Hold the real resonance response for ``entryId`` at the browser, after the
 * server has answered it, until ``release`` is called.
 */
async function holdPass(
  page: Page,
  entryId: number,
): Promise<{ held: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => {
    markHeld = resolveHeld;
  });
  // Matched on the path alone: the pass carries the disclosed payer route as a query.
  const passUrl = (url: URL): boolean =>
    url.origin === new URL(backendUrl()).origin && url.pathname === resonancePath(entryId);
  await page.route(passUrl, async (route: Route) => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch();
      markHeld();
      await released;
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
  return { held, release };
}

/** Tap one decline and answer what the server recorded for it. */
async function decline(
  page: Page,
  control: 'dismiss' | 'never',
): Promise<{ sent: unknown; answered: InvitationStanding }> {
  const written = page.waitForResponse((r) => isCall(r.request(), 'PUT', INVITATION_ROUTE));
  await page.getByTestId(`${NOTE}-${control}`).click();
  // One tap: the note is gone at once, before the write has to land.
  await expect(page.getByTestId(NOTE)).toHaveCount(0);
  const response = await written;
  expect(response.status()).toBe(HTTP_OK);
  return {
    sent: response.request().postDataJSON() as unknown,
    answered: (await response.json()) as InvitationStanding,
  };
}

test('the note appears beside the page only once the reflection lands, and Not now is kept on the server', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const sent = recordRequests(page);
  const { token, entryIds } = await undecidedWriter(page, 'invitation-offer-not-now');
  const [first, second] = entryIds;
  if (first === undefined || second === undefined) throw new Error('the pages were not written');

  await openEntry(page, first);
  // Opening a page asks nothing: the offer waits for a completed pass.
  await expect(page.getByTestId(NOTE)).toHaveCount(0);
  expect(calls(sent, 'GET', INVITATION_ROUTE)).toHaveLength(0);

  // The server answers the pass and counts it; its answer is held on the way back.
  const hold = await holdPass(page, first);
  const passed = page.waitForResponse((r) => isCall(r.request(), 'POST', resonancePath(first)));
  const invitationRead = page.waitForResponse((r) => isCall(r.request(), 'GET', INVITATION_ROUTE));
  await pressGetResonance(page, hold.held);
  // The server would offer now -- yet nothing renders, and nothing is asked,
  // until the reflection is on the page.
  expect((await standing(page, token)).offer).toBe(true);
  await expectNoNote(page);
  expect(calls(sent, 'GET', INVITATION_ROUTE)).toHaveLength(0);
  await expect(marginNotes(page)).toHaveCount(0);

  hold.release();
  const pass = (await (await passed).json()) as PassAnswer;
  expect(pass.marginalia.length).toBeGreaterThan(0);
  await expect(marginNotes(page).first()).toBeVisible();
  expect(((await (await invitationRead).json()) as InvitationStanding).offer).toBe(true);
  await expect(page.getByTestId(NOTE)).toBeVisible();
  await expect(page.getByTestId(`${NOTE}-gain`)).toBeVisible();
  await expect(page.getByTestId(`${NOTE}-open`)).toBeVisible();
  await expectBesideThePage(page);

  const notesBefore = await keptNotes(page, token, first);
  const passesBefore = calls(sent, 'POST', resonancePath(first)).length;
  const notNow = await decline(page, 'dismiss');
  expect(notNow.sent).toEqual({ do_not_ask_again: false });
  expect(notNow.answered.offer).toBe(false);
  expect(notNow.answered.do_not_ask_again).toBe(false);
  expect(notNow.answered.dismissed_at).not.toBeNull();
  // Kept on the server, exactly as the write answered it.
  expect(await standing(page, token)).toEqual(notNow.answered);
  // The pass is untouched: its notes stay on the page and on the server, and
  // declining asked for nothing.
  await expect(marginNotes(page).first()).toBeVisible();
  expect(await keptNotes(page, token, first)).toEqual(notesBefore);
  expect(calls(sent, 'POST', resonancePath(first))).toHaveLength(passesBefore);

  // A fresh load and the next pass: the server's cooldown holds, so no note.
  await page.reload();
  await openEntry(page, second);
  const next = await completePass(page, second);
  expect(next.pass.marginalia.length).toBeGreaterThan(0);
  expect(next.invitation.offer).toBe(false);
  await expectNoNote(page);
  expect(await standing(page, token)).toEqual(notNow.answered);
});

test('Do not ask again is one tap, leaves the pass alone, and survives a reload', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const sent = recordRequests(page);
  const { token, entryIds } = await undecidedWriter(page, 'invitation-offer-never');
  const [first, second] = entryIds;
  if (first === undefined || second === undefined) throw new Error('the pages were not written');

  await openEntry(page, first);
  const opened = await completePass(page, first);
  expect(opened.invitation.offer).toBe(true);
  await expect(marginNotes(page).first()).toBeVisible();
  await expect(page.getByTestId(NOTE)).toBeVisible();
  await expectBesideThePage(page);

  const notesBefore = await keptNotes(page, token, first);
  const passesBefore = calls(sent, 'POST', resonancePath(first)).length;
  const never = await decline(page, 'never');
  expect(never.sent).toEqual({ do_not_ask_again: true });
  expect(never.answered.offer).toBe(false);
  expect(never.answered.do_not_ask_again).toBe(true);
  expect(await standing(page, token)).toEqual(never.answered);
  await expect(marginNotes(page).first()).toBeVisible();
  expect(await keptNotes(page, token, first)).toEqual(notesBefore);
  expect(calls(sent, 'POST', resonancePath(first))).toHaveLength(passesBefore);

  // A fresh load is a new mount with no memory of the tap: only the server's
  // standing can keep the note away now.
  await page.reload();
  await openEntry(page, second);
  const after = await completePass(page, second);
  expect(after.invitation.offer).toBe(false);
  expect(after.invitation.do_not_ask_again).toBe(true);
  await expectNoNote(page);
  expect(await standing(page, token)).toEqual(never.answered);
});
