import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, prompts, setTokenGetter } from '@/api';

/**
 * Reading back the weekly prompts you have already answered, across the wire.
 *
 * Answering a prompt mirrors the response into the journal as an ordinary page,
 * which keeps the writing and loses the question that drew it. `GET
 * /prompts/history` is the only route that returns the pair, and until the
 * shelf grew a "Past prompts" surface nothing asked for it. What has to be
 * proven at the seam is that a submitted response comes back joined to its own
 * question, that the envelope's `total` / `has_more` describe the same set the
 * `items` do, and that the pagination the modal drives actually slices — a
 * limit the server ignored would look identical from one page.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const FIRST_WEEK = 1;

const email = `e2e-prompt-history-${randomUUID()}${EMAIL_DOMAIN}`;
// Non-ASCII on purpose: the answer has to survive sanitisation and the round
// trip through two rows word for word.
const answer = `Lo que traje conmigo 灯 — ${randomUUID()}`;

describe('prompt-history journey against a live server', () => {
  let sessionToken: string | null = null;
  let question = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('starts with nothing in the history and the first week unanswered', async () => {
    const current = await prompts.current();

    expect(current.week_number).toBe(FIRST_WEEK);
    expect(current.has_responded).toBe(false);
    expect(current.question.length).toBeGreaterThan(0);
    question = current.question;

    const history = await prompts.history();
    expect(history.items).toEqual([]);
    expect(history.total).toBe(0);
    expect(history.has_more).toBe(false);
  });

  it('returns the answered prompt joined to the question that drew it', async () => {
    const submitted = await prompts.respond(FIRST_WEEK, answer);
    expect(submitted.has_responded).toBe(true);

    const history = await prompts.history();

    expect(history.total).toBe(1);
    expect(history.has_more).toBe(false);
    const [only] = history.items;
    if (only === undefined) throw new Error('expected the answered prompt in the history');
    expect(only.week_number).toBe(FIRST_WEEK);
    // The pair the journal stream cannot reproduce on its own.
    expect(only.question).toBe(question);
    expect(only.response).toBe(answer);
    expect(only.has_responded).toBe(true);
  });

  it('pages the history with the limit and offset the modal sends', async () => {
    const firstPage = await prompts.history({ limit: 1, offset: 0 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(1);
    // One row, one page: the offset past it is genuinely the end.
    expect(firstPage.has_more).toBe(false);

    const pastTheEnd = await prompts.history({ limit: 1, offset: 1 });
    expect(pastTheEnd.items).toEqual([]);
    expect(pastTheEnd.total).toBe(1);
    expect(pastTheEnd.has_more).toBe(false);
  });
});
