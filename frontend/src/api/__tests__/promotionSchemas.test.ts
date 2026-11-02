/* eslint-env jest */
/* global describe, it, expect */

/**
 * RED tests for ``promotedQuoteSchema`` / ``promotedQuoteSummarySchema``
 * (select-a-span -> promote-quote).
 *
 * These import symbols that do not exist yet on ``@/api/schemas`` -- this file
 * fails with ``SyntaxError`` / ``Cannot find module`` / ``is not a function``
 * until the implementation-specialist adds the schemas.
 */
import {
  promotedQuoteListItemSchema,
  promotedQuoteListResponseSchema,
  promotedQuoteSchema,
  promotedQuoteSourceKindSchema,
  promotedQuoteSummarySchema,
  promotionStatusFilterSchema,
  readingQuoteItemSchema,
  reflectionSourcesResponseSchema,
} from '../schemas';

/** Return a shallow copy of ``obj`` without ``key`` (avoids unused rest-sibling bindings). */
function omitKey<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

const FULL_QUOTE = {
  id: 55,
  source_kind: 'entry',
  source_entry_id: 7,
  source_content_id: null,
  source_marginalia_id: null,
  anchor_start: 2,
  anchor_end: 19,
  anchor_text: 'went for a run to',
  pending: true,
  stale: false,
};

const SUMMARY_QUOTE = {
  id: 55,
  anchor_start: 2,
  anchor_end: 19,
  anchor_text: 'went for a run to',
  pending: true,
};

describe('promotedQuoteSchema', () => {
  it('accepts a full PromotedQuote payload (mirrors PromotedQuoteResponse)', () => {
    expect(() => promotedQuoteSchema.parse(FULL_QUOTE)).not.toThrow();
  });

  it('round-trips every field exactly', () => {
    const parsed = promotedQuoteSchema.parse(FULL_QUOTE);
    expect(parsed.id).toBe(55);
    expect(parsed.source_entry_id).toBe(7);
    expect(parsed.anchor_start).toBe(2);
    expect(parsed.anchor_end).toBe(19);
    expect(parsed.anchor_text).toBe('went for a run to');
    expect(parsed.pending).toBe(true);
    expect(parsed.stale).toBe(false);
  });

  it('rejects a missing stale flag', () => {
    expect(() => promotedQuoteSchema.parse(omitKey(FULL_QUOTE, 'stale'))).toThrow();
  });

  it('rejects a missing source_entry_id', () => {
    expect(() => promotedQuoteSchema.parse(omitKey(FULL_QUOTE, 'source_entry_id'))).toThrow();
  });

  it('rejects a missing pending flag', () => {
    expect(() => promotedQuoteSchema.parse(omitKey(FULL_QUOTE, 'pending'))).toThrow();
  });

  it('rejects a non-boolean pending flag (type drift)', () => {
    expect(() => promotedQuoteSchema.parse({ ...FULL_QUOTE, pending: 'true' })).toThrow();
  });

  it('rejects a non-integer anchor_start (type drift)', () => {
    expect(() => promotedQuoteSchema.parse({ ...FULL_QUOTE, anchor_start: 'two' })).toThrow();
  });

  // #3655: a quote can be lifted from a Course chapter or a Resonance Letter,
  // and exactly the matching source id is set; the others are null.
  it('reads a Course quote: no entry, the chapter it came from', () => {
    const course = {
      ...FULL_QUOTE,
      source_kind: 'course',
      source_entry_id: null,
      source_content_id: 12,
    };
    expect(promotedQuoteSchema.parse(course)).toEqual(course);
  });

  it('reads a letter quote: no entry, the margin note whose letter it came from', () => {
    const letter = {
      ...FULL_QUOTE,
      source_kind: 'letter',
      source_entry_id: null,
      source_marginalia_id: 40,
    };
    expect(promotedQuoteSchema.parse(letter)).toEqual(letter);
  });

  it('reads a Course quote whose chapter was since pruned (no source id at all)', () => {
    const pruned = { ...FULL_QUOTE, source_kind: 'course', source_entry_id: null };
    expect(promotedQuoteSchema.parse(pruned).source_content_id).toBeNull();
  });

  it.each(['source_kind', 'source_content_id', 'source_marginalia_id'])(
    'rejects a quote missing %s',
    (key) => {
      expect(promotedQuoteSchema.safeParse(omitKey(FULL_QUOTE, key)).success).toBe(false);
    },
  );

  it('knows exactly the three source kinds the server names', () => {
    expect(promotedQuoteSourceKindSchema.options).toEqual(['entry', 'course', 'letter']);
    expect(promotedQuoteSchema.safeParse({ ...FULL_QUOTE, source_kind: 'video' }).success).toBe(
      false,
    );
  });
});

describe('promotedQuoteSummarySchema', () => {
  it('accepts a payload with no source_entry_id (the sources-feed shape)', () => {
    expect(() => promotedQuoteSummarySchema.parse(SUMMARY_QUOTE)).not.toThrow();
  });

  it('round-trips every field exactly', () => {
    const parsed = promotedQuoteSummarySchema.parse(SUMMARY_QUOTE);
    expect(parsed.id).toBe(55);
    expect(parsed.anchor_start).toBe(2);
    expect(parsed.anchor_end).toBe(19);
    expect(parsed.anchor_text).toBe('went for a run to');
    expect(parsed.pending).toBe(true);
  });

  it('rejects a missing anchor_text', () => {
    expect(() => promotedQuoteSummarySchema.parse(omitKey(SUMMARY_QUOTE, 'anchor_text'))).toThrow();
  });

  it('rejects a missing pending flag', () => {
    expect(() => promotedQuoteSummarySchema.parse(omitKey(SUMMARY_QUOTE, 'pending'))).toThrow();
  });

  // The summary component has no ``stale``: the cross-entry feed does not
  // compute anchor drift, so the field must not reach callers of this shape.
  it('does not carry stale through', () => {
    const parsed = promotedQuoteSummarySchema.parse({ ...SUMMARY_QUOTE, stale: true });
    expect('stale' in parsed).toBe(false);
  });

  // A summary rides under its own source entry, so it carries no source fields
  // of its own: the backend ``PromotedQuoteSummary`` declares none of them.
  it('carries none of the per-kind source fields', () => {
    const parsed = promotedQuoteSummarySchema.parse({ ...SUMMARY_QUOTE, ...FULL_QUOTE });
    expect(Object.keys(parsed).sort()).toEqual(
      ['anchor_end', 'anchor_start', 'anchor_text', 'id', 'pending'].sort(),
    );
  });
});

describe('promotedQuoteListItemSchema', () => {
  const LIST_ITEM = {
    ...FULL_QUOTE,
    source_title: null,
    source_timestamp: '2026-03-01T09:00:00Z',
    source_stage_number: null,
    letter_entry_id: null,
    included_in_entry_id: null,
    included_in_title: null,
    created_at: '2026-03-02T09:00:00Z',
  };

  it('accepts an untitled pending quote with null inclusion fields', () => {
    expect(promotedQuoteListItemSchema.parse(LIST_ITEM)).toEqual(LIST_ITEM);
  });

  it('reads where Open finds a Course quote and a letter quote', () => {
    const course = {
      ...LIST_ITEM,
      source_kind: 'course',
      source_entry_id: null,
      source_content_id: 12,
      source_title: 'Beige 1',
      source_stage_number: 1,
    };
    const letter = {
      ...LIST_ITEM,
      source_kind: 'letter',
      source_entry_id: null,
      source_marginalia_id: 40,
      source_title: 'Rain',
      letter_entry_id: 7,
    };
    expect(promotedQuoteListItemSchema.parse(course)).toEqual(course);
    expect(promotedQuoteListItemSchema.parse(letter)).toEqual(letter);
  });

  it.each([
    'source_timestamp',
    'created_at',
    'stale',
    'included_in_entry_id',
    'source_stage_number',
    'letter_entry_id',
  ])('rejects a list item missing %s', (key) => {
    expect(promotedQuoteListItemSchema.safeParse(omitKey(LIST_ITEM, key)).success).toBe(false);
  });

  it('requires total and has_more on the page envelope', () => {
    const page = { items: [LIST_ITEM], total: 1, has_more: false };
    expect(promotedQuoteListResponseSchema.parse(page)).toEqual(page);
    expect(promotedQuoteListResponseSchema.safeParse(omitKey(page, 'total')).success).toBe(false);
  });

  it('knows exactly the three status filters', () => {
    expect(promotionStatusFilterSchema.options).toEqual(['pending', 'included', 'all']);
  });
});

/**
 * ``readingQuoteItemSchema`` (#3657): a Course or letter quote waiting for a
 * review, carried on the sources feed beside -- never under -- its entries,
 * because neither kind has a feed row to nest under.
 */
describe('readingQuoteItemSchema', () => {
  const READING_QUOTE = {
    id: 81,
    source_kind: 'course',
    source_title: 'Beige 1',
    anchor_start: 4,
    anchor_end: 30,
    anchor_text: 'the body keeps the score',
    pending: true,
    created_at: '2026-03-03T10:00:00Z',
  };

  it('reads a Course quote and a letter quote', () => {
    const letter = { ...READING_QUOTE, id: 82, source_kind: 'letter', source_title: null };
    expect(readingQuoteItemSchema.parse(READING_QUOTE)).toEqual(READING_QUOTE);
    expect(readingQuoteItemSchema.parse(letter)).toEqual(letter);
  });

  it('refuses an entry quote, which rides under its own source row instead', () => {
    expect(
      readingQuoteItemSchema.safeParse({ ...READING_QUOTE, source_kind: 'entry' }).success,
    ).toBe(false);
  });

  it.each(['source_kind', 'anchor_text', 'pending', 'created_at'])(
    'rejects a reading quote missing %s',
    (key) => {
      expect(readingQuoteItemSchema.safeParse(omitKey(READING_QUOTE, key)).success).toBe(false);
    },
  );

  it('rides on the sources feed', () => {
    const feed = reflectionSourcesResponseSchema.parse({
      items: [],
      reading_quotes: [READING_QUOTE],
    });
    expect(feed.reading_quotes).toEqual([READING_QUOTE]);
  });

  it('reads as an empty list from a server that does not send it yet', () => {
    expect(reflectionSourcesResponseSchema.parse({ items: [] }).reading_quotes).toEqual([]);
  });
});
