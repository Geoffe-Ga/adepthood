import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, prompts, setTokenGetter } from '@/api';

/**
 * Setting a stage prompt aside, and bringing it back, across the wire (#2726).
 *
 * The band on the Journal shelf offered every prompt of the stage forever. A
 * writer who had no intention of answering one had no way to say so, which
 * made a set of declinable invitations read as an unclearable to-do list. The
 * declining half is now a real row and two real routes, and this is the one
 * place the client's own wrappers, the Zod schema that has to carry
 * `dismissed`, the router's gating, the unique index and the migration that
 * created the table are all exercised together.
 *
 * The invariant worth crossing the wire for is the one a mocked test cannot
 * see: a dismissal is a preference and never a completion. Nothing here may
 * write a `PromptResponse`, mark a prompt answered, move the reader's week, or
 * close the week to the prompts still standing -- and the only way to prove
 * that against the real settlement is to set one aside and then still write to
 * another one.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
// One sale binds to one active account (ADR 0008), so each account this
// journey registers needs a key of its own.
const LICENSE_KEY = freshLicenseKey();
const NEIGHBOUR_LICENSE_KEY = freshLicenseKey();

const BEIGE_STAGE = 1;
const BEIGE_PROMPT_COUNT = 3;
const SET_ASIDE_ORDINAL = 2;
const KEPT_ORDINAL = 1;
// Beige ships three prompts, so a fourth names nothing in the curriculum.
const ABSENT_ORDINAL = BEIGE_PROMPT_COUNT + 1;
// A stage 36 weeks of writing away from a fresh account.
const LOCKED_STAGE = 10;
const FIRST_WEEK = 1;

const email = `e2e-set-aside-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-set-aside-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;
const answer = `Lo que sí quise escribir — ${randomUUID()}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/** The ordinals the server reports as set aside, in curriculum order. */
function setAsideOrdinals(band: { prompts: { ordinal: number; dismissed?: boolean }[] }): number[] {
  return band.prompts.filter((prompt) => prompt.dismissed === true).map((prompt) => prompt.ordinal);
}

describe('prompt set-aside journey against a live server', () => {
  let sessionToken: string | null = null;

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

  it('offers a fresh account the whole band, with nothing set aside', async () => {
    const band = await prompts.stage(BEIGE_STAGE);

    expect(band.prompts).toHaveLength(BEIGE_PROMPT_COUNT);
    // Read off the wire through the real Zod schema: a server that omitted
    // `dismissed` entirely would have to be tolerated as "not set aside"
    // rather than rejected as a broken payload, so this pins that it is sent.
    expect(setAsideOrdinals(band)).toEqual([]);
    expect(band.prompts.every((prompt) => prompt.dismissed === false)).toBe(true);
  });

  it('records the set-aside and answers with the whole band', async () => {
    const band = await prompts.setAside(BEIGE_STAGE, SET_ASIDE_ORDINAL);

    // The set is not shortened: which prompts the stage carries is the
    // curriculum's answer, which of them to show is the reader's.
    expect(band.prompts).toHaveLength(BEIGE_PROMPT_COUNT);
    expect(setAsideOrdinals(band)).toEqual([SET_ASIDE_ORDINAL]);
  });

  it('remembers it on a cold start with a freshly-minted session', async () => {
    const returning = await auth.login({ email, password: PASSWORD });
    sessionToken = returning.token;

    const band = await prompts.stage(BEIGE_STAGE);

    // Server-side, not device-side: the choice survives the device that made it.
    expect(setAsideOrdinals(band)).toEqual([SET_ASIDE_ORDINAL]);
  });

  it('carries the same answer onto the weekly prompt drawn from the same curriculum', async () => {
    // Week 1 serves Beige's first prompt, which this account kept and wrote to.
    const kept = await prompts.current();
    expect(kept.dismissed).toBe(false);

    await prompts.setAside(BEIGE_STAGE, KEPT_ORDINAL);
    const declined = await prompts.current();

    // Same (stage, ordinal), so the surface that offers a prompt without the
    // band cannot keep offering the very one the reader declined.
    expect(declined.prompt_ordinal).toBe(KEPT_ORDINAL);
    expect(declined.dismissed).toBe(true);

    await prompts.bringBack(BEIGE_STAGE, KEPT_ORDINAL);
    expect((await prompts.current()).dismissed).toBe(false);
  });

  it('is a preference and never a completion', async () => {
    // The invariant the whole feature turns on, and the one only a live
    // settlement can refute. Nothing was answered, the week has not moved, and
    // the prompts still standing are still writable this week.
    const history = await prompts.history();
    expect(history.items).toEqual([]);
    expect(history.total).toBe(0);

    const current = await prompts.current();
    expect(current.week_number).toBe(FIRST_WEEK);
    expect(current.has_responded).toBe(false);

    const written = await prompts.respond(FIRST_WEEK, answer, {
      promptOrdinal: KEPT_ORDINAL,
    });
    expect(written.has_responded).toBe(true);
    expect(written.response).toBe(answer);

    // And the prompt that *was* written to is not thereby set aside, nor the
    // set-aside one thereby answered.
    const band = await prompts.stage(BEIGE_STAGE);
    expect(setAsideOrdinals(band)).toEqual([SET_ASIDE_ORDINAL]);
  });

  it('collapses a repeated set-aside onto the one it already holds', async () => {
    const again = await prompts.setAside(BEIGE_STAGE, SET_ASIDE_ORDINAL);

    // The unique index is the guard; a second row would show up here as a
    // duplicate ordinal in the reported set.
    expect(setAsideOrdinals(again)).toEqual([SET_ASIDE_ORDINAL]);
  });

  it('brings the prompt back, and undoing nothing is success', async () => {
    const restored = await prompts.bringBack(BEIGE_STAGE, SET_ASIDE_ORDINAL);
    expect(setAsideOrdinals(restored)).toEqual([]);

    const undoOfNothing = await prompts.bringBack(BEIGE_STAGE, SET_ASIDE_ORDINAL);
    expect(setAsideOrdinals(undoOfNothing)).toEqual([]);
  });

  it('refuses an ordinal the stage does not carry, and a stage not reached', async () => {
    const absent = await rejection(prompts.setAside(BEIGE_STAGE, ABSENT_ORDINAL));
    expect(absent).toBeInstanceOf(ApiError);
    expect((absent as ApiError).status).toBe(404);

    // The same refusal the stage read gives, rather than a second, laxer
    // oracle for which stages exist.
    const locked = await rejection(prompts.setAside(LOCKED_STAGE, 1));
    const lockedRead = await rejection(prompts.stage(LOCKED_STAGE));
    expect((locked as ApiError).status).toBe((lockedRead as ApiError).status);
  });

  it('refuses to record anything without a session at all', async () => {
    setTokenGetter(() => null);

    const write = await rejection(prompts.setAside(BEIGE_STAGE, SET_ASIDE_ORDINAL));
    const undo = await rejection(prompts.bringBack(BEIGE_STAGE, SET_ASIDE_ORDINAL));

    expect((write as ApiError).status).toBe(401);
    expect((undo as ApiError).status).toBe(401);

    setTokenGetter(() => sessionToken);
  });

  it("never carries one account's choice over to another", async () => {
    await prompts.setAside(BEIGE_STAGE, SET_ASIDE_ORDINAL);

    const neighbour = await auth.signup({
      email: neighbourEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: NEIGHBOUR_LICENSE_KEY,
    });
    sessionToken = neighbour.token;

    // The routes read the owner from the JWT alone. The prompt is named by
    // curriculum position, which is identical for everyone, so this is the one
    // place a mis-scoped WHERE would be indistinguishable from a correct one.
    expect(setAsideOrdinals(await prompts.stage(BEIGE_STAGE))).toEqual([]);
    await prompts.bringBack(BEIGE_STAGE, SET_ASIDE_ORDINAL);

    const owner = await auth.login({ email, password: PASSWORD });
    sessionToken = owner.token;
    expect(setAsideOrdinals(await prompts.stage(BEIGE_STAGE))).toEqual([SET_ASIDE_ORDINAL]);
  });
});
