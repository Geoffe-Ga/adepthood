/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  JOURNALING_HABIT_NAME,
  SAVE_AS_HABIT_COPY_ENTRIES,
  savedHabitConfirmation,
  stagePreviewLabel,
} from '../saveAsHabitCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('saveAsHabitCopy — balance-not-altitude intent rule', () => {
  it('exposes copy entries to sweep', () => {
    expect(SAVE_AS_HABIT_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of SAVE_AS_HABIT_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry counts, scores, or leans on pressure language', () => {
    for (const entry of SAVE_AS_HABIT_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak\b/i);
      expect(entry).not.toMatch(/\bshould\b/i);
      expect(entry).not.toMatch(/\bmust\b/i);
      expect(entry).not.toMatch(/\bdaily\b/i);
      expect(entry).not.toMatch(/\bevery day\b/i);
      expect(entry).not.toMatch(/\bpoints?\b/i);
    }
  });
});

describe('saveAsHabitCopy — the strings themselves', () => {
  it('names the row by the habit and the stage that row lands on', () => {
    expect(stagePreviewLabel('Meditate', 'Purple')).toBe('Meditate — Purple');
  });

  it('says where the habit went, and that it is the writer who opens it', () => {
    expect(savedHabitConfirmation()).toContain(JOURNALING_HABIT_NAME);
    expect(savedHabitConfirmation()).toMatch(/locked/i);
  });
});
