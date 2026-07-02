/* eslint-env jest */
/* global describe, it, expect */

import {
  formatApiError,
  GENERIC_FALLBACK,
  TIMEOUT_MESSAGE,
  VALIDATION_MESSAGE,
} from '../errorMessages';

describe('formatApiError edge-case resolution branches', () => {
  it('falls back to GENERIC_FALLBACK when a plain Error carries an empty message', () => {
    expect(formatApiError(new Error(''))).toBe(GENERIC_FALLBACK);
  });

  it('suppresses the synthetic "Request failed with status" debug message', () => {
    expect(formatApiError(new Error('Request failed with status 500: boom'))).toBe(
      GENERIC_FALLBACK,
    );
  });

  it('ignores an empty-string detail rather than treating it as a known code', () => {
    expect(formatApiError({ detail: '' })).toBe(GENERIC_FALLBACK);
  });

  it('recognises a timeout error even when it is not the real ApiTimeoutError class', () => {
    class ForeignTimeout extends Error {}
    const fake = new ForeignTimeout('timed out');
    fake.name = 'ApiTimeoutError';

    expect(formatApiError(fake)).toBe(TIMEOUT_MESSAGE);
  });

  it('recognises a validation error even when it is not the real ApiValidationError class', () => {
    class ForeignValidation extends Error {}
    const fake = new ForeignValidation('bad shape');
    fake.name = 'ApiValidationError';

    expect(formatApiError(fake)).toBe(VALIDATION_MESSAGE);
  });

  it('falls through to the caller fallback when a TypeError message matches no known network fragment', () => {
    const err = new TypeError('Something completely unrelated happened');

    expect(formatApiError(err, { fallback: 'Could not complete the request.' })).toBe(
      'Could not complete the request.',
    );
  });
});
