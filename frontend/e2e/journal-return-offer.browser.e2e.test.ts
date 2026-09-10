import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  askForResonance,
  backendUrl,
  setProgramAnchorDaysAgo,
  signUp,
  tokenFor,
} from './journalHabitsBrowserSupport';

/**
 * Beginning -- or declining -- a Return from inside the journal entry.
 *
 * The `return_offer` contraction reflection is the one card that names the
 * Return, so it is the one card that can begin one. Every half of that is
 * already green on its own: `ContractionReflectionNote.test.tsx` pins the offer
 * gate, the confirmation's contents, the double-tap latch and both failure
 * lines against a mocked `useMettaReturn`, and the backend's own suites pin
 * `POST /metta-return/arc` and `POST /metta-return/offer/dismiss`. Neither
 * proves the entry's button reaches those routes, which is the seam this spec
 * exists for.
 *
 * It runs in the browser lane and not the API lane because the journey *is* the
 * card: the offer surfaces only when a resonance pass has just raised the
 * in-memory contraction signal (`src/store/useContractionSignalStore.ts`) that
 * `useMettaReturn` reads, and that store is fed by the screen's own pass. The
 * API lane runs on the node environment with `node_modules` untransformed and
 * cannot mount a React Native screen at all, so a spec there could only call
 * the two routes by hand -- proving the server works and nothing about the
 * button.
 *
 * Reaching the offer takes two arrangements, and only the first is out of band.
 * The Return is offered from Orange onward, and `program_started_at` is only
 * ever written as "now" -- no request schema accepts it -- so the account's
 * anchor is moved back through `tests.e2e.program_anchor` and then *read*
 * through `GET /stages`, which is what records that the person entered the
 * window the calendar opened. The contraction itself is arranged entirely over
 * the wire: a habit whose foundation has been quiet longer than the detection
 * window, and a finished page asked for its resonance.
 */

/** The `return_offer` card's title -- proof the server chose the deeper variant. */
const RETURN_OFFER_TITLE = 'The Return is open to you';

/**
 * How far back the program anchor goes so the calendar has carried the account
 * into the stage that opens the Return.
 *
 * The Return is offered from `domain.metta_return.RETURN_MINIMUM_STAGE` (5,
 * Orange) onward, and `constants/program.STAGE_DURATIONS_DAYS` gives the four
 * windows before it as 21 days each. Landing exactly on a window boundary is
 * what keeps this off the midnight edge: the rewind runs strictly before the
 * read, so a UTC midnight crossing between the two can only make the server
 * count one day more than asked for, never fewer.
 */
const DAYS_TO_RETURN_STAGE = 84;

/**
 * How long the seeded habit's foundation has been quiet.
 *
 * `domain.contraction.FOUNDATION_UNCHECKED_CONSECUTIVE_DAYS` is 14, so a habit
 * that started this long ago with no completion logged against any of its goals
 * crosses the window with room to spare and flags a contraction.
 */
const QUIET_FOUNDATION_DAYS = 30;

/** Weeks in the arc, as `domain.metta_return.RETURN_SEQUENCE` declares it. */
const RETURN_WEEK_COUNT = 5;

/** The week a fresh arc lands on, and the focus that week carries. */
const FIRST_RETURN_WEEK = 1;
const FIRST_RETURN_FOCUS = 'self';

/** Exactly one arc start may leave the browser, however the confirm is pressed. */
const ONE_START = 1;

const OK = 200;
const CREATED = 201;

const MS_PER_DAY = 86_400_000;
/** Length of the `YYYY-MM-DD` prefix of an ISO-8601 instant. */
const ISO_DATE_LENGTH = 10;

/** One week of the arc, as `GET /metta-return` projects it. */
interface ReturnWeek {
  week_number: number;
  focus: string;
  title: string;
  framing: string;
}

/** The caller's active arc, as `GET /metta-return` projects it. */
interface ReturnArc {
  started_at: string;
  paused: boolean;
  week: number;
  focus: string;
  complete: boolean;
}

/** The Return surface the server reports for the caller. */
interface ReturnState {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offer_dismissed: boolean;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The calendar date `days` days before now, as the habit schema spells one. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Read the Return surface out of band, so the browser's own state is never the witness. */
async function readReturnState(request: APIRequestContext, token: string): Promise<ReturnState> {
  const response = await request.get(`${backendUrl()}/metta-return`, { headers: bearer(token) });
  expect(response.status()).toBe(OK);
  return (await response.json()) as ReturnState;
}

/**
 * Carry the account into the stage that opens the Return, and prove the arrange
 * took.
 *
 * Eligibility is read before and after: an arrange that quietly did nothing
 * would otherwise leave every assertion below describing a `simple_ease_off`
 * account that was never offered a Return at all.
 */
async function reachReturnEligibility(
  request: APIRequestContext,
  token: string,
  email: string,
): Promise<void> {
  expect((await readReturnState(request, token)).eligible).toBe(false);
  setProgramAnchorDaysAgo(email, DAYS_TO_RETURN_STAGE);
  // Reading the Map is what records entry into the window the calendar opened;
  // the rewind alone moves the calendar and deliberately not the record.
  const visit = await request.get(`${backendUrl()}/stages`, { headers: bearer(token) });
  expect(visit.status()).toBe(OK);
  expect((await readReturnState(request, token)).eligible).toBe(true);
}

/** Seed a habit whose foundation has been quiet long enough to name a contraction. */
async function seedQuietHabit(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${backendUrl()}/habits/`, {
    headers: bearer(token),
    data: {
      name: 'Morning sit',
      icon: '★',
      start_date: isoDaysAgo(QUIET_FOUNDATION_DAYS),
      energy_cost: 2,
      energy_return: 4,
    },
  });
  expect(response.status()).toBe(OK);
}

/** Write a page and finish it: the state a resonance pass can be asked for from. */
async function seedFinishedEntry(request: APIRequestContext, token: string): Promise<number> {
  const created = await request.post(`${backendUrl()}/journal/`, {
    headers: bearer(token),
    data: {
      title: 'A quiet fortnight',
      message:
        'The willow bent all night and did not break. I slept badly and woke grateful, ' +
        'which is not the trade I would have chosen.',
    },
  });
  expect(created.status()).toBe(CREATED);
  const entryId = ((await created.json()) as { id: number }).id;
  const finished = await request.patch(`${backendUrl()}/journal/${String(entryId)}`, {
    headers: bearer(token),
    data: { status: 'finished' },
  });
  expect(finished.status()).toBe(OK);
  return entryId;
}

/**
 * Sign up, arrange the two preconditions, and ask the finished page for its
 * resonance until the entry is showing the Return offer.
 *
 * The title assertion is the gate on the whole arrange: `simple_ease_off` reads
 * "Tend your foundation" and carries no accept affordance, so an account that
 * never reached Orange fails here rather than further down on a missing button.
 */
async function offerTheReturnInTheEntry(page: Page, prefix: string): Promise<string> {
  const email = await signUp(page, prefix);
  const token = await tokenFor(page.request, email);
  await reachReturnEligibility(page.request, token, email);
  await seedQuietHabit(page.request, token);
  const entryId = await seedFinishedEntry(page.request, token);

  await page.reload();
  await page.getByTestId(`journal-shelf-open-${String(entryId)}`).click();
  await askForResonance(page);

  await expect(page.getByTestId('contraction-reflection-title')).toHaveText(RETURN_OFFER_TITLE);
  return token;
}

/** Every arc start the browser actually issued, recorded as it goes. */
function recordArcStarts(page: Page): string[] {
  const starts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/metta-return/arc') {
      starts.push(request.url());
    }
  });
  return starts;
}

test('the entry begins the Return it offers, on the weeks the server named', async ({ page }) => {
  const starts = recordArcStarts(page);
  const token = await offerTheReturnInTheEntry(page, 'return-offer-accept');

  const before = await readReturnState(page.request, token);
  expect(before.arc).toBeNull();
  expect(before.weeks).toHaveLength(RETURN_WEEK_COUNT);

  await page.getByTestId('contraction-return-accept').click();
  await expect(page.getByTestId('contraction-return-confirm-card')).toBeVisible();

  // The confirmation says materially what accepting is, in the server's own
  // words: each line is checked against the sequence read back over the wire
  // above rather than against anything this spec made up.
  await expect(page.getByTestId(/^contraction-return-week-\d+$/u)).toHaveCount(RETURN_WEEK_COUNT);
  for (const week of before.weeks) {
    await expect(
      page.getByTestId(`contraction-return-week-${String(week.week_number)}`),
    ).toHaveText(`${String(week.week_number)}. ${week.title}`);
  }

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/metta-return/arc',
  );
  await page.getByTestId('contraction-return-confirm-accept').click();
  expect((await started).status()).toBe(CREATED);

  // The card gives its accept affordance up once a Return is running: there is
  // no second one to begin.
  await expect(page.getByTestId('contraction-return-accept')).toHaveCount(0);
  await expect(page.getByTestId('contraction-return-notice')).toHaveCount(0);

  const after = await readReturnState(page.request, token);
  expect(after.arc).not.toBeNull();
  expect(after.arc).toMatchObject({
    week: FIRST_RETURN_WEEK,
    focus: FIRST_RETURN_FOCUS,
    paused: false,
    complete: false,
  });
  expect(starts).toHaveLength(ONE_START);
});

test('"Not now" in the entry persists the decline the Journal shelf reads', async ({ page }) => {
  const starts = recordArcStarts(page);
  const token = await offerTheReturnInTheEntry(page, 'return-offer-decline');

  const before = await readReturnState(page.request, token);
  expect(before.offer_dismissed).toBe(false);

  const dismissed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/metta-return/offer/dismiss',
  );
  await page.getByTestId('contraction-dismiss').click();
  expect((await dismissed).status()).toBe(OK);

  await expect(page.getByTestId('contraction-return-accept')).toHaveCount(0);
  await expect(page.getByTestId('contraction-return-notice')).toHaveCount(0);

  // The shelf's offer card reads exactly this flag, so a decline recorded here
  // is a decline honoured there -- and declining is not a quiet way to start.
  const after = await readReturnState(page.request, token);
  expect(after.offer_dismissed).toBe(true);
  expect(after.arc).toBeNull();
  expect(starts).toHaveLength(0);
});
