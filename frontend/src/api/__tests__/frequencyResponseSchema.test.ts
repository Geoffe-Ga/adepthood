/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { frequencyResponseSchema } from '../schemas';

const validPayload = {
  stage_number: 5,
  color: 'Orange',
  aspect: 'Mind',
  practice_name: 'Concentration on the breath',
  practice_id: 17,
  user_practice_id: 42,
  banner_text: 'You are in the Orange frequency of APTITUDE…',
};

describe('frequencyResponseSchema', () => {
  it('parses a fully-populated payload', () => {
    expect(frequencyResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  it('parses a payload with null user_practice_id (preset fallback)', () => {
    expect(
      frequencyResponseSchema.safeParse({ ...validPayload, user_practice_id: null }).success,
    ).toBe(true);
  });

  it.each([null, undefined, 42, 'string', true, []])('rejects non-object input (%p)', (value) => {
    expect(frequencyResponseSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    'stage_number',
    'color',
    'aspect',
    'practice_name',
    'practice_id',
    'banner_text',
  ] as const)('rejects when required field %s is missing (drift raises)', (field) => {
    const { [field]: _omitted, ...partial } = validPayload;
    void _omitted;
    expect(frequencyResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects when stage_number is a string instead of a number', () => {
    expect(frequencyResponseSchema.safeParse({ ...validPayload, stage_number: '5' }).success).toBe(
      false,
    );
  });

  it('rejects when user_practice_id is an unexpected type (e.g. string)', () => {
    expect(
      frequencyResponseSchema.safeParse({ ...validPayload, user_practice_id: '42' }).success,
    ).toBe(false);
  });

  it('rejects when color is a number — the banner expects a string label', () => {
    expect(frequencyResponseSchema.safeParse({ ...validPayload, color: 5 }).success).toBe(false);
  });
});
