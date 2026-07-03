/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { METTA_SESSION_COPY_ENTRIES, METTA_SESSION_PHRASES } from '../mettaSessionCopy';

import type { ReturnWeek } from '@/api';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

const ALL_FOCI: ReturnWeek['focus'][] = [
  'self',
  'benefactor',
  'stranger',
  'antagonist',
  'all_beings',
];

describe('mettaSessionCopy — balance-not-altitude intent rule', () => {
  it('exposes at least one copy entry to sweep', () => {
    expect(METTA_SESSION_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no METTA_SESSION_COPY_ENTRIES entry ranks or shames the person', () => {
    for (const entry of METTA_SESSION_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('every focus has a non-empty phrase list', () => {
    for (const focus of ALL_FOCI) {
      const phrases = METTA_SESSION_PHRASES[focus];
      expect(Array.isArray(phrases)).toBe(true);
      expect(phrases.length).toBeGreaterThan(0);
      for (const phrase of phrases) {
        expect(typeof phrase).toBe('string');
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });
});
