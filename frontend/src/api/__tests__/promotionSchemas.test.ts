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
  promotedQuoteSourceKindSchema,
  promotedQuoteListResponseSchema,
  promotedQuoteSchema,
  promotedQuoteSummarySchema,
  promotionStatusFilterSchema,
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

  it.each(['source_timestamp', 'created_at', 'stale', 'included_in_entry_id'])(
    'rejects a list item missing %s',
    (key) => {
      expect(promotedQuoteListItemSchema.safeParse(omitKey(LIST_ITEM, key)).success).toBe(false);
    },
  );

  it('requires total and has_more on the page envelope', () => {
    const page = { items: [LIST_ITEM], total: 1, has_more: false };
    expect(promotedQuoteListResponseSchema.parse(page)).toEqual(page);
    expect(promotedQuoteListResponseSchema.safeParse(omitKey(page, 'total')).success).toBe(false);
  });

  it('knows exactly the three status filters', () => {
    expect(promotionStatusFilterSchema.options).toEqual(['pending', 'included', 'all']);
  });
});

describe('a quote lifted from the reading (#3659)', () => {
  const COURSE_ITEM = {
    ...FULL_QUOTE,
    source_kind: 'course',
    source_entry_id: null,
    source_content_id: 31,
    source_title: 'Beige 1',
    source_timestamp: '2026-03-01T09:00:00Z',
    source_stage_number: 1,
    letter_entry_id: null,
    included_in_entry_id: null,
    included_in_title: null,
    created_at: '2026-03-02T09:00:00Z',
  };

  it('knows exactly the three places a quote can come from', () => {
    expect(promotedQuoteSourceKindSchema.options).toEqual(['entry', 'course', 'letter']);
  });

  it('round-trips a Course quote with its chapter and stage', () => {
    expect(promotedQuoteListItemSchema.parse(COURSE_ITEM)).toEqual(COURSE_ITEM);
  });

  it('round-trips a letter quote with the entry its note sits on', () => {
    const letter = {
      ...COURSE_ITEM,
      source_kind: 'letter',
      source_content_id: null,
      source_marginalia_id: 9,
      source_stage_number: null,
      letter_entry_id: 44,
    };
    expect(promotedQuoteListItemSchema.parse(letter)).toEqual(letter);
  });

  it('keeps a pruned chapter quote, whose content id the server nulled', () => {
    const pruned = { ...COURSE_ITEM, source_content_id: null, source_stage_number: null };
    expect(promotedQuoteListItemSchema.parse(pruned).source_content_id).toBeNull();
  });

  it.each(['source_kind', 'source_content_id', 'source_marginalia_id'])(
    'rejects a quote missing %s',
    (key) => {
      expect(promotedQuoteSchema.safeParse(omitKey(FULL_QUOTE, key)).success).toBe(false);
    },
  );

  it.each(['source_stage_number', 'letter_entry_id'])('rejects a list item missing %s', (key) => {
    expect(promotedQuoteListItemSchema.safeParse(omitKey(COURSE_ITEM, key)).success).toBe(false);
  });

  it('rejects a kind the client has never heard of', () => {
    expect(promotedQuoteSchema.safeParse({ ...FULL_QUOTE, source_kind: 'video' }).success).toBe(
      false,
    );
  });

  it('keeps the provenance fields off the sources-feed summary, which the server never sends', () => {
    const parsed = promotedQuoteSummarySchema.parse({ ...SUMMARY_QUOTE, source_kind: 'entry' });
    expect('source_kind' in parsed).toBe(false);
  });
});
