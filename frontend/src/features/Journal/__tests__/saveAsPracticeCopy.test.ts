/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  JOURNALING_PRACTICE_NAME,
  SAVE_AS_PRACTICE_COPY_ENTRIES,
  keepPracticeCancelLabel,
  keepPracticeSummary,
  keptPracticeConfirmation,
} from '../saveAsPracticeCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('saveAsPracticeCopy — balance-not-altitude intent rule', () => {
  it('exposes copy entries to sweep', () => {
    expect(SAVE_AS_PRACTICE_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of SAVE_AS_PRACTICE_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry counts, scores, or leans on pressure language', () => {
    for (const entry of SAVE_AS_PRACTICE_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak\b/i);
      expect(entry).not.toMatch(/\bshould\b/i);
      expect(entry).not.toMatch(/\bmust\b/i);
      expect(entry).not.toMatch(/\bdaily\b/i);
      expect(entry).not.toMatch(/\bevery day\b/i);
      expect(entry).not.toMatch(/\bpoints?\b/i);
    }
  });
});

describe('saveAsPracticeCopy — what the writer is told before they decide', () => {
  it('says the session is counted when Green is open and free', () => {
    const summary = keepPracticeSummary({ displaces: null, waitingAt: null });

    expect(summary).toContain(JOURNALING_PRACTICE_NAME);
    expect(summary).toContain('Green');
    expect(summary).toMatch(/this session is counted/i);
    // Nothing is being displaced, so nothing is named as being displaced.
    expect(summary).not.toMatch(/holding/i);
  });

  it('names the practice Green is holding rather than replacing it silently', () => {
    const summary = keepPracticeSummary({ displaces: 'Loving-kindness', waitingAt: null });

    expect(summary).toContain('Loving-kindness');
  });

  it('says plainly that a session is not counted yet when Green is not open', () => {
    const summary = keepPracticeSummary({ displaces: null, waitingAt: 'Beige' });

    expect(summary).toContain('Beige');
    expect(summary).toMatch(/not counted/i);
  });

  it('says both when Green is neither open nor free', () => {
    const summary = keepPracticeSummary({ displaces: 'Loving-kindness', waitingAt: 'Beige' });

    expect(summary).toContain('Loving-kindness');
    expect(summary).toContain('Beige');
    expect(summary).toMatch(/not counted/i);
  });
});

describe('saveAsPracticeCopy — the ways out and the way it ends', () => {
  it('offers to keep the named practice instead, when one would be displaced', () => {
    expect(keepPracticeCancelLabel('Loving-kindness')).toBe('Keep Loving-kindness');
  });

  it('is a plain decline when nothing would be displaced', () => {
    expect(keepPracticeCancelLabel(null)).toBe('Not now');
  });

  it('says the session landed on the practice when it did', () => {
    const kept = keptPracticeConfirmation(true);

    expect(kept).toContain(JOURNALING_PRACTICE_NAME);
    expect(kept).toMatch(/this session/i);
  });

  it('does not claim a session that was never logged', () => {
    const kept = keptPracticeConfirmation(false);

    expect(kept).toContain(JOURNALING_PRACTICE_NAME);
    expect(kept).not.toMatch(/this session/i);
  });
});
