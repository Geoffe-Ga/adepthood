/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { RETURN_COMPLETE_HEADING, RETURN_COPY_ENTRIES } from '../returnCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('returnCopy — balance-not-altitude intent rule', () => {
  it('exposes at least one copy entry to sweep', () => {
    expect(RETURN_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no RETURN_COPY_ENTRIES entry ranks or shames the person', () => {
    for (const entry of RETURN_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('includes the warm completion heading in RETURN_COPY_ENTRIES', () => {
    expect(RETURN_COPY_ENTRIES).toContain(RETURN_COMPLETE_HEADING);
  });
});
