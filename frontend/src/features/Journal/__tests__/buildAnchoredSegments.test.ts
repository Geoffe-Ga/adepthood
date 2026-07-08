/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// RED: `buildAnchoredSegments` does not exist on `../highlightSegments` yet --
// this file fails with "Cannot find module" / "is not a function" until the
// implementation-specialist adds it (highlightSegments.ts becomes a thin
// wrapper around it; `buildHighlightSegments` stays byte-identical -- see
// highlightSegments.test.ts, which is untouched).
import { buildAnchoredSegments, buildHighlightSegments } from '../highlightSegments';

import type { Marginalia, PromotedQuote } from '@/api';

const BODY = 'I walked by the river and the willow bent.';

function note(overrides: Partial<Marginalia>): Marginalia {
  return {
    id: 1,
    journal_entry_id: 1,
    kind: 'theme',
    anchor_start: 0,
    anchor_end: 1,
    anchor_text: 'x',
    note: 'n',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function quote(overrides: Partial<PromotedQuote>): PromotedQuote {
  return {
    id: 100,
    source_entry_id: 1,
    anchor_start: 0,
    anchor_end: 1,
    anchor_text: 'x',
    pending: true,
    ...overrides,
  };
}

describe('buildAnchoredSegments', () => {
  it('returns the whole body as one plain segment when there are no notes or quotes', () => {
    const segments = buildAnchoredSegments(BODY, [], []);
    expect(segments).toEqual([{ start: 0, text: BODY, note: null, quote: null }]);
  });

  it('splits the body at a quote anchor boundary, tagging the segment with the quote', () => {
    const start = BODY.indexOf('the willow');
    const q = quote({ id: 55, anchor_start: start, anchor_end: start + 'the willow'.length });
    const segments = buildAnchoredSegments(BODY, [], [q]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ start: 0, text: BODY.slice(0, start), note: null, quote: null });
    expect(segments[1]).toMatchObject({ start, text: 'the willow', note: null });
    expect(segments[1]!.quote?.id).toBe(55);
    expect(segments[2]!.quote).toBeNull();
    expect(segments[2]!.note).toBeNull();
    expect(segments.map((s) => s.text).join('')).toBe(BODY);
  });

  it('merges a note and a quote at different anchors, sorted by anchor_start', () => {
    const noteStart = BODY.indexOf('river');
    const quoteStart = BODY.indexOf('willow');
    const n = note({ id: 1, anchor_start: noteStart, anchor_end: noteStart + 'river'.length });
    const q = quote({ id: 55, anchor_start: quoteStart, anchor_end: quoteStart + 'willow'.length });
    // Unsorted input (quote first) -- the builder must sort by anchor itself.
    const segments = buildAnchoredSegments(BODY, [n], [q]);

    const anchored = segments.filter((s) => s.note != null || s.quote != null);
    expect(anchored).toHaveLength(2);
    expect(anchored[0]!.note?.id).toBe(1);
    expect(anchored[1]!.quote?.id).toBe(55);
  });

  it('draws the note first when a note and a quote share the same anchor_start', () => {
    const start = BODY.indexOf('willow');
    const n = note({ id: 1, anchor_start: start, anchor_end: start + 3 }); // "wil"
    const q = quote({ id: 55, anchor_start: start, anchor_end: start + 6 }); // "willow"
    const segments = buildAnchoredSegments(BODY, [n], [q]);

    const anchored = segments.filter((s) => s.note != null || s.quote != null);
    // The note wins the tie; the overlapping quote is skipped by the same
    // first-wins cursor-skip rule `buildHighlightSegments` already uses.
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.note?.id).toBe(1);
  });

  it('keeps the earliest-starting anchor regardless of note vs quote', () => {
    const quoteStart = BODY.indexOf('the river');
    const noteStart = BODY.indexOf('river'); // overlaps and starts later
    const q = quote({ id: 55, anchor_start: quoteStart, anchor_end: quoteStart + 9 });
    const n = note({ id: 1, anchor_start: noteStart, anchor_end: noteStart + 20 });
    const segments = buildAnchoredSegments(BODY, [n], [q]);

    const anchored = segments.filter((s) => s.note != null || s.quote != null);
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.quote?.id).toBe(55);
    expect(anchored[0]!.note).toBeNull();
  });

  it('drops a quote that falls outside the body', () => {
    const q = quote({ id: 55, anchor_start: 100, anchor_end: 120 });
    const segments = buildAnchoredSegments(BODY, [], [q]);
    expect(segments.every((s) => s.quote == null)).toBe(true);
  });

  it('drops an empty quote anchor whose start equals its end', () => {
    const at = BODY.indexOf('willow');
    const q = quote({ id: 55, anchor_start: at, anchor_end: at });
    const segments = buildAnchoredSegments(BODY, [], [q]);
    expect(segments).toEqual([{ start: 0, text: BODY, note: null, quote: null }]);
  });

  it('includes a quote anchor that ends exactly at the end of the body', () => {
    const end = BODY.length;
    const tail = 'bent.';
    const q = quote({ id: 55, anchor_start: end - tail.length, anchor_end: end });
    const segments = buildAnchoredSegments(BODY, [], [q]);
    const last = segments[segments.length - 1]!;
    expect(last.quote?.id).toBe(55);
    expect(last.text).toBe(tail);
  });

  it('still filters a stale note out of the merged anchored stream', () => {
    const start = BODY.indexOf('the willow');
    const stale = note({
      id: 8,
      anchor_start: start,
      anchor_end: start + 'the willow'.length,
      status: 'stale',
    });
    const segments = buildAnchoredSegments(BODY, [stale], []);
    expect(segments.every((s) => s.note == null)).toBe(true);
  });

  it('is a strict superset of buildHighlightSegments when there are no quotes', () => {
    const start = BODY.indexOf('the willow');
    const n = note({ id: 7, anchor_start: start, anchor_end: start + 'the willow'.length });
    const legacy = buildHighlightSegments(BODY, [n]);
    const anchored = buildAnchoredSegments(BODY, [n], []);
    expect(anchored).toEqual(legacy.map((s) => ({ ...s, quote: null })));
  });
});
