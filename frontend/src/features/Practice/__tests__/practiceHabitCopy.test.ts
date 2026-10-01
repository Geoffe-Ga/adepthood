/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  PRACTICE_HABIT_CLEAR_A11Y,
  PRACTICE_HABIT_COPY_ENTRIES,
  PRACTICE_HABIT_PICKER_HELP,
  PRACTICE_HABIT_PICKER_TITLE,
  PRACTICE_HABIT_ROW_DESCRIPTION,
  PRACTICE_HABIT_ROW_LINKED_PENDING,
  PRACTICE_HABIT_ROW_UNLINKED,
  PRACTICE_SETTINGS_TITLE,
  practiceCheckedOffToast,
  practiceHabitChooseA11y,
  practiceHabitRowLabel,
} from '../practiceHabitCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('practiceHabitCopy — balance-not-altitude intent rule', () => {
  it('exposes copy entries to sweep', () => {
    expect(PRACTICE_HABIT_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of PRACTICE_HABIT_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry counts, scores, or leans on pressure language', () => {
    for (const entry of PRACTICE_HABIT_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak\b/i);
      expect(entry).not.toMatch(/\bshould\b/i);
      expect(entry).not.toMatch(/\bmust\b/i);
      expect(entry).not.toMatch(/\bdaily\b/i);
      expect(entry).not.toMatch(/\bevery day\b/i);
      expect(entry).not.toMatch(/\bpoints?\b/i);
    }
  });
});

describe('practiceHabitCopy — the strings themselves', () => {
  it('names the Settings group and row', () => {
    expect(PRACTICE_SETTINGS_TITLE).toBe('Practice');
    expect(PRACTICE_HABIT_ROW_DESCRIPTION).toMatch(/practice session/);
  });

  it('names the row by the link, and never reads "not linked" for a pending one', () => {
    expect(practiceHabitRowLabel('Sit')).toBe('Practice sessions → Sit');
    expect(practiceHabitRowLabel(null)).toBe(PRACTICE_HABIT_ROW_UNLINKED);
    expect(practiceHabitRowLabel('Sit', { paused: true })).toBe(
      'Practice sessions → Sit · paused while locked',
    );
    expect(PRACTICE_HABIT_ROW_UNLINKED).toBe('Practice sessions → not linked');
    expect(PRACTICE_HABIT_ROW_LINKED_PENDING).toBe('Practice sessions → a habit');
    expect(PRACTICE_HABIT_ROW_LINKED_PENDING).not.toMatch(/not linked/);
  });

  it('asks which habit, and says what a practice session will do to it', () => {
    expect(PRACTICE_HABIT_PICKER_TITLE).toBe('Which habit?');
    expect(PRACTICE_HABIT_PICKER_HELP).toBe(
      'Pick a habit you already keep. Once it is open, a finished practice session checks it off.',
    );
  });

  it('labels each habit row with what choosing it does, and the clear row with what it stops', () => {
    expect(practiceHabitChooseA11y('Sit')).toBe('Check off Sit when a practice session ends');
    expect(PRACTICE_HABIT_CLEAR_A11Y).toBe(
      'Stop checking off a habit when a practice session ends',
    );
  });

  it('confirms a check-off by the habit’s own name and nothing more', () => {
    expect(practiceCheckedOffToast('Sit')).toBe('Sit checked off');
  });

  it('sweeps every string', () => {
    expect(PRACTICE_HABIT_COPY_ENTRIES).toContain(practiceCheckedOffToast('Sit'));
    expect(PRACTICE_HABIT_COPY_ENTRIES).toContain(PRACTICE_HABIT_PICKER_HELP);
    expect(PRACTICE_HABIT_COPY_ENTRIES).toContain(PRACTICE_HABIT_ROW_LINKED_PENDING);
    expect(PRACTICE_HABIT_COPY_ENTRIES).toContain(practiceHabitChooseA11y('Sit'));
  });
});
