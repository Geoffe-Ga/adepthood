import { describe, it, expect } from '@jest/globals';

import {
  QUOTE_FOLD_COPY_ENTRIES,
  foldSelectedLabel,
  inclusionRetryHint,
  writeReviewWithLabel,
} from '../quoteFoldCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('quoteFoldCopy -- the fold vocabulary, counted honestly (#2885)', () => {
  it('names the fold action exactly, singular and plural', () => {
    expect(foldSelectedLabel(1)).toBe('Fold 1 quote into this review');
    expect(foldSelectedLabel(3)).toBe('Fold 3 quotes into this review');
    expect(foldSelectedLabel(0)).toBe('Choose quotes to fold in');
  });

  it('names the write-a-review action exactly, singular and plural', () => {
    expect(writeReviewWithLabel(1)).toBe('Write a review with 1 quote');
    expect(writeReviewWithLabel(2)).toBe('Write a review with 2 quotes');
    expect(writeReviewWithLabel(0)).toBe('Choose quotes to fold in');
  });

  it('says how many quotes are still unmarked, and that trying again is optional', () => {
    expect(inclusionRetryHint(1)).toBe(
      'One quote is in your review but isn’t marked as used yet — try again whenever you like.',
    );
    expect(inclusionRetryHint(2)).toBe(
      '2 quotes are in your review but aren’t marked as used yet — try again whenever you like.',
    );
  });
});

describe('quoteFoldCopy -- balance-not-altitude intent rule', () => {
  it('no entry ranks or shames the person', () => {
    for (const entry of QUOTE_FOLD_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry leans on pressure, urgency, or streak language', () => {
    for (const entry of QUOTE_FOLD_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\b(forever|must|hurry|streak|don’t miss|now or)\b/i);
      expect(entry).not.toMatch(/keep going/i);
      expect(entry).not.toMatch(/\binject/i);
    }
  });
});
