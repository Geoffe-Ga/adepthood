/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  MORNING_PAGES_CARD_COPY_ENTRIES,
  MORNING_PAGES_COPY_ENTRIES,
  MORNING_PAGES_NEVER_A11Y,
  MORNING_PAGES_NEVER_LINK,
  MORNING_PAGES_OFFER_AGAIN_DESCRIPTION,
  MORNING_PAGES_OFFER_AGAIN_DONE,
  MORNING_PAGES_OFFER_AGAIN_LABEL,
  MORNING_PAGES_SETTINGS_COPY_ENTRIES,
  morningPageTitle,
} from '../morningPagesCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('morningPagesCopy — balance-not-altitude intent rule', () => {
  it('builds a sortable, single-line daily title', () => {
    expect(morningPageTitle('2026-09-10')).toBe('2026-09-10 Daily Journal');
  });
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

  it('no entry counts, keeps a streak, or calls a day missed', () => {
    for (const entry of MORNING_PAGES_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\d/);
      expect(entry).not.toMatch(/streak/i);
      expect(entry).not.toMatch(/\bmissed\b/i);
      expect(entry).not.toMatch(/don.t break/i);
    }
  });

  it('sweeps the card and the Settings row together, every string once', () => {
    expect(MORNING_PAGES_CARD_COPY_ENTRIES).toHaveLength(9);
    expect(MORNING_PAGES_SETTINGS_COPY_ENTRIES).toEqual([
      MORNING_PAGES_OFFER_AGAIN_LABEL,
      MORNING_PAGES_OFFER_AGAIN_DESCRIPTION,
      MORNING_PAGES_OFFER_AGAIN_DONE,
    ]);
    expect(MORNING_PAGES_COPY_ENTRIES).toEqual([
      ...MORNING_PAGES_CARD_COPY_ENTRIES,
      ...MORNING_PAGES_SETTINGS_COPY_ENTRIES,
    ]);
    expect(new Set(MORNING_PAGES_COPY_ENTRIES).size).toBe(MORNING_PAGES_COPY_ENTRIES.length);
    expect(MORNING_PAGES_CARD_COPY_ENTRIES).toContain(MORNING_PAGES_NEVER_LINK);
    expect(MORNING_PAGES_CARD_COPY_ENTRIES).toContain(MORNING_PAGES_NEVER_A11Y);
  });

  it('names the never-again link by its visible words first (WCAG 2.5.3)', () => {
    expect(MORNING_PAGES_NEVER_A11Y.startsWith(MORNING_PAGES_NEVER_LINK)).toBe(true);
    expect(MORNING_PAGES_NEVER_A11Y.length).toBeGreaterThan(MORNING_PAGES_NEVER_LINK.length);
  });

  it('promises the restore only for this device, where the decline is kept', () => {
    expect(MORNING_PAGES_OFFER_AGAIN_DESCRIPTION).toMatch(/on this device/);
    expect(MORNING_PAGES_OFFER_AGAIN_DONE).toMatch(/on this device/);
  });
});
