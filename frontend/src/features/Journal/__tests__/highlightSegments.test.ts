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
});
