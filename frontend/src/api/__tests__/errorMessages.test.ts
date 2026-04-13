/* eslint-env jest */
/* global describe, it, expect */

import {
  formatApiError,
  GENERIC_FALLBACK,
  mapDetailToMessage,
  messageForCode,
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
      'unauthorized',
      // admin
      'admin_api_disabled',
      'admin_auth_required',
      // resource not found
      'stage_not_found',
      'content_not_found',
      'practice_not_found',
      'habit_not_found',
      'journal_entry_not_found',
      'goal_not_found',
      'goal_group_not_found',
      'prompt_not_found',
      'user_practice_not_found',
      'user_not_found',
      // forbidden / ownership
      'forbidden',
      'not_owner',
      // validation / state
      'cannot_go_backwards',
      'already_responded',
      'practice_not_approved',
      'amount_must_be_positive',
      'habits_must_not_be_empty',
      // wallet
      'payment_required',
      'insufficient_offerings',
      'llm_key_required',
      'invalid_llm_api_key_format',
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

describe('mapDetailToMessage', () => {
  it('maps known codes', () => {
    expect(mapDetailToMessage('rate_limit_exceeded')).toMatch(/Slow down/);
  });

  it('falls back to the provider-trouble copy for unknown codes', () => {
    expect(mapDetailToMessage('whatever_new_code')).toMatch(/having trouble/);
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
});
