/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  REVIEW_INVITATION_COPY_ENTRIES,
  beginReviewA11y,
  continueReviewA11y,
  continueReviewLabel,
  writeReviewCta,
} from '../reviewInvitationCopy';

import type { ReflectionLevel } from '@/api';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('reviewInvitationCopy — the review CTA names its layer', () => {
  const ctas: [ReflectionLevel, string][] = [
    ['week', 'Write your Weekly Review'],
    ['stage', 'Write your Stage Review'],
    ['section', 'Write your Section Review'],
    ['course', 'Write your Course Review'],
  ];
  it.each(ctas)('a %s review reads "%s"', (level, expected) => {
    expect(writeReviewCta(level)).toBe(expected);
  });

  it('frames beginning and continuing a review distinctly for assistive tech', () => {
    expect(beginReviewA11y('Course Review')).toBe('Begin your Course Review');
    expect(continueReviewA11y('Course Review')).toBe('Continue your Course Review');
    expect(continueReviewLabel('Course Review')).toBe('Continue — Course Review');
  });
});

describe('reviewInvitationCopy — balance-not-altitude intent rule', () => {
  it('exposes every review-invitation string to sweep', () => {
    expect(REVIEW_INVITATION_COPY_ENTRIES.length).toBeGreaterThanOrEqual(8);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of REVIEW_INVITATION_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry leans on streaks, counts, forever, keep-going, or must pressure language', () => {
    for (const entry of REVIEW_INVITATION_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bstreak/i);
      expect(entry).not.toMatch(/\d/);
      expect(entry).not.toMatch(/\bforever\b/i);
      expect(entry).not.toMatch(/keep going/i);
      expect(entry).not.toMatch(/\bmust\b/i);
    }
  });
});
