import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The offer to sort the rest of the writing, as a rendered moment (#3598).
 *
 * A writer with a standing yes for the journal, whose earlier pages predate
 * that yes, asks a page for resonance. Once the pass has completed, a quiet
 * note beside the page -- never over it -- offers to open the sort-the-rest
 * screen (#3500). Everything here crosses the real seam: a lane account signed
 * up through the app, its pages and its consent written through the server's
 * own routes, a real resonance pass, and the server's own answers to
 * ``GET /corpus/consent`` and ``GET /corpus/sweep`` deciding what renders.
 *
 * One seam is the harness's, because the lane cannot produce it: the server
 * never offers the consent invitation to an account that has already decided,
 * so "the decision about sorting outranks an offer to sort" is driven by
 * holding the real ``GET /corpus/invitation`` answer at the browser and, for
 * the outranking case, rewriting only its ``offer`` bit. The same hold is what
 * proves #3604 across the seam: the sweep note's three reads land first, and it
 * still waits for the invitation's check to settle.
 */

// A routed read can still be awaiting `route.fetch()` when the test ends, and
// that fetch then rejects with "Test ended" outside any test (#3481).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const OFFER = 'journal-corpus-sweep-offer';
const INVITATION = 'journal-corpus-invitation';
const SWEEP_ROUTE = '/corpus/sweep';
const INVITATION_ROUTE = '/corpus/invitation';
const CONSENT_ROUTE = '/corpus/consent';
const HTTP_OK = 200;
/** Long enough for any read a pass set off to have landed and rendered. */
const QUIET_PERIOD_MS = 1_500;
/** Pages written before the yes: what the note counts as still unsorted. */
const PAGES = [
  'The heron waited at the edge of the reeds, older than the morning.',
  'A second page about the river, written long before sorting was on.',
  'A third page: the tide went out and left the stones talking.',
  'A fourth page, for the pass after a reload.',
];

function isCall(request: Request, method: string, path: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === path;
}

/** Every request the page sends, so a spec can say what was never sent. */
function recordRequests(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => sent.push(request));
  return sent;
}

function sweepPosts(sent: Request[]): Request[] {
  return sent.filter((request) => isCall(request, 'POST', SWEEP_ROUTE));
}

function sweepReads(sent: Request[]): Request[] {
  return sent.filter((request) => isCall(request, 'GET', SWEEP_ROUTE));
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

/**
 * A lane account whose pages predate its yes for the journal: signed up in the
 * app, pages written, then the yes given -- all through the server's routes.
 */
async function writerWithABacklog(page: Page, prefix: string): Promise<number[]> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  const entryIds: number[] = [];
  for (const message of PAGES) entryIds.push(await writeFinishedPage(page, token, message));
  const granted = await page.request.put(`${backendUrl()}${CONSENT_ROUTE}/journal`, {
    headers: bearer(token),
    data: { granted: true },
  });
  expect(granted.status()).toBe(HTTP_OK);
  const estimate = await page.request.get(`${backendUrl()}${SWEEP_ROUTE}`, {
    headers: bearer(token),
  });
  expect(estimate.status()).toBe(HTTP_OK);
  expect(((await estimate.json()) as { entries_pending: number }).entries_pending).toBeGreaterThan(
    0,
  );
  return entryIds;
}

async function openEntry(page: Page, entryId: number): Promise<void> {
  await page.goto(`${frontendUrl()}/journal`);
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await expect(page.getByTestId('journal-body-read')).toBeVisible();
}

/**
 * Close the open page back to the shelf and open another -- inside the running
 * app, so this is the same session. A ``goto`` would boot the app afresh, which
 * is a new session as far as Not now is concerned.
 */
async function openAnotherEntryInSession(page: Page, entryId: number): Promise<void> {
  await page.getByRole('button', { name: 'Close — return to your journal' }).click();
  // The closed page's screen can stay mounted behind the shelf; open the
  // entry from the shelf that is actually on screen.
  await page
    .getByTestId(`journal-shelf-open-${String(entryId)}`)
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId('journal-body-read').filter({ visible: true })).toBeVisible();
}

/**
 * Ask the open page for a Resonance pass, through the spend disclosure when it
 * is shown, and wait for the pass to complete.
 */
async function askForPass(page: Page, entryId: number): Promise<void> {
  const passed = page.waitForResponse((r) =>
    isCall(r.request(), 'POST', `/journal/${String(entryId)}/resonance`),
  );
  await page.getByRole('button', { name: 'Get resonance' }).click();
  const explainer = page.getByTestId('resonance-explainer-continue');
  const first = await Promise.race([
    passed.then(() => 'passed' as const),
    explainer.waitFor().then(() => 'explainer' as const),
  ]);
  if (first === 'explainer') await explainer.click();
  expect((await passed).status()).toBe(HTTP_OK);
}

/** Complete one pass and wait for the invitation's read the pass sets off. */
async function completePass(page: Page, entryId: number): Promise<void> {
  const invitationRead = page.waitForResponse((r) => isCall(r.request(), 'GET', INVITATION_ROUTE));
  await askForPass(page, entryId);
  expect((await invitationRead).status()).toBe(HTTP_OK);
}

/** Wait out every read a pass set off, then the note must still be absent. */
async function expectNoOffer(page: Page): Promise<void> {
  await page.waitForTimeout(QUIET_PERIOD_MS);
  await expect(page.getByTestId(OFFER)).toHaveCount(0);
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('after a completed pass the offer renders beside the page, and its affirmative only opens the sort screen', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent = recordRequests(page);
  const [entryId] = await writerWithABacklog(page, 'sweep-offer-open');
  await openEntry(page, entryId ?? 0);
  // Opening a page asks nothing: the offer waits for a completed pass.
  await expect(page.getByTestId(OFFER)).toHaveCount(0);
  expect(sweepReads(sent)).toHaveLength(0);

  const sweepRead = page.waitForResponse((r) => isCall(r.request(), 'GET', SWEEP_ROUTE));
  await completePass(page, entryId ?? 0);
  const estimate = await sweepRead;
  expect(estimate.status()).toBe(HTTP_OK);
  const pending = ((await estimate.json()) as { entries_pending: number }).entries_pending;

  const offer = page.getByTestId(OFFER);
  await expect(offer).toBeVisible();
  await expect(page.getByTestId(`${OFFER}-pending`)).toContainText(String(pending));
  // Beside the page: on the screen, never in the margin column or the sheet,
  // and never drawn over the page's own text.
  await expect(page.getByTestId('journal-screen').getByTestId(OFFER)).toHaveCount(1);
  await expect(page.getByTestId('journal-margin-column').getByTestId(OFFER)).toHaveCount(0);
  await expect(page.getByTestId('journal-sheet').getByTestId(OFFER)).toHaveCount(0);
  const offerBox = await offer.boundingBox();
  const bodyBox = await page.getByTestId('journal-body-read').boundingBox();
  expect(offerBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  if (offerBox && bodyBox) expect(overlaps(offerBox, bodyBox)).toBe(false);
  // One offer at a time: no invitation beside it.
  await expect(page.getByTestId(INVITATION)).toHaveCount(0);

  await page.getByTestId(`${OFFER}-open`).click();
  await expect(page.getByTestId('corpus-sweep-screen')).toBeVisible();
  await expect(page.getByTestId('corpus-sweep-confirm')).toBeVisible();
  await page.waitForTimeout(QUIET_PERIOD_MS);
  // The note only opens the screen; a pass waits for that screen's own confirm.
  expect(sweepPosts(sent)).toHaveLength(0);
});

test('Not now sets the offer aside for the session; Do not ask again survives a reload', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = recordRequests(page);
  const [first, second, third, fourth] = await writerWithABacklog(page, 'sweep-offer-decline');

  // Not now: gone, and a second pass this session neither shows it nor asks.
  await openEntry(page, first ?? 0);
  await completePass(page, first ?? 0);
  await expect(page.getByTestId(OFFER)).toBeVisible();
  await page.getByTestId(`${OFFER}-dismiss`).click();
  await expect(page.getByTestId(OFFER)).toHaveCount(0);
  const readsBeforeSecondPass = sweepReads(sent).length;
  await openAnotherEntryInSession(page, second ?? 0);
  await completePass(page, second ?? 0);
  await expectNoOffer(page);
  expect(sweepReads(sent)).toHaveLength(readsBeforeSecondPass);

  // A fresh load is a new session: Not now was for this one only.
  await page.reload();
  await openEntry(page, third ?? 0);
  await completePass(page, third ?? 0);
  await expect(page.getByTestId(OFFER)).toBeVisible();
  await page.getByTestId(`${OFFER}-never`).click();
  await expect(page.getByTestId(OFFER)).toHaveCount(0);

  // Do not ask again outlives the reload, and asks the server nothing more.
  await page.reload();
  const readsAfterNever = sweepReads(sent).length;
  await openEntry(page, fourth ?? 0);
  await completePass(page, fourth ?? 0);
  await expectNoOffer(page);
  expect(sweepReads(sent)).toHaveLength(readsAfterNever);
  expect(sweepPosts(sent)).toHaveLength(0);
});

/**
 * Hold the real ``GET /corpus/invitation`` answer at the browser until the
 * sweep note's own count has been answered, then pass it on -- with its
 * ``offer`` bit rewritten when ``offer`` is given.
 */
async function holdInvitationUntilSweepAnswers(
  page: Page,
  offer?: boolean,
): Promise<{ held: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => {
    markHeld = resolveHeld;
  });
  await page.route(`${backendUrl()}${INVITATION_ROUTE}`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      markHeld();
      await released;
      const body = (await response.json()) as { offer: boolean };
      // The lane's own answer for a decided account: never an offer.
      expect(body.offer).toBe(false);
      await route.fulfill({ response, json: offer === undefined ? body : { ...body, offer } });
    } else {
      await route.continue();
    }
  });
  return { held, release };
}

test('the sweep offer waits for the invitation check to settle, and gives way when it offers', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const [first, second] = await writerWithABacklog(page, 'sweep-offer-outranked');

  // The invitation offers, but answers only after the sweep reads have landed.
  const outranking = await holdInvitationUntilSweepAnswers(page, true);
  await openEntry(page, first ?? 0);
  const sweepRead = page.waitForResponse((r) => isCall(r.request(), 'GET', SWEEP_ROUTE));
  await askForPass(page, first ?? 0);
  await outranking.held;
  expect((await sweepRead).status()).toBe(HTTP_OK);
  // Every sweep read said "offer", yet nothing renders while the invitation is out.
  await expectNoOffer(page);
  outranking.release();
  await expect(page.getByTestId(INVITATION)).toBeVisible();
  await expectNoOffer(page);
  await page.unrouteAll({ behavior: 'wait' });

  // The same hold, answered silent: the sweep offer appears only once it lands.
  const silent = await holdInvitationUntilSweepAnswers(page);
  await openEntry(page, second ?? 0);
  const secondSweepRead = page.waitForResponse((r) => isCall(r.request(), 'GET', SWEEP_ROUTE));
  await askForPass(page, second ?? 0);
  await silent.held;
  expect((await secondSweepRead).status()).toBe(HTTP_OK);
  await expectNoOffer(page);
  silent.release();
  await expect(page.getByTestId(OFFER)).toBeVisible();
  await expect(page.getByTestId(INVITATION)).toHaveCount(0);
});
