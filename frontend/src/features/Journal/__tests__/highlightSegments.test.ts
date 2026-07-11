/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { buildHighlightSegments } from '../highlightSegments';

import type { Marginalia } from '@/api';

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

describe('buildHighlightSegments', () => {
  it('returns the whole body as one plain segment when there are no notes', () => {
    const segments = buildHighlightSegments(BODY, []);
    expect(segments).toEqual([{ start: 0, text: BODY, note: null }]);
  });

  it('splits the body at anchor boundaries', () => {
    const start = BODY.indexOf('the willow');
    const n = note({ id: 7, anchor_start: start, anchor_end: start + 'the willow'.length });
    const segments = buildHighlightSegments(BODY, [n]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ start: 0, text: BODY.slice(0, start), note: null });
    expect(segments[1]).toMatchObject({ start, text: 'the willow' });
    expect(segments[1]!.note?.id).toBe(7);
    expect(segments[2]!.note).toBeNull();
    // Reassembling the segments reproduces the body exactly.
    expect(segments.map((s) => s.text).join('')).toBe(BODY);
  });

  it('handles an anchor at the very start (no leading plain segment)', () => {
    const n = note({ id: 2, anchor_start: 0, anchor_end: 8 }); // "I walked"
    const segments = buildHighlightSegments(BODY, [n]);
    expect(segments[0]!.note?.id).toBe(2);
    expect(segments[0]!.text).toBe('I walked');
  });

  it('keeps the earliest of two overlapping anchors, deterministically', () => {
    const a = note({ id: 1, anchor_start: 2, anchor_end: 10 });
    const b = note({ id: 2, anchor_start: 5, anchor_end: 15 }); // overlaps a
    const segments = buildHighlightSegments(BODY, [b, a]); // unsorted input
    const highlighted = segments.filter((s) => s.note != null);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.note?.id).toBe(1); // earliest start wins
  });

  it('drops anchors that fall outside the body', () => {
    const n = note({ id: 9, anchor_start: 100, anchor_end: 120 });
    const segments = buildHighlightSegments(BODY, [n]);
    expect(segments.every((s) => s.note == null)).toBe(true);
  });

  it('does not draw stale anchors inline', () => {
    const start = BODY.indexOf('the willow');
    const stale = note({
      id: 8,
      anchor_start: start,
      anchor_end: start + 'the willow'.length,
      status: 'stale',
    });
    const segments = buildHighlightSegments(BODY, [stale]);
    expect(segments.every((s) => s.note == null)).toBe(true);
  });

  it('drops an anchor whose start is negative', () => {
    const n = note({ id: 10, anchor_start: -1, anchor_end: 4 });
    const segments = buildHighlightSegments(BODY, [n]);
    expect(segments).toEqual([{ start: 0, text: BODY, note: null }]);
  });

  it('drops an empty anchor whose start equals its end', () => {
    const at = BODY.indexOf('willow');
    const n = note({ id: 11, anchor_start: at, anchor_end: at });
    const segments = buildHighlightSegments(BODY, [n]);
    expect(segments).toEqual([{ start: 0, text: BODY, note: null }]);
  });

  it('includes an anchor that ends exactly at the end of the body', () => {
    const end = BODY.length;
    const tail = 'bent.';
    const n = note({ id: 12, anchor_start: end - tail.length, anchor_end: end });
    const segments = buildHighlightSegments(BODY, [n]);
    const last = segments[segments.length - 1]!;
    expect(last.note?.id).toBe(12);
    expect(last.text).toBe(tail);
  });

  it('returns a single plain segment for an empty body', () => {
    const segments = buildHighlightSegments('', []);
    expect(segments).toEqual([{ start: 0, text: '', note: null }]);
  });
});

// True when a slice cut a non-BMP (astral) character in half, leaving a lone surrogate.
const UNPAIRED_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const UNPAIRED_LOW_SURROGATE = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasUnpairedSurrogate(text: string): boolean {
  return UNPAIRED_HIGH_SURROGATE.test(text) || UNPAIRED_LOW_SURROGATE.test(text);
}

// RED: anchors are code points, but slice() indexes UTF-16 code units, so a leading emoji drifts them.
describe('buildHighlightSegments -- non-BMP (astral) code-point anchors (marginalia)', () => {
  const EMOJI = '\u{1F600}';
  const LEADING_EMOJI_BODY = `${EMOJI}went for a daily walk.`;

  it('slices the exact anchored phrase after a leading emoji using code-point offsets', () => {
    const start = 1; // code-point index right after the emoji, at "w"
    const end = 17; // code-point index right after "went for a daily"
    const n = note({ id: 7, anchor_start: start, anchor_end: end });
    const segments = buildHighlightSegments(LEADING_EMOJI_BODY, [n]);
    const anchored = segments.find((s) => s.note?.id === 7);
    expect(anchored?.text).toBe('went for a daily');
  });

  it('renders an anchor whose end equals the code-point length of an emoji-final body', () => {
    const tailBody = `went for a walk${EMOJI}`;
    const start = 11; // code-point index of "w" in "walk"
    const end = 16; // the body's code-point length, including the trailing emoji
    const n = note({ id: 8, anchor_start: start, anchor_end: end });
    const segments = buildHighlightSegments(tailBody, [n]);
    const anchored = segments.find((s) => s.note?.id === 8);
    expect(anchored).toBeDefined();
    expect(anchored?.text).toBe(`walk${EMOJI}`);
  });

  it('never produces a segment with a lone/unpaired surrogate', () => {
    const tailBody = `went for a walk${EMOJI}`;
    const n = note({ id: 8, anchor_start: 11, anchor_end: 16 });
    const segments = buildHighlightSegments(tailBody, [n]);
    for (const segment of segments) {
      expect(hasUnpairedSurrogate(segment.text)).toBe(false);
    }
  });
});
