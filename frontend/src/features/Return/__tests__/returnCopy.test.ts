/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  RETURN_COMPLETE_HEADING,
  RETURN_COPY_ENTRIES,
  RETURN_OFFER_BODY,
  RETURN_LETGO_HEADING,
  RETURN_LETGO_BODY,
  RETURN_LETGO_RELEASE,
  RETURN_LETGO_RELEASE_A11Y,
  RETURN_LETGO_SKIP,
  RETURN_LETGO_SKIP_A11Y,
  RETURN_LETGO_EMPTY,
  RETURN_LETGO_ERROR,
  buildReturnLetGoHabitA11y,
  RETURN_RECOMMIT_HEADING,
  RETURN_RECOMMIT_BODY,
  RETURN_RECOMMIT_ACTION,
  buildReturnRecommitA11y,
  RETURN_CONFIRM_BODY,
  RETURN_CONFIRM_CANCEL,
  RETURN_CONFIRM_CANCEL_A11Y,
  RETURN_CONFIRM_GUARANTEE,
  RETURN_CONFIRM_HEADING,
  RETURN_CONFIRM_SCRIM_A11Y,
  RETURN_DISMISS_ERROR,
  RETURN_START_ERROR,
  buildReturnConfirmWeekLine,
} from '../returnCopy';

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

  it('expresses the Beige orientation of security and stability in the offer body', () => {
    expect(RETURN_OFFER_BODY).toMatch(/stead|ground|secur|stabil/i);
  });
});

describe('returnCopy — let-go and re-commit additions', () => {
  const newStaticEntries: readonly string[] = [
    RETURN_LETGO_HEADING,
    RETURN_LETGO_BODY,
    RETURN_LETGO_RELEASE,
    RETURN_LETGO_RELEASE_A11Y,
    RETURN_LETGO_SKIP,
    RETURN_LETGO_SKIP_A11Y,
    RETURN_LETGO_EMPTY,
    RETURN_LETGO_ERROR,
    RETURN_RECOMMIT_HEADING,
    RETURN_RECOMMIT_BODY,
    RETURN_RECOMMIT_ACTION,
  ];

  it('the load-error line is distinct from the empty-state line', () => {
    expect(RETURN_LETGO_ERROR).not.toBe(RETURN_LETGO_EMPTY);
    expect(ranksOrShames(RETURN_LETGO_ERROR)).toBe(false);
  });

  it('every new let-go and re-commit string is appended to RETURN_COPY_ENTRIES', () => {
    for (const entry of newStaticEntries) {
      expect(RETURN_COPY_ENTRIES).toContain(entry);
    }
  });

  it('no RETURN_COPY_ENTRIES entry uses failure, demotion, or ranking language', () => {
    for (const entry of RETURN_COPY_ENTRIES) {
      expect(entry).not.toMatch(/fail(ed|ure)?/i);
      expect(entry).not.toMatch(/demoted/i);
      expect(entry).not.toMatch(/fell behind/i);
      expect(entry).not.toMatch(/\bbehind\b/i);
      expect(entry).not.toMatch(/\blost\b/i);
      expect(entry).not.toMatch(/gave up/i);
    }
  });

  it('the let-go body frames releasing as tending the foundation, not failing', () => {
    expect(RETURN_LETGO_BODY).toMatch(/tend|foundation|rest|pause/i);
  });

  it('the per-habit let-go selection label names the habit and stays warm', () => {
    const label = buildReturnLetGoHabitA11y('Morning pages');
    expect(label).toContain('Morning pages');
    expect(ranksOrShames(label)).toBe(false);
    expect(label).not.toMatch(/fail(ed|ure)?/i);
  });

  it('the per-habit re-commit label names the habit and offers to take it up again', () => {
    const label = buildReturnRecommitA11y('Morning pages');
    expect(label).toContain('Morning pages');
    expect(label).toMatch(/take it up again/i);
    expect(ranksOrShames(label)).toBe(false);
  });
});

describe('returnCopy — the Return confirmation informs without pressing', () => {
  const confirmEntries: readonly string[] = [
    RETURN_CONFIRM_HEADING,
    RETURN_CONFIRM_BODY,
    RETURN_CONFIRM_GUARANTEE,
    RETURN_CONFIRM_CANCEL,
    RETURN_CONFIRM_CANCEL_A11Y,
    RETURN_CONFIRM_SCRIM_A11Y,
    RETURN_START_ERROR,
    RETURN_DISMISS_ERROR,
  ];

  it('every confirmation string is appended to RETURN_COPY_ENTRIES', () => {
    for (const entry of confirmEntries) {
      expect(RETURN_COPY_ENTRIES).toContain(entry);
    }
  });

  it('no confirmation string presses with urgency, scarcity, or streaks', () => {
    for (const entry of confirmEntries) {
      expect(ranksOrShames(entry)).toBe(false);
      expect(entry).not.toMatch(/streak|hurry|last chance|expires|only .* left/i);
    }
  });

  it('the guarantee names the ways out: pause, set down, and nothing undone', () => {
    expect(RETURN_CONFIRM_GUARANTEE).toMatch(/pause/i);
    expect(RETURN_CONFIRM_GUARANTEE).toMatch(/set it down/i);
    expect(RETURN_CONFIRM_GUARANTEE).toMatch(/undone/i);
    expect(RETURN_CONFIRM_GUARANTEE).toMatch(/never required/i);
  });

  it('the body says the material shape of the arc: five weeks, one focus each', () => {
    expect(RETURN_CONFIRM_BODY).toMatch(/five weeks/i);
    expect(RETURN_CONFIRM_BODY).toMatch(/each week/i);
  });

  it("a week line carries the server's own ordinal and title, inventing neither", () => {
    expect(buildReturnConfirmWeekLine(3, 'A face you barely know')).toBe(
      '3. A face you barely know',
    );
  });

  it('the two failure lines are distinct and neither blames the person', () => {
    expect(RETURN_START_ERROR).not.toBe(RETURN_DISMISS_ERROR);
    expect(RETURN_START_ERROR).toMatch(/nothing has changed/i);
    expect(RETURN_DISMISS_ERROR).toMatch(/set aside/i);
    expect(ranksOrShames(RETURN_START_ERROR)).toBe(false);
    expect(ranksOrShames(RETURN_DISMISS_ERROR)).toBe(false);
  });
});
