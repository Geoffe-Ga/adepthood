import { describe, it, expect } from '@jest/globals';

import { isStoredAs, replayReconcilePatch, type SentPage } from '../replayReconcile';

import type { JournalClassification, JournalMessage } from '@/api';

type TierCase = [JournalClassification, JournalClassification, JournalClassification | null];

const FIRST: SentPage = {
  message: 'A page.',
  title: null,
  classification: 'personal',
  chord: { primary: null, secondary: null },
};

function stored(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 9,
    message: 'A page.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    status: 'draft',
    classification: 'personal',
    ...overrides,
  } as JournalMessage;
}

describe('replayReconcilePatch (#2936)', () => {
  it('writes nothing when nothing changed here since the first attempt', () => {
    expect(replayReconcilePatch(FIRST, FIRST, stored({ title: 'Elsewhere' }))).toBeNull();
  });

  it('sends each field changed here, and only those', () => {
    const now: SentPage = { ...FIRST, message: 'A page, more.', title: 'Mine' };

    expect(replayReconcilePatch(FIRST, now, stored())).toEqual({
      message: 'A page, more.',
      title: 'Mine',
    });
  });

  it('sends a changed chord as a pair', () => {
    const now: SentPage = { ...FIRST, chord: { primary: 2, secondary: null } };

    expect(replayReconcilePatch(FIRST, now, stored())).toEqual({
      primary_aspect: 2,
      secondary_aspect: null,
    });
  });

  it.each<TierCase>([
    ['personal', 'intimate', 'intimate'],
    ['public', 'personal', 'personal'],
    ['intimate', 'personal', null],
    ['intimate', 'intimate', null],
    ['personal', 'public', null],
  ])(
    'a stored %s row and a tier changed here to %s sends %s',
    (storedTier, localTier, expected) => {
      const now: SentPage = { ...FIRST, classification: localTier };
      const first: SentPage = {
        ...FIRST,
        classification: localTier === 'public' ? 'intimate' : 'public',
      };

      const patch = replayReconcilePatch(first, now, stored({ classification: storedTier }));

      expect(patch?.classification ?? null).toBe(expected);
    },
  );

  it('leaves a tier chosen elsewhere alone when this page never changed its own', () => {
    // Loosened on purpose on another device: re-tightening it from a stale page
    // would override a choice this page never saw.
    expect(replayReconcilePatch(FIRST, FIRST, stored({ classification: 'public' }))).toBeNull();
  });

  it('never re-tiers a row whose tier it cannot see', () => {
    const now: SentPage = { ...FIRST, classification: 'intimate' };

    expect(replayReconcilePatch(FIRST, now, stored({ classification: undefined }))).toBeNull();
  });
});

describe('isStoredAs', () => {
  it('treats what the server sanitizer strips as no difference', () => {
    const sent = ' Family \u{1F468}‍\u{1F469} ‎walk\u{E0041}.\u0007 ';

    expect(isStoredAs('Family \u{1F468}\u{1F469} walk.', sent)).toBe(true);
  });

  it('keeps a real difference a difference', () => {
    expect(isStoredAs('Family walk.', 'Family walk, and more.')).toBe(false);
    expect(isStoredAs(null, 'Family walk.')).toBe(false);
  });

  it('keeps tabs and newlines, which the server keeps', () => {
    expect(isStoredAs('a\tb', 'ab')).toBe(false);
  });
});
