/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { MORNING_PAGES_CTA } from '../morningPagesCopy';
import {
  QUICK_LAUNCH_A11Y,
  QUICK_LAUNCH_COPY_ENTRIES,
  QUICK_LAUNCH_LABEL,
  QUICK_LAUNCH_WAITING,
} from '../quickLaunchCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('quickLaunchCopy — balance-not-altitude intent rule', () => {
  it('exposes copy entries to sweep', () => {
    expect(QUICK_LAUNCH_COPY_ENTRIES.length).toBeGreaterThan(0);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of QUICK_LAUNCH_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry counts, scores, or leans on pressure language', () => {
    for (const entry of QUICK_LAUNCH_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak\b/i);
      expect(entry).not.toMatch(/\bshould\b/i);
      expect(entry).not.toMatch(/\bmust\b/i);
      expect(entry).not.toMatch(/\bdaily\b/i);
      expect(entry).not.toMatch(/\bevery day\b/i);
      expect(entry).not.toMatch(/\bpoints?\b/i);
    }
  });
});

describe('quickLaunchCopy — an affordance, in the voice the journal already uses', () => {
  /**
   * The invitational voice `MORNING_PAGES_CTA` set, not an instrument panel's:
   * a page is begun, a timer is not "started".
   */
  it('invites a page rather than naming a control', () => {
    expect(QUICK_LAUNCH_LABEL).toBe('Begin a timed page');
    expect(QUICK_LAUNCH_LABEL.startsWith(MORNING_PAGES_CTA.replace(' a page', ''))).toBe(true);
    expect(QUICK_LAUNCH_LABEL).not.toMatch(/timer/i);
  });

  it('says what the tap does rather than repeating the visible word', () => {
    expect(QUICK_LAUNCH_A11Y).not.toBe(QUICK_LAUNCH_LABEL);
    expect(QUICK_LAUNCH_A11Y.length).toBeGreaterThan(QUICK_LAUNCH_LABEL.length);
  });

  /**
   * The stage-locked case, said BEFORE the tap rather than discovered as a 403
   * afterwards. It reports a fact about the calendar and names no consequence
   * for the writer — the page itself is never withheld.
   */
  it('explains an uncounted page plainly, and withholds nothing for it', () => {
    expect(QUICK_LAUNCH_WAITING).toMatch(/not counted/i);
    expect(QUICK_LAUNCH_WAITING).not.toMatch(/\bcan'?t\b|\bcannot\b|\bunavailable\b|\blocked\b/i);
  });
});
