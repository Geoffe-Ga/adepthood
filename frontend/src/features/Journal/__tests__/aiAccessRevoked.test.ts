import { describe, expect, it } from '@jest/globals';

import { aiAccessRevoked } from '../aiAccessRevoked';

import { ApiError } from '@/api';

describe('aiAccessRevoked (#1938, B21 E1)', () => {
  it('recognises the 403 a revoked entitlement is refused with', () => {
    expect(aiAccessRevoked(new ApiError(403, 'ai_access_revoked'))).toBe(true);
  });

  it.each([
    ['a generic 403', new ApiError(403, 'forbidden')],
    ['the detail on another status', new ApiError(402, 'ai_access_revoked')],
    ['an empty wallet', new ApiError(402, 'insufficient_offerings')],
    ['a plain object without a status', { detail: 'ai_access_revoked' }],
    ['null', null],
    ['a string', 'ai_access_revoked'],
  ])('ignores %s', (_label, error) => {
    expect(aiAccessRevoked(error)).toBe(false);
  });
});
