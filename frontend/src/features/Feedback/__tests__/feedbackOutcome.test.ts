/* eslint-env jest */
/* global describe, it, expect */
import { ApiError, ApiTimeoutError, ApiValidationError } from '@/api';
import {
  classifySubmitFailure,
  FEEDBACK_EDIT_AFTER_FAILURE_COPY,
  FEEDBACK_OUTCOME_COPY,
  FEEDBACK_SUCCESS_COPY,
  isDefinitiveRefusal,
} from '@/features/Feedback/feedbackOutcome';

const networkError = new TypeError('Network request failed');
const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

describe('classifySubmitFailure', () => {
  it.each([
    ['a network TypeError', networkError, 'retryable'],
    ['an AbortError', abortError, 'retryable'],
    ['a timeout', new ApiTimeoutError('/feedback/', 1), 'retryable'],
    ['408', new ApiError(408, 'timeout'), 'retryable'],
    ['500', new ApiError(500, 'internal_error'), 'retryable'],
    ['502', new ApiError(502, 'bad gateway'), 'retryable'],
    ['503', new ApiError(503, 'unavailable'), 'retryable'],
    ['504', new ApiError(504, 'gateway timeout'), 'retryable'],
    ['429', new ApiError(429, 'rate limited'), 'rate_limited'],
    ['422', new ApiError(422, 'validation'), 'invalid'],
    ['400', new ApiError(400, 'bad request'), 'invalid'],
    ['401', new ApiError(401, 'unauthorized'), 'session'],
    ['403', new ApiError(403, 'forbidden'), 'session'],
    [
      'a receipt that failed validation',
      new ApiValidationError('/feedback/', 201, []),
      'unexpected',
    ],
    ['a non-Error throwable', 'boom', 'retryable'],
  ])('%s is %s', (_name, error, expected) => {
    expect(classifySubmitFailure(error)).toBe(expected);
  });
});

describe('isDefinitiveRefusal', () => {
  it('unfreezes only on a body refusal, which no retry can have got past', () => {
    expect(isDefinitiveRefusal('invalid')).toBe(true);
    // 429 and 401 can be the LAST error of a retry loop whose first attempt was
    // stored (review [1]), so they keep the attempt frozen.
    expect(isDefinitiveRefusal('rate_limited')).toBe(false);
    expect(isDefinitiveRefusal('session')).toBe(false);
    expect(isDefinitiveRefusal('retryable')).toBe(false);
    expect(isDefinitiveRefusal('unexpected')).toBe(false);
  });
});

describe('copy', () => {
  it('tells the truth about retry safety', () => {
    expect(FEEDBACK_OUTCOME_COPY.retryable).toMatch(/safe to send again/);
    expect(FEEDBACK_OUTCOME_COPY.retryable).toMatch(/will not create a duplicate/);
    expect(FEEDBACK_OUTCOME_COPY.unexpected).toMatch(/will not create a duplicate/);
    expect(FEEDBACK_OUTCOME_COPY.rate_limited).toMatch(/send it again later/);
    expect(FEEDBACK_OUTCOME_COPY.invalid).toMatch(/draft is still here/);
    expect(FEEDBACK_OUTCOME_COPY.session).toMatch(/not sent/);
    expect(FEEDBACK_EDIT_AFTER_FAILURE_COPY).toMatch(/second one/);
  });

  it('never promises a response time', () => {
    const everything = [
      ...Object.values(FEEDBACK_OUTCOME_COPY),
      ...Object.values(FEEDBACK_SUCCESS_COPY),
    ].join(' ');
    expect(everything).not.toMatch(/\b(within|hours?|days?|soon|shortly|respond|reply)\b/i);
  });
});
