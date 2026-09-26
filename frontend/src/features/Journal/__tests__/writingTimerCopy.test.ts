/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  WRITING_TIMER_COPY_ENTRIES,
  WRITING_TIMER_PRESET_UNIT,
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
  it('labels a preset by its bare number on the face, and in full to a screen reader', () => {
    expect(writingTimerPresetLabel(10)).toBe('10');
    expect(writingTimerPresetLabel(45)).toBe('45');
    expect(writingTimerPresetA11yLabel(30)).toBe('Write for 30 minutes');
  });

  it('carries the unit once, at the end of the row, and sweeps it with the rest', () => {
    expect(WRITING_TIMER_PRESET_UNIT).toBe('min');
    expect(WRITING_TIMER_COPY_ENTRIES).toContain(WRITING_TIMER_PRESET_UNIT);
  });

  it('reports a finished session as a plain account of what happened', () => {
    expect(writingSessionSummary(20)).toBe('You wrote for 20 minutes.');
  });

  it('says one minute in the singular', () => {
    expect(writingSessionSummary(1)).toBe('You wrote for 1 minute.');
  });
});
