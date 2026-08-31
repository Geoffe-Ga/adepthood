/* eslint-env jest */
/* global describe, it, expect */

import {
  CREDIT_EXHAUSTED_COPY,
  formatApiError,
  GENERIC_FALLBACK,
  messageForCode,
  SERVICE_CREDIT_EXHAUSTED_COPY,
  USER_FACING_ERROR_MESSAGES,
} from '../errorMessages';
import { ApiError } from '../index';

describe('USER_FACING_ERROR_MESSAGES', () => {
  it('covers every backend error code the backend emits', () => {
    // This set is the source of truth for what backend codes ship to clients.
    // Keep it in sync with backend/src/errors.py and every router's
    // HTTPException details. If the backend adds a new code, add its
    // user-facing copy to ``errorMessages.ts`` and list it here.
    const expectedCodes = [
      // auth
      'invalid_credentials',
      'password_too_short',
      'password_too_long',
      'unauthorized',
      // gumroad license verification on signup
      'invalid_license',
      'license_required',
      'too_many_license_attempts',
      'license_verification_unavailable',
      // google oauth exchange
      'needs_license',
      'invalid_oauth_token',
      // admin gate
      'admin_required',
      // resource not found
      'user_not_found',
      'stage_not_found',
      'content_not_found',
      'practice_not_found',
      'habit_not_found',
      'journal_entry_not_found',
      'goal_not_found',
      'goal_group_not_found',
      'prompt_not_found',
      'user_practice_not_found',
      // forbidden / ownership
      'forbidden',
      'not_owner',
      // validation / state
      'cannot_go_backwards',
      'already_responded',
      'practice_not_approved',
      'stage_locked',
      'stage_number_mismatch',
      'active_practice_exists_for_stage',
      'habits_must_not_be_empty',
      // wallet
      'payment_required',
      'insufficient_offerings',
      'llm_key_required',
      'invalid_llm_api_key_format',
      // permanently exhausted provider balance -- caller's key, then ours
      'llm_credit_exhausted',
      'llm_service_credit_exhausted',
      // streaming / rate limits / network
      'rate_limit_exceeded',
      'llm_provider_error',
      'malformed_stream_frame',
      'incomplete_stream',
      'network_error',
    ];
    for (const code of expectedCodes) {
      expect(USER_FACING_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('never exposes raw snake_case to users', () => {
    for (const [code, message] of Object.entries(USER_FACING_ERROR_MESSAGES)) {
      // The literal snake_case code must not appear verbatim in the copy
      // (it would defeat the entire point of the mapping). The key
      // ``'Database unavailable'`` is already a human string, so skip it.
      if (code === 'Database unavailable') continue;
      expect(message).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
  });

  it('gives messages that start with a capital letter', () => {
    for (const message of Object.values(USER_FACING_ERROR_MESSAGES)) {
      expect(message[0]).toMatch(/[A-Z"]/);
    }
  });

  it('gives messages that end with punctuation (not a trailing period-less phrase)', () => {
    for (const message of Object.values(USER_FACING_ERROR_MESSAGES)) {
      expect(message).toMatch(/[.!?]$/);
    }
  });
});

describe('practice-selection codes (BUG-PRACTICE-012)', () => {
  it('maps stage_locked to actionable copy instead of the generic 403 wall', () => {
    const err = new ApiError(403, 'stage_locked');
    const msg = formatApiError(err);
    expect(msg).toMatch(/unlock(ed)? this stage/i);
    expect(msg).not.toMatch(/don't have access/i);
  });

  it('keeps stage_locked copy stage-generic since it now guards logging, not selection', () => {
    const msg = messageForCode('stage_locked');
    expect(msg).not.toMatch(/practice/i);
  });

  it('maps stage_number_mismatch to stage-specific guidance', () => {
    expect(messageForCode('stage_number_mismatch')).toMatch(/different stage/i);
  });

  it('maps the transient replace conflict to a retry prompt', () => {
    const err = new ApiError(409, 'active_practice_exists_for_stage');
    expect(formatApiError(err)).toMatch(/try (switching )?again/i);
  });
});

describe('gumroad license codes', () => {
  // ``invalid_license`` is deliberately indistinguishable from a duplicate
  // email on the wire (anti-enumeration), so the copy must not claim to know
  // which of the two happened.
  it('maps invalid_license to the approved ambiguous copy', () => {
    expect(messageForCode('invalid_license')).toBe(
      "We couldn't verify that key — double-check it matches the email and product.",
    );
  });

  it('does not tell the user their email is already registered', () => {
    expect(messageForCode('invalid_license')).not.toMatch(/already (registered|have an account)/i);
  });

  it.each([
    ['license_required'],
    ['too_many_license_attempts'],
    ['license_verification_unavailable'],
    ['password_too_long'], // pragma: allowlist secret
  ])('gives %p actionable, snake_case-free copy', (code) => {
    const message = messageForCode(code);

    expect(message).toBeTruthy();
    expect(message).not.toMatch(/[a-z]_[a-z]/);
    expect(message).toMatch(/[.!?]$/);
  });

  it('tells the user the outage is transient rather than their fault', () => {
    expect(messageForCode('license_verification_unavailable')).toMatch(/try again/i);
  });

  it('names the concrete password ceiling so the user can act', () => {
    expect(messageForCode('password_too_long')).toMatch(/64/); // pragma: allowlist secret
  });
});

describe('google oauth codes', () => {
  // The backend collapses every non-cryptographic refusal (no license, bad
  // license, unverified email, no email claim, disabled account) into one
  // byte-identical 409. The copy must not reconstruct the distinction the
  // wire format deliberately destroyed.
  it.each([['email'], ['account'], ['verified'], ['disabled'], ['deleted']])(
    'never names %p as the cause of a needs_license refusal',
    (word) => {
      expect(messageForCode('needs_license')).not.toMatch(new RegExp(word, 'i'));
    },
  );

  it('points the user at their license key as the next action', () => {
    expect(messageForCode('needs_license')).toMatch(/license key/i);
  });

  it('gives invalid_oauth_token retry-shaped copy rather than a license prompt', () => {
    const message = messageForCode('invalid_oauth_token');

    expect(message).toBeTruthy();
    expect(message).not.toMatch(/license/i);
    expect(message).toMatch(/try again/i);
  });

  it.each([['needs_license'], ['invalid_oauth_token']])(
    'gives %p snake_case-free copy that ends in punctuation',
    (code) => {
      const message = messageForCode(code);

      expect(message).not.toMatch(/[a-z]_[a-z]/);
      expect(message).toMatch(/[.!?]$/);
    },
  );

  it('routes the 409 through formatApiError rather than the generic conflict copy', () => {
    const message = formatApiError(new ApiError(409, 'needs_license'));

    expect(message).toBe(messageForCode('needs_license'));
    expect(message).not.toMatch(/refresh and try again/i);
  });
});

// ``invalid_oauth_token`` is the single 401 detail behind BOTH oauth routes
// (Google and Apple), so copy that names one provider misattributes half the
// failures — a user who tapped Apple must not be told Google failed.
describe('oauth credential copy is provider-neutral', () => {
  it.each([[/google/i], [/apple/i]])('never names %p as the provider', (provider) => {
    expect(USER_FACING_ERROR_MESSAGES.invalid_oauth_token).not.toMatch(provider);
  });

  it('still says a sign-in failed verification and invites a retry', () => {
    const copy = USER_FACING_ERROR_MESSAGES.invalid_oauth_token;

    expect(copy).toMatch(/sign-in/i);
    expect(copy).toMatch(/try again/i);
  });
});

describe('messageForCode', () => {
  it('returns the mapped copy for a known code', () => {
    expect(messageForCode('invalid_credentials')).toContain('email and password');
  });

  it('returns undefined for an unknown code', () => {
    expect(messageForCode('totally_made_up')).toBeUndefined();
  });

  it('returns undefined for empty / null inputs', () => {
    expect(messageForCode('')).toBeUndefined();
    expect(messageForCode(null)).toBeUndefined();
    expect(messageForCode(undefined)).toBeUndefined();
  });
});

describe('formatApiError', () => {
  it('translates an ApiError with a known detail code', () => {
    const err = new ApiError(401, 'invalid_credentials');
    expect(formatApiError(err)).toContain('email and password');
  });

  it('uses caller-supplied fallback over status default when the code is unknown', () => {
    const err = new ApiError(400, 'some_new_unmapped_code');
    expect(formatApiError(err, { fallback: 'Could not save practice.' })).toBe(
      'Could not save practice.',
    );
  });

  it('uses status override when provided', () => {
    const err = new ApiError(404, 'some_unmapped_code');
    expect(
      formatApiError(err, { statusOverrides: { 404: 'Nothing here, pull to refresh.' } }),
    ).toBe('Nothing here, pull to refresh.');
  });

  it('falls back to status-code copy when detail is unknown and no fallback set', () => {
    const err = new ApiError(503, 'some_unmapped_code');
    expect(formatApiError(err)).toMatch(/service is temporarily unavailable/i);
  });

  it('prefers a known code over a status override', () => {
    // The contract: known codes are never overridden by status — users
    // should see consistent copy regardless of which screen raised them.
    const err = new ApiError(402, 'insufficient_offerings');
    const result = formatApiError(err, {
      statusOverrides: { 402: 'This should not be used.' },
    });
    expect(result).toMatch(/BotMason messages/);
  });

  it('returns GENERIC_FALLBACK for null/undefined inputs with no fallback', () => {
    expect(formatApiError(null)).toBe(GENERIC_FALLBACK);
    expect(formatApiError(undefined)).toBe(GENERIC_FALLBACK);
  });

  it('returns caller fallback when input is null/undefined', () => {
    expect(formatApiError(null, { fallback: 'Sign in failed.' })).toBe('Sign in failed.');
  });

  it('ignores the generic ApiError synthetic message and uses the fallback instead', () => {
    // ApiError.message is ``Request failed with status N: detail`` — that's
    // debug text, never copy we want to show users.
    const err = new ApiError(500, 'some_unmapped_code');
    expect(formatApiError(err, { fallback: 'Could not save.' })).toBe('Could not save.');
  });

  it('accepts plain ``{ detail }`` objects (e.g. AuthContext rejections)', () => {
    const plain = { detail: 'password_too_short' };
    expect(formatApiError(plain)).toContain('at least 8 characters');
  });

  it('uses a readable ``.message`` when no detail, status, or fallback is given', () => {
    const err = new Error('SecureStore is not available on this device.');
    expect(formatApiError(err)).toBe('SecureStore is not available on this device.');
  });

  // A failed ``fetch`` rejects with a TypeError whose message differs by engine:
  // "Load failed" (iOS Safari/WebKit), "Failed to fetch" (Chrome/Blink),
  // "NetworkError when attempting to fetch resource." (Firefox), "Network
  // request failed" (React Native). These are cryptic — surface the friendly
  // offline copy instead of leaking the raw engine string to users.
  it.each([
    ['Load failed'],
    ['Failed to fetch'],
    ['NetworkError when attempting to fetch resource.'],
    ['Network request failed'],
    ['The network connection was lost.'],
    ['The Internet connection appears to be offline.'],
  ])('maps the fetch network TypeError %p to friendly offline copy', (message) => {
    const result = formatApiError(new TypeError(message));
    expect(result).not.toBe(message); // never leak the raw engine string
    expect(result).toMatch(/offline/i);
  });
});

describe('rate_limit_exceeded copy is surface-neutral', () => {
  // The backend emits one shared `rate_limit_exceeded` for every limiter
  // (`main.py:424`, registered app-wide at `:599`), and those limiters span
  // BotMason chat at 5/minute through auth routes at 1/minute and 10/hour. Copy
  // that names any one surface is wrong on all the others -- a user tripping the
  // signup limiter was told about sending chat messages to BotMason.
  const copy = USER_FACING_ERROR_MESSAGES.rate_limit_exceeded ?? '';

  it('names no product surface, since every limiter shares this code', () => {
    expect(copy).not.toMatch(/botmason/i);
    expect(copy).not.toMatch(/message/i);
    expect(copy).not.toMatch(/chat/i);
  });

  it('quotes no specific limit, since the limiters disagree', () => {
    // The old copy said "10 messages per minute" -- wrong even for BotMason,
    // whose own decorator is 5/minute.
    expect(copy).not.toMatch(/\d+\s*(per|\/)\s*(minute|hour)/i);
    expect(copy).not.toMatch(/\d+\s+messages/i);
  });

  it('stays non-coercive, per "you choose your depth"', () => {
    // No scolding and no urgency: hitting a limiter is not a transgression.
    expect(copy).not.toMatch(/too many|slow down|stop|must|immediately|warning/i);
  });

  it('still tells the user what happened and that waiting resolves it', () => {
    expect(copy).toBeTruthy();
    expect(copy).toMatch(/again|moment|minute|shortly/i);
  });
});

describe('exhausted provider balance (permanent, not transient)', () => {
  // The copy that must NOT be reused: a permanent billing refusal presented as
  // a connectivity blip sends the reader back to a retry button forever.
  const PROVIDER_TROUBLE_COPY =
    "BotMason's AI provider is having trouble connecting. Give it a moment and tap retry.";
  const TRANSIENT_503_COPY =
    'The service is temporarily unavailable. Give it a moment, then try again.';
  const MONTHLY_ALLOTMENT_COPY =
    "You've reached this month's free allotment. Add your own API key in Settings, or wait until the next monthly reset.";

  // Anything a provider said, or anything that identifies the account or the
  // key, is for the operator's log and never for the reader.
  const PROVIDER_INTERNALS =
    /insufficient_quota|credit balance is too low|Plans & Billing|exceeded your current quota|sk-|req_[0-9a-zA-Z]|\b(?:400|402|429|502|503)\b|api\.openai\.com|api\.anthropic\.com/i;

  // "Try again", "retry", "give it a moment" are all promises this condition
  // cannot keep. Waiting never refills an account.
  const RETRY_AFFORDANCE = /try again|tap retry|give it a moment|in a moment|temporarily/i;

  it("gives the caller's own spent key its own copy, not the connectivity blip", () => {
    const message = formatApiError(new ApiError(402, 'llm_credit_exhausted'));
    expect(message).not.toBe(PROVIDER_TROUBLE_COPY);
    expect(message).not.toBe(MONTHLY_ALLOTMENT_COPY);
    expect(message.length).toBeGreaterThan(0);
  });

  it('gives our own spent key its own copy, not the transient 503 fallback', () => {
    const message = formatApiError(new ApiError(503, 'llm_service_credit_exhausted'));
    expect(message).not.toBe(TRANSIENT_503_COPY);
    expect(message).not.toBe(PROVIDER_TROUBLE_COPY);
    expect(message.length).toBeGreaterThan(0);
  });

  // The three assertions below all read the RENDERED string, not the raw map.
  // ``formatApiError`` is what a screen actually calls, and it has six fallback
  // rungs beneath the map -- so a lookup that silently misses still returns
  // plausible copy from one of them. Asserting on ``messageForCode`` would step
  // over exactly the rungs that made the original bug invisible.
  const rendered = {
    caller: () => formatApiError(new ApiError(402, 'llm_credit_exhausted')),
    ours: () => formatApiError(new ApiError(503, 'llm_service_credit_exhausted')),
  };

  it('renders the intended copy rather than falling through to a status default', () => {
    expect(rendered.caller()).toBe(CREDIT_EXHAUSTED_COPY);
    expect(rendered.ours()).toBe(SERVICE_CREDIT_EXHAUSTED_COPY);
  });

  it('tells the two apart, because the remedy is not the same person', () => {
    expect(rendered.caller()).not.toBe(rendered.ours());
  });

  it('offers no retry affordance for either, since retrying can never work', () => {
    expect(rendered.caller()).not.toMatch(RETRY_AFFORDANCE);
    expect(rendered.ours()).not.toMatch(RETRY_AFFORDANCE);
  });

  it('leaks no provider internals, account reference, or key material', () => {
    expect(rendered.caller()).not.toMatch(PROVIDER_INTERNALS);
    expect(rendered.ours()).not.toMatch(PROVIDER_INTERNALS);
  });

  it('never tells a reader to settle a bill on an account they do not hold', () => {
    // The server's key is nobody's but ours; pointing the reader at "Plans &
    // Billing" would be an instruction they cannot carry out.
    expect(rendered.ours()).not.toMatch(
      /your (provider|openai|anthropic) account|top up|purchase credits|upgrade your plan/i,
    );
  });
});
