/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  JOURNALING_HABIT_NAME,
  LINK_HABIT_NUDGE_SWITCH_DESCRIPTION,
  LINK_HABIT_NUDGE_SWITCH_LABEL,
  LINK_HABIT_NUDGE_DECLINE,
  LINK_HABIT_NUDGE_DECLINE_A11Y,
  LINK_HABIT_NUDGE_PROMPT,
  LINK_HABIT_NUDGE_SETTINGS,
  LINK_HABIT_NUDGE_SETTINGS_A11Y,
  OFFER_SWITCH_DESCRIPTION,
  OFFER_SWITCH_LABEL,
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
    expect(writingTimerRowLabel('Stretch', { paused: true })).toBe(
      'Writing timer → Stretch · paused while locked',
    );
    expect(WRITING_TIMER_ROW_UNLINKED).toBe('Writing timer → not linked');
    expect(WRITING_TIMER_ROW_LINKED_PENDING).toBe('Writing timer → a habit');
    expect(WRITING_TIMER_ROW_LINKED_PENDING).not.toMatch(/not linked/);
  });

  it('names the offer switch by the state it holds, and keeps its promise to this device', () => {
    expect(OFFER_SWITCH_LABEL).toBe('Offer to keep a session');
    expect(OFFER_SWITCH_LABEL).not.toMatch(/again/i);
    expect(OFFER_SWITCH_DESCRIPTION).toMatch(/on this device/);
    expect(OFFER_SWITCH_DESCRIPTION).toMatch(/turns this off/);
    for (const entry of [OFFER_SWITCH_LABEL, OFFER_SWITCH_DESCRIPTION]) {
      expect(entry).not.toMatch(/\b(all|every|other) (your )?devices?\b/i);
      expect(entry).not.toMatch(/\baccount\b/i);
    }
  });

  it('sweeps every new string too', () => {
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(checkedOffToast(JOURNALING_HABIT_NAME));
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(OFFER_SWITCH_DESCRIPTION);
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(WRITING_TIMER_ROW_LINKED_PENDING);
  });
});

describe('saveAsHabitCopy — the link-a-habit note (#3006)', () => {
  const NUDGE_ENTRIES = [
    LINK_HABIT_NUDGE_PROMPT,
    LINK_HABIT_NUDGE_SETTINGS,
    LINK_HABIT_NUDGE_SETTINGS_A11Y,
    LINK_HABIT_NUDGE_DECLINE,
    LINK_HABIT_NUDGE_DECLINE_A11Y,
    LINK_HABIT_NUDGE_SWITCH_LABEL,
    LINK_HABIT_NUDGE_SWITCH_DESCRIPTION,
  ];

  it('names its two actions plainly', () => {
    expect(LINK_HABIT_NUDGE_SETTINGS).toBe('Go to Settings');
    expect(LINK_HABIT_NUDGE_DECLINE).toBe("Don't show again");
    expect(LINK_HABIT_NUDGE_DECLINE_A11Y).toBe("Don't show this note again");
    expect(LINK_HABIT_NUDGE_SWITCH_LABEL).toBe('Show the habit note');
    expect(LINK_HABIT_NUDGE_SWITCH_LABEL).not.toMatch(/again/i);
  });

  it('points to Settings without asking for anything', () => {
    expect(LINK_HABIT_NUDGE_PROMPT).toMatch(/Settings/);
    expect(LINK_HABIT_NUDGE_PROMPT).not.toMatch(/\?/);
  });

  it('keeps the switch’s promise to this device', () => {
    expect(LINK_HABIT_NUDGE_SWITCH_DESCRIPTION).toMatch(/on this device/);
    expect(LINK_HABIT_NUDGE_SWITCH_DESCRIPTION).toMatch(/turns this off/);
    expect(LINK_HABIT_NUDGE_SWITCH_DESCRIPTION).not.toMatch(/\baccount\b/i);
  });

  it.each(NUDGE_ENTRIES)('sweeps %p', (entry) => {
    expect(SAVE_AS_HABIT_COPY_ENTRIES).toContain(entry);
  });
});
