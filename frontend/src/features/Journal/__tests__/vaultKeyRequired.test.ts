import { describe, expect, it } from '@jest/globals';

import { fundingOutcome } from '../fundingOutcome';

import { messageForCode } from '@/api/errorMessages';
import { ApiError } from '@/api/index';

/**
 * A pool-less managed vault's keyless pass (#3501).
 *
 * The server answers ``402 vault_key_required`` before charging. That is a
 * missing key, not a blip, so it must reach the existing add-a-key remedy and
 * never the margin's "give it a moment and try again".
 */
describe('vault_key_required', () => {
  it('routes to the add-a-key remedy, like llm_key_required', () => {
    expect(fundingOutcome(new ApiError(402, 'vault_key_required'))).toBe('key_required');
  });

  it('is a funding refusal only as a 402', () => {
    expect(fundingOutcome(new ApiError(503, 'vault_key_required'))).toBeNull();
  });

  it('asks for a key, says nothing was charged, and never says to wait', () => {
    const copy = messageForCode('vault_key_required');

    expect(copy).toMatch(/API key/u);
    expect(copy).toMatch(/Settings/u);
    expect(copy).toMatch(/nothing was charged/iu);
    expect(copy).not.toMatch(/moment|try again|later/iu);
    expect(copy).not.toBe(messageForCode('reflection_source_unavailable'));
  });
});
