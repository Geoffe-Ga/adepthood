/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { MORNING_PAGES_COPY_ENTRIES } from '../morningPagesCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('morningPagesCopy — balance-not-altitude intent rule', () => {
  it('exposes at least one copy entry to sweep', () => {
    expect(MORNING_PAGES_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no MORNING_PAGES_COPY_ENTRIES entry ranks or shames the person', () => {
    for (const entry of MORNING_PAGES_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry leans on forever, keep-going, or must pressure language', () => {
    for (const entry of MORNING_PAGES_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bforever\b/i);
      expect(entry).not.toMatch(/keep going/i);
      expect(entry).not.toMatch(/\bmust\b/i);
    }
  });
});
