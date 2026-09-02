/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  WRITING_TIMER_COPY_ENTRIES,
  writingSessionSummary,
  writingTimerPresetA11yLabel,
  writingTimerPresetLabel,
} from '../writingTimerCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('writingTimerCopy — balance-not-altitude intent rule', () => {
  it('exposes at least one copy entry to sweep', () => {
    expect(WRITING_TIMER_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no WRITING_TIMER_COPY_ENTRIES entry ranks or shames the person', () => {
    for (const entry of WRITING_TIMER_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry leans on forever, keep-going, or must pressure language', () => {
    for (const entry of WRITING_TIMER_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bforever\b/i);
      expect(entry).not.toMatch(/keep going/i);
      expect(entry).not.toMatch(/\bmust\b/i);
    }
  });

  it('never counts sessions or names a streak', () => {
    for (const entry of WRITING_TIMER_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak\b/i);
      expect(entry).not.toMatch(/sessions today/i);
      expect(entry).not.toMatch(/\bshould\b/i);
    }
  });
});

describe('writingTimerCopy — the strings themselves', () => {
  it('labels a preset by its length, on the face and to a screen reader', () => {
    expect(writingTimerPresetLabel(10)).toBe('10 min');
    expect(writingTimerPresetA11yLabel(30)).toBe('Write for 30 minutes');
  });

  it('reports a finished session as a plain account of what happened', () => {
    expect(writingSessionSummary(20)).toBe('You wrote for 20 minutes.');
  });

  it('says one minute in the singular', () => {
    expect(writingSessionSummary(1)).toBe('You wrote for 1 minute.');
  });
});
