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
  source_entry_id: 7,
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
