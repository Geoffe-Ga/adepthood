import { describe, expect, it } from '@jest/globals';

import { resolveFocusSpan } from '../highlightSegments';

import type { PromotedQuote } from '@/api';

const BODY = 'I walked by the river and the willow bent.';

function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 9,
    source_entry_id: 1,
    anchor_start: 16,
    anchor_end: 21,
    anchor_text: 'river',
    pending: true,
    stale: false,
    ...overrides,
  };
}

describe('resolveFocusSpan', () => {
  it('names the live quote whose anchors are exactly the span', () => {
    expect(resolveFocusSpan(BODY, { start: 16, end: 21 }, [quote()])).toEqual({
      start: 16,
      end: 21,
      quoteId: 9,
    });
  });

  it('is null with no span, so an ordinary open is untouched', () => {
    expect(resolveFocusSpan(BODY, undefined, [quote()])).toBeNull();
  });

  it('is null until a quote with those exact anchors has loaded', () => {
    expect(resolveFocusSpan(BODY, { start: 16, end: 21 }, [])).toBeNull();
    expect(resolveFocusSpan(BODY, { start: 16, end: 20 }, [quote()])).toBeNull();
  });

  it('is null for a stale quote, whose passage was edited away', () => {
    expect(resolveFocusSpan(BODY, { start: 16, end: 21 }, [quote({ stale: true })])).toBeNull();
  });

  it('is null for a quote whose offsets no longer spell its text (detached, not stale)', () => {
    // A folded quote is not re-anchored on an edit, so it can sit un-stale over
    // other words. The body draws it apart from the text, never inline, so the
    // page must not scroll to (or underline) the words that now sit there.
    const drifted = quote({ anchor_text: 'willow' });
    expect(resolveFocusSpan(BODY, { start: 16, end: 21 }, [drifted])).toBeNull();
  });

  it('accepts an end exactly at the body length and refuses one past it', () => {
    const length = Array.from(BODY).length;
    const atEnd = quote({
      anchor_start: length - 5,
      anchor_end: length,
      anchor_text: Array.from(BODY)
        .slice(length - 5)
        .join(''),
    });
    const pastEnd = quote({ anchor_start: length - 4, anchor_end: length + 1 });
    expect(resolveFocusSpan(BODY, { start: length - 5, end: length }, [atEnd])).not.toBeNull();
    expect(resolveFocusSpan(BODY, { start: length - 4, end: length + 1 }, [pastEnd])).toBeNull();
  });

  it('refuses an empty, inverted or negative span', () => {
    const empty = quote({ anchor_start: 3, anchor_end: 3 });
    const inverted = quote({ anchor_start: 5, anchor_end: 3 });
    const negative = quote({ anchor_start: -1, anchor_end: 3 });
    expect(resolveFocusSpan(BODY, { start: 3, end: 3 }, [empty])).toBeNull();
    expect(resolveFocusSpan(BODY, { start: 5, end: 3 }, [inverted])).toBeNull();
    expect(resolveFocusSpan(BODY, { start: -1, end: 3 }, [negative])).toBeNull();
  });

  it('measures the body in code points, so an astral character counts once', () => {
    // Two code points, three UTF-16 units: an end of 2 is in range, 3 is not.
    const body = '🌧a';
    const whole = quote({ anchor_start: 0, anchor_end: 2, anchor_text: body });
    const beyond = quote({ anchor_start: 0, anchor_end: 3 });
    expect(resolveFocusSpan(body, { start: 0, end: 2 }, [whole])).not.toBeNull();
    expect(resolveFocusSpan(body, { start: 0, end: 3 }, [beyond])).toBeNull();
  });
});
