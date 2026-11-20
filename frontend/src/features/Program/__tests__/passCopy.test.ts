import { describe, expect, it } from '@jest/globals';

import { pendingPassNotSavedCopy, pendingPassSavedCopy, pendingPassSentence } from '../passCopy';

const TODAY = '2026-11-15';
const HELD = '2026-12-01';

describe('pendingPassSentence (#3747)', () => {
  it('names the held day while it is unchanged, with nothing to save', () => {
    expect(pendingPassSentence(HELD, HELD, TODAY)).toBe('Your next pass begins December 1, 2026.');
  });

  it('says a later day moves the pass, before anything is saved', () => {
    expect(pendingPassSentence('2026-12-20', HELD, TODAY)).toBe(
      'Saving moves your next pass to December 20, 2026.',
    );
  });

  it('says today starts the pass now and keeps the current one', () => {
    expect(pendingPassSentence(TODAY, HELD, TODAY)).toBe(
      'Saving starts your next pass today; your current pass stays on Stats and progress.',
    );
  });

  it('says an earlier day starts the pass now, counted from that day', () => {
    expect(pendingPassSentence('2026-11-10', HELD, TODAY)).toBe(
      'Saving starts your next pass now, counted from November 10, 2026; your current pass stays on Stats and progress.',
    );
  });
});

describe('pendingPassSavedCopy (#3747)', () => {
  it('confirms a move to a later day', () => {
    expect(pendingPassSavedCopy('2026-12-20', TODAY)).toBe(
      'Saved. Your next pass now begins December 20, 2026.',
    );
  });

  it('confirms a pass started now', () => {
    expect(pendingPassSavedCopy('2026-11-10', TODAY)).toBe(
      'Saved. Your new pass has begun, counted from November 10, 2026.',
    );
  });
});

describe('pendingPassNotSavedCopy (#3747)', () => {
  it('says what did not happen, what to do, and that the held day stands', () => {
    expect(pendingPassNotSavedCopy(HELD)).toBe(
      "Your next pass's day didn't save. Check your connection and save again; it still begins December 1, 2026.",
    );
  });
});

describe('the habits waiting for the pass move with it (#3762)', () => {
  it('says a later day moves the pass and its habits, before anything is saved', () => {
    expect(pendingPassSentence('2026-12-20', HELD, TODAY, true)).toBe(
      'Saving moves your next pass, and the habits waiting for it, to December 20, 2026.',
    );
  });

  it('says starting today moves its habits to match', () => {
    expect(pendingPassSentence(TODAY, HELD, TODAY, true)).toBe(
      'Saving starts your next pass today and moves the habits waiting for it to match; your current pass stays on Stats and progress.',
    );
  });

  it('says starting on an earlier day moves its habits to match', () => {
    expect(pendingPassSentence('2026-11-10', HELD, TODAY, true)).toBe(
      'Saving starts your next pass now, counted from November 10, 2026, and moves the habits waiting for it to match; your current pass stays on Stats and progress.',
    );
  });

  it('names only the held day while it is unchanged', () => {
    expect(pendingPassSentence(HELD, HELD, TODAY, true)).toBe(
      'Your next pass begins December 1, 2026.',
    );
  });

  it('confirms the habits moved with a later day', () => {
    expect(pendingPassSavedCopy('2026-12-20', TODAY, true)).toBe(
      'Saved. Your next pass now begins December 20, 2026, and the habits waiting for it moved with it.',
    );
  });

  it('confirms the habits moved with a pass started now', () => {
    expect(pendingPassSavedCopy('2026-11-10', TODAY, true)).toBe(
      'Saved. Your new pass has begun, counted from November 10, 2026, and the habits waiting for it moved with it.',
    );
  });
});
