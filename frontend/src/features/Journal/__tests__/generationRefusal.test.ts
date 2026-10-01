import { describe, expect, it } from '@jest/globals';

import { fundingOutcome } from '../fundingOutcome';
import { generationRefusal } from '../generationRefusal';

import { ApiError } from '@/api';

describe('generationRefusal (#623)', () => {
  it('names the concurrent-slot refusal', () => {
    expect(generationRefusal(new ApiError(429, 'generation_in_progress'))).toBe('in_progress');
  });

  it('names the daily-ceiling refusal', () => {
    expect(generationRefusal(new ApiError(429, 'daily_generation_limit_reached'))).toBe(
      'daily_limit',
    );
  });

  it.each([
    ['the generic per-minute 429', new ApiError(429, 'rate_limit_exceeded')],
    ['the detail on another status', new ApiError(409, 'daily_generation_limit_reached')],
    ['a 402', new ApiError(402, 'insufficient_offerings')],
    ['a plain error', new Error('daily_generation_limit_reached')],
    ['null', null],
    ['a string', 'generation_in_progress'],
  ])('is null for %s', (_label, error) => {
    expect(generationRefusal(error)).toBeNull();
  });

  it('is never routed to the refill remedy, which stays 402-only', () => {
    expect(fundingOutcome(new ApiError(429, 'generation_in_progress'))).toBeNull();
    expect(fundingOutcome(new ApiError(429, 'daily_generation_limit_reached'))).toBeNull();
  });
});
