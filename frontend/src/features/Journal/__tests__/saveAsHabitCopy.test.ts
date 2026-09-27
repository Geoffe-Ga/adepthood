/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  JOURNALING_HABIT_NAME,
  OFFER_AGAIN_DESCRIPTION,
  OFFER_AGAIN_DONE,
  OFFER_AGAIN_LABEL,
  SAVE_AS_HABIT_COPY_ENTRIES,
  WRITING_HABIT_NEW,
  WRITING_TIMER_ROW_LINKED_PENDING,
  WRITING_TIMER_ROW_UNLINKED,
  checkedOffToast,
  linkedHabitConfirmation,
  savedHabitConfirmation,
  stagePreviewLabel,
  writingHabitChooseA11y,
  writingTimerRowLabel,
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

describe('saveAsHabitCopy — the writing-habit link (#2861)', () => {
  it('confirms a check-off by the habit’s own name and nothing more', () => {
    expect(checkedOffToast('Morning pages')).toBe('Morning pages checked off');
  });

  it('says once what linking will do', () => {
    expect(linkedHabitConfirmation('Morning pages')).toBe(
      'Morning pages will be checked off when a timer ends.',
    );
  });

  it('offers a new Journaling habit by that name', () => {
    expect(WRITING_HABIT_NEW).toBe('New habit: Journaling');
  });

  it('labels each habit row with what choosing it does', () => {
    expect(writingHabitChooseA11y('Stretch')).toBe('Check off Stretch when a writing timer ends');
  });

  it('names the Settings row by the link, and never reads "not linked" for a pending one', () => {
    expect(writingTimerRowLabel('Morning pages')).toBe('Writing timer → Morning pages');
    expect(writingTimerRowLabel(null)).toBe(WRITING_TIMER_ROW_UNLINKED);
    expect(WRITING_TIMER_ROW_UNLINKED).toBe('Writing timer → not linked');
    expect(WRITING_TIMER_ROW_LINKED_PENDING).toBe('Writing timer → a habit');
    expect(WRITING_TIMER_ROW_LINKED_PENDING).not.toMatch(/not linked/);
  });

  it('keeps the offer-again promise to this device', () => {
    expect(OFFER_AGAIN_LABEL).toBe('Offer again at the end of a session');
    expect(OFFER_AGAIN_DESCRIPTION).toMatch(/on this device/);
    expect(OFFER_AGAIN_DONE).toMatch(/on this device/);
    for (const entry of [OFFER_AGAIN_LABEL, OFFER_AGAIN_DESCRIPTION, OFFER_AGAIN_DONE]) {
      expect(entry).not.toMatch(/\b(all|every|other) (your )?devices?\b/i);
      expect(entry).not.toMatch(/\baccount\b/i);
    }
  });

  it('sweeps every new string too', () => {
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(checkedOffToast(JOURNALING_HABIT_NAME));
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(OFFER_AGAIN_DESCRIPTION);
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(WRITING_TIMER_ROW_LINKED_PENDING);
  });
});
