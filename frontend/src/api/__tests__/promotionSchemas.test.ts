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
import { promotedQuoteSchema, promotedQuoteSummarySchema } from '../schemas';

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
});
