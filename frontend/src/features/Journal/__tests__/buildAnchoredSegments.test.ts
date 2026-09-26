/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

// Segments the body against a merged note + promoted-quote anchor stream.
import { buildAnchoredSegments, partitionQuotes } from '../highlightSegments';

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

/**
 * A promoted quote over ``body`` (BODY unless given). Its ``anchor_text`` is the
 * code-point slice its offsets address, as the server snapshots it, so a quote
 * is only "out of place" when a test says so.
 */
function quote(overrides: Partial<PromotedQuote>, body: string = BODY): PromotedQuote {
  const start = overrides.anchor_start ?? 0;
  const end = overrides.anchor_end ?? 1;
  return {
    id: 100,
    source_entry_id: 1,
    anchor_start: start,
    anchor_end: end,
    anchor_text: Array.from(body).slice(start, end).join(''),
    pending: true,
    stale: false,
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
    // The note wins the tie; the overlapping quote is skipped by the anchored path's own first-wins cursor-skip rule.
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

  it('carries quote:null on every segment when there are no quotes', () => {
    const start = BODY.indexOf('the willow');
    const n = note({ id: 7, anchor_start: start, anchor_end: start + 'the willow'.length });
    const segments = buildAnchoredSegments(BODY, [n], []);
    expect(segments.every((s) => s.quote === null)).toBe(true);
    const anchored = segments.find((s) => s.note?.id === 7);
    expect(anchored?.text).toBe('the willow');
  });
});

// True when a slice cut a non-BMP (astral) character in half, leaving a lone surrogate.
const UNPAIRED_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const UNPAIRED_LOW_SURROGATE = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasUnpairedSurrogate(text: string): boolean {
  return UNPAIRED_HIGH_SURROGATE.test(text) || UNPAIRED_LOW_SURROGATE.test(text);
}

// Anchors are code points; slicing here must not drift or split a non-BMP character.
describe('buildAnchoredSegments -- non-BMP (astral) code-point anchors', () => {
  const EMOJI = '\u{1F600}';
  // Code points: 0=emoji, 1..16="went for a daily" (16 chars), 17=' ', 18.."walk."
  const LEADING_EMOJI_BODY = `${EMOJI}went for a daily walk.`;

  it('slices the exact anchored phrase after a leading emoji using code-point offsets', () => {
    const start = 1; // code-point index right after the emoji, at "w"
    const end = 17; // code-point index right after "went for a daily"
    const q = quote({ id: 55, anchor_start: start, anchor_end: end }, LEADING_EMOJI_BODY);
    const segments = buildAnchoredSegments(LEADING_EMOJI_BODY, [], [q]);
    const anchored = segments.find((s) => s.quote?.id === 55);
    expect(anchored?.text).toBe('went for a daily');
  });

  it('renders an anchor whose end equals the code-point length of an emoji-final body', () => {
    // Code points: 0.."went for a walk" (15 chars), 15=emoji; length=16.
    const tailBody = `went for a walk${EMOJI}`;
    const start = 11; // code-point index of "w" in "walk"
    const end = 16; // the body's code-point length, including the trailing emoji
    const q = quote({ id: 77, anchor_start: start, anchor_end: end }, tailBody);
    const segments = buildAnchoredSegments(tailBody, [], [q]);
    const anchored = segments.find((s) => s.quote?.id === 77);
    expect(anchored).toBeDefined();
    expect(anchored?.text).toBe(`walk${EMOJI}`);
  });

  it('never produces a segment with a lone/unpaired surrogate', () => {
    const tailBody = `went for a walk${EMOJI}`;
    const q = quote({ id: 77, anchor_start: 11, anchor_end: 16 }, tailBody);
    const segments = buildAnchoredSegments(tailBody, [], [q]);
    for (const segment of segments) {
      expect(hasUnpairedSurrogate(segment.text)).toBe(false);
    }
  });
});

describe('stale promoted quotes (#2891)', () => {
  const HELLO = 'hello world';

  it('does not draw a stale promoted quote inline at its pre-edit offsets', () => {
    const staleQuote = quote({
      id: 1,
      anchor_start: 0,
      anchor_end: 5,
      anchor_text: 'hello',
      pending: true,
      stale: true,
    });
    const segs = buildAnchoredSegments(HELLO, [], [staleQuote]);
    expect(segs.every((s) => s.quote === null)).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe(HELLO);
  });

  it('still draws a live quote beside a stale one', () => {
    const staleQuote = quote({ id: 1, anchor_start: 0, anchor_end: 5, stale: true }, HELLO);
    const live = quote({ id: 2, anchor_start: 6, anchor_end: 11 }, HELLO);
    const segs = buildAnchoredSegments(HELLO, [], [staleQuote, live]);
    const quoted = segs.filter((s) => s.quote != null);
    expect(quoted).toHaveLength(1);
    expect(quoted[0]!.quote!.id).toBe(2);
    expect(quoted[0]!.text).toBe('world');
  });

  it('partitions quotes into live and detached, preserving order', () => {
    const a = quote({ id: 1, stale: false });
    const b = quote({ id: 2, stale: true });
    const c = quote({ id: 3, stale: false });
    const d = quote({ id: 4, stale: true });
    const { live, detached } = partitionQuotes([a, b, c, d], BODY);
    expect(live.map((q) => q.id)).toEqual([1, 3]);
    expect(detached.map((q) => q.id)).toEqual([2, 4]);
  });
});

describe('quotes whose offsets no longer spell their text (#2891)', () => {
  const BEFORE = 'the river ran';
  const AFTER = 'Now: the river ran';

  it('never draws an included quote whose frozen offsets now address other text', () => {
    // The server re-anchors only PENDING quotes on an edit; an included one
    // keeps its offsets, which after an insertion address different words.
    const included = quote({ id: 5, anchor_start: 0, anchor_end: 9, anchor_text: 'the river' });
    const frozen = { ...included, pending: false };
    expect(Array.from(BEFORE).slice(0, 9).join('')).toBe('the river');
    const segs = buildAnchoredSegments(AFTER, [], [frozen]);
    expect(segs.every((s) => s.quote === null)).toBe(true);
    expect(partitionQuotes([frozen], AFTER).detached.map((q) => q.id)).toEqual([5]);
  });

  it('still draws a quote whose slice equals its text apart from edge whitespace', () => {
    // A quote promoted before selections were trimmed stores "river " offsets
    // with the server-trimmed text "river".
    const legacy = quote({ id: 6, anchor_start: 4, anchor_end: 10, anchor_text: 'river' });
    const segs = buildAnchoredSegments(BEFORE, [], [legacy]);
    expect(segs.find((s) => s.quote?.id === 6)?.text).toBe('river ');
  });

  it('detaches a quote whose offsets fall outside the body instead of dropping it', () => {
    const outOfRange = quote({ id: 7, anchor_start: 40, anchor_end: 45, anchor_text: 'gone.' });
    expect(partitionQuotes([outOfRange], BEFORE).detached.map((q) => q.id)).toEqual([7]);
  });

  it('compares in code points, so an astral character before the anchor does not detach it', () => {
    const body = '\u{1F30A} the river';
    const live = quote({ id: 8, anchor_start: 2, anchor_end: 11, anchor_text: 'the river' });
    expect(partitionQuotes([live], body).live.map((q) => q.id)).toEqual([8]);
  });
});
