// #2754: only a PATCH that says the QUOTE itself is gone retires it from the
// inclusion warning. Every other failure is transient and keeps it for a retry.
import { describe, expect, it } from '@jest/globals';

import { classifyMarkFailure, QUOTE_GONE_DETAIL, QUOTE_GONE_STATUS } from '../inclusionMark';

import { ApiError } from '@/api';

describe('classifyMarkFailure (#2754)', () => {
  it('names the status and detail the promotions PATCH answers for a removed quote', () => {
    expect(QUOTE_GONE_STATUS).toBe(404);
    expect(QUOTE_GONE_DETAIL).toBe('promotion_not_found');
  });

  it('calls a 404 promotion_not_found gone', () => {
    expect(classifyMarkFailure(new ApiError(QUOTE_GONE_STATUS, QUOTE_GONE_DETAIL))).toBe('gone');
  });

  it('calls a plain object carrying the same status and detail gone', () => {
    expect(classifyMarkFailure({ status: 404, detail: 'promotion_not_found' })).toBe('gone');
  });

  it.each<[string, unknown]>([
    // The quote still exists; it is the review entry the mark targets that is gone.
    ['a 404 for the target entry', new ApiError(404, 'journal_entry_not_found')],
    ['a 404 with no detail', new ApiError(404, '')],
    ['a 403', new ApiError(403, 'promotion_not_found')],
    ['a 410', new ApiError(410, 'promotion_not_found')],
    ['a 422', new ApiError(422, 'target_not_reflection')],
    ['a 500', new ApiError(500, 'promotion_not_found')],
    ['a 503', new ApiError(503, 'unavailable')],
    ['a network failure', new ApiError(0, 'network_error')],
    ['a plain Error', new Error('offline')],
    ['a plain 500 object', { status: 500 }],
    ['a string status', { status: '404', detail: 'promotion_not_found' }],
    ['a bare string', 'promotion_not_found'],
    ['null', null],
    ['undefined', undefined],
  ])('keeps %s as a transient failure', (_label, err) => {
    expect(classifyMarkFailure(err)).toBe('failed');
  });
});
