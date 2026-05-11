/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { validateFrequencyResponse } from '../index';

const validPayload = {
  stage_number: 5,
  color: 'Orange',
  aspect: 'Mind',
  practice_name: 'Concentration on the breath',
  practice_id: 17,
  user_practice_id: 42,
  banner_text: 'You are in the Orange frequency of APTITUDE…',
};

describe('validateFrequencyResponse', () => {
  it('accepts a fully-populated payload', () => {
    expect(validateFrequencyResponse(validPayload)).toBe(true);
  });

  it('accepts a payload with null user_practice_id (preset fallback)', () => {
    expect(validateFrequencyResponse({ ...validPayload, user_practice_id: null })).toBe(true);
  });

  it.each([null, undefined, 42, 'string', true, []])('rejects non-object input (%p)', (value) => {
    expect(validateFrequencyResponse(value)).toBe(false);
  });

  it.each([
    'stage_number',
    'color',
    'aspect',
    'practice_name',
    'practice_id',
    'banner_text',
  ] as const)('rejects when required field %s is missing', (field) => {
    const { [field]: _omitted, ...partial } = validPayload;
    void _omitted;
    expect(validateFrequencyResponse(partial)).toBe(false);
  });

  it('rejects when stage_number is a string instead of a number', () => {
    expect(validateFrequencyResponse({ ...validPayload, stage_number: '5' })).toBe(false);
  });

  it('rejects when banner_text is missing even if structured fields are present', () => {
    const { banner_text: _omitted, ...partial } = validPayload;
    void _omitted;
    expect(validateFrequencyResponse(partial)).toBe(false);
  });

  it('rejects when user_practice_id is an unexpected type (e.g. string)', () => {
    expect(validateFrequencyResponse({ ...validPayload, user_practice_id: '42' })).toBe(false);
  });

  it('rejects when color is a number — the banner expects a string label', () => {
    expect(validateFrequencyResponse({ ...validPayload, color: 5 })).toBe(false);
  });
});
