import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { CORPUS_REVOKE_PROMPT } from '../src/features/Settings/corpusConsentCopy';

import { backendUrl, bearer, frontendUrl, signUp, tokenFor } from './journalHabitsBrowserSupport';

/**
 * The sorting switches on the Settings hub, over the real wire (#3032).
 *
 * Since #3033 the corpus-consent switches render on the hub itself, under Your
 * corpus, through the same `CorpusConsentRows` the sub-screen mounts. The
 * sub-screen's switches are proven over the wire by `corpus-consent.e2e`; the
 * hub mount was pinned only by `SettingsHubScreen.test.tsx`, against a mocked
 * client. This journey never leaves the hub: it grants and withdraws from the
 * group a person lands on, and reads each decision back from the server with
 * the account's own bearer, so the switch's position is checked against what
 * was recorded rather than what was tapped.
 *
 * The withdrawal half proves the question is asked before anything is written:
 * the first press after a grant opens the inline confirmation and sends no
 * request, and the server still reports the grant until the confirm is pressed.
 */

const JOURNAL = 'journal';
const CONSENT_WRITE_PATH = `/corpus/consent/${JOURNAL}`;
const HTTP_OK = 200;

const UNDECIDED_STATUS = 'Off. You have not decided about this yet.';
const GRANTED_STATUS = /^On since .+\.$/u;
const REFUSED_STATUS = /^Off since .+\. Nothing is sorted from here\.$/u;

interface ConsentDecision {
  source: string;
  granted: boolean;
  decided_at: string | null;
}

/** The journal decision as the server reports it to this account. */
async function readJournalDecision(
  request: APIRequestContext,
  token: string,
): Promise<ConsentDecision> {
  const response = await request.get(`${backendUrl()}/corpus/consent`, { headers: bearer(token) });
  expect(response.status()).toBe(HTTP_OK);
  const { sources } = (await response.json()) as { sources: ConsentDecision[] };
  const decision = sources.find((row) => row.source === JOURNAL);
  if (!decision) throw new Error('the server named no journal source to decide about');
  return decision;
}

/** Every consent write this browser sends for the journal source. */
function recordWrites(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === CONSENT_WRITE_PATH) {
      sent.push(request);
    }
  });
  return sent;
}

function journalWrite(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === CONSENT_WRITE_PATH,
  );
}

test('the hub grants and withdraws journal sorting, and the server records each decision', async ({
  page,
}) => {
  const email = await signUp(page, 'hub-sorting');
  const token = await tokenFor(page.request, email);
  const fresh = await readJournalDecision(page.request, token);
  expect(fresh.granted).toBe(false);
  expect(fresh.decided_at).toBeNull();
  const writes = recordWrites(page);

  await page.goto(`${frontendUrl()}/settings`);
  const hub = page.getByTestId('settings-hub-screen');
  const group = hub.getByTestId('settings-group-corpus');
  const row = group.getByTestId(`corpus-consent-row-${JOURNAL}`);
  const control = row.getByTestId(`corpus-consent-switch-${JOURNAL}`).getByRole('switch');
  const status = row.getByTestId(`corpus-consent-status-${JOURNAL}`);
  await expect(control).not.toBeChecked();
  await expect(status).toHaveText(UNDECIDED_STATUS);

  // Grant: one tap, recorded over PUT, and shown only once the server agrees.
  const granted = journalWrite(page);
  await control.click();
  const grantResponse = await granted;
  expect(grantResponse.status()).toBe(HTTP_OK);
  expect(grantResponse.request().postDataJSON()).toEqual({ granted: true });
  await expect(control).toBeChecked();
  await expect(status).toHaveText(GRANTED_STATUS);
  const afterGrant = await readJournalDecision(page.request, token);
  expect(afterGrant.granted).toBe(true);
  expect(afterGrant.decided_at).not.toBeNull();
  // The hub did the work itself: it never handed off to the sub-screen.
  await expect(page.getByTestId('corpus-consent-screen')).toHaveCount(0);

  // Withdraw: the first press asks, naming the deletion, and writes nothing.
  await control.click();
  const question = row.getByTestId(`corpus-consent-revoke-${JOURNAL}`);
  await expect(question).toBeVisible();
  await expect(question).toContainText(CORPUS_REVOKE_PROMPT);
  await expect(control).toBeChecked();
  expect(writes).toHaveLength(1);
  expect((await readJournalDecision(page.request, token)).granted).toBe(true);

  const refused = journalWrite(page);
  await question.getByTestId(`corpus-consent-revoke-confirm-${JOURNAL}`).click();
  const refuseResponse = await refused;
  expect(refuseResponse.status()).toBe(HTTP_OK);
  expect(refuseResponse.request().postDataJSON()).toEqual({ granted: false });
  await expect(question).toHaveCount(0);
  await expect(control).not.toBeChecked();
  await expect(status).toHaveText(REFUSED_STATUS);
  expect(writes).toHaveLength(2);

  // A dated refusal, not an open question and not the grant's date.
  const afterRefusal = await readJournalDecision(page.request, token);
  expect(afterRefusal.granted).toBe(false);
  expect(afterRefusal.decided_at).not.toBeNull();
  expect(afterRefusal.decided_at).not.toBe(afterGrant.decided_at);

  // And the hub reads the same refusal back after a fresh load.
  await page.reload();
  await expect(
    page
      .getByTestId('settings-group-corpus')
      .getByTestId(`corpus-consent-switch-${JOURNAL}`)
      .getByRole('switch'),
  ).not.toBeChecked();
  await expect(
    page.getByTestId('settings-group-corpus').getByTestId(`corpus-consent-status-${JOURNAL}`),
  ).toHaveText(REFUSED_STATUS);
});
