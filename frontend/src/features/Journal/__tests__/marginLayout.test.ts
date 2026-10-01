import { describe, expect, it } from '@jest/globals';

import { computeMarginSlots } from '../computeMarginSlots';
import {
  assignMarginSlots,
  buildMarginItems,
  drawnNoteIds,
  type MarginItem,
} from '../marginLayout';

import type { CompletionSuggestion, Marginalia, PromotedQuote } from '@/api';
import { journalLayout } from '@/design/tokens';

const BODY = 'I walked by the river and the river walked by me.';
const GAP = journalLayout.marginNoteGap;
const NOTE_HEIGHT = 40;

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 1,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 2,
    anchor_end: 8,
    anchor_text: 'walked',
    note: 'A note.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function suggestion(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return {
    id: 90,
    journal_entry_id: 7,
    target_type: 'habit',
    goal_id: 3,
    user_practice_id: null,
    label: 'Walk',
    anchor_start: 0,
    anchor_end: 1,
    anchor_text: 'I',
    completed_units: null,
    completed_on: null,
    logged_on: null,
    status: 'pending',
    accepted_at: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 300,
    source_entry_id: 7,
    anchor_start: 16,
    anchor_end: 21,
    anchor_text: 'river',
    pending: false,
    stale: false,
    ...overrides,
  };
}

const keys = (items: readonly MarginItem[]): string[] => items.map((item) => item.key);
const byKey = (a: MarginItem, b: MarginItem): number => a.key.localeCompare(b.key);

const SEED = 2418;
const PROPERTY_RUNS = 2000;
const MAX_NOTES = 8;
const MAX_OFFERS = 3;
const MAX_TOP = 1500;
const MAX_HEIGHT = 200;
/** The share of drawn notes whose passage goes unmeasured in a random column. */
const MISSING_ANCHOR_RATE = 0.2;

/** A small deterministic PRNG (mulberry32), so a failing case replays exactly. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random drawn notes and offers, some anchors missing, some above the stream. */
function randomColumn(random: () => number) {
  const count = 1 + Math.floor(random() * MAX_NOTES);
  const notes = Array.from({ length: count }, (_, index) =>
    note({ id: index + 1, anchor_start: Math.floor(random() * BODY.length) }),
  );
  const offers = Array.from({ length: Math.floor(random() * MAX_OFFERS) }, (_, index) =>
    suggestion({ id: 100 + index }),
  );
  const items = buildMarginItems(notes, offers, new Set(notes.map((n) => n.id)));
  const anchors = new Map<number, number>();
  for (const n of notes) {
    if (random() >= MISSING_ANCHOR_RATE) anchors.set(n.id, random() * MAX_TOP - MAX_HEIGHT);
  }
  const heights = new Map(items.map((item) => [item.key, 1 + random() * MAX_HEIGHT]));
  return { items, anchors, heights };
}

describe('drawnNoteIds', () => {
  it('keeps exactly the notes whose highlight the body draws', () => {
    const drawn = note({ id: 1 });
    const stale = note({ id: 2, anchor_start: 9, anchor_end: 11, status: 'stale' });
    const outOfRange = note({ id: 3, anchor_start: 40, anchor_end: 400 });
    // Starts inside the live quote on "river" (16-21), so first-wins skips it.
    const overlapped = note({ id: 4, anchor_start: 18, anchor_end: 23 });

    const ids = drawnNoteIds(BODY, [drawn, stale, outOfRange, overlapped], [quote()]);

    expect([...ids]).toEqual([1]);
  });
});

describe('buildMarginItems', () => {
  it('leads with drawn notes by anchor, then trails undrawn rows by creation time', () => {
    const late = note({ id: 5, anchor_start: 30, anchor_end: 35 });
    const early = note({ id: 6, anchor_start: 2, anchor_end: 8 });
    const tiedLow = note({ id: 7, anchor_start: 30, anchor_end: 34 });
    const stale = note({ id: 8, status: 'stale', created_at: '2026-06-03T00:00:00Z' });
    const olderOffer = suggestion({ id: 91, created_at: '2026-06-02T00:00:00Z' });
    const newerOffer = suggestion({ id: 92, created_at: '2026-06-04T00:00:00Z' });
    const dismissed = suggestion({ id: 93, status: 'dismissed' });

    const items = buildMarginItems(
      [tiedLow, stale, early, late],
      [newerOffer, dismissed, olderOffer],
      new Set([5, 6, 7]),
    );

    expect(keys(items)).toEqual([
      'note-6',
      'note-5',
      'note-7',
      'suggestion-91',
      'note-8',
      'suggestion-92',
    ]);
    expect(items.map((item) => item.anchored)).toEqual([true, true, true, false, false, false]);
  });

  it('breaks a creation-time tie note-first, then by id, and sends unparseable times last', () => {
    const at = '2026-06-02T00:00:00Z';
    const items = buildMarginItems(
      [note({ id: 9, status: 'stale', created_at: 'not a time' }), note({ id: 4, created_at: at })],
      [suggestion({ id: 95, created_at: at }), suggestion({ id: 94, created_at: at })],
      new Set<number>(),
    );

    expect(keys(items)).toEqual(['note-4', 'suggestion-94', 'suggestion-95', 'note-9']);
  });
});

describe('assignMarginSlots', () => {
  const noteItems = (ids: number[]): MarginItem[] =>
    buildMarginItems(
      ids.map((id) => note({ id, anchor_start: id, anchor_end: id + 1 })),
      [],
      new Set(ids),
    );
  const heightsFor = (items: readonly MarginItem[], height = NOTE_HEIGHT) =>
    new Map(items.map((item) => [item.key, height]));

  it('pushes a colliding note down by exactly the margin gap, in document order', () => {
    const items = noteItems([1, 2]);

    const slots = assignMarginSlots(
      items,
      new Map([
        [1, 100],
        [2, 110],
      ]),
      heightsFor(items),
      GAP,
    );

    expect(slots?.tops).toEqual([100, 100 + NOTE_HEIGHT + GAP]);
    expect(slots?.tops).toEqual(computeMarginSlots([100, 110], [NOTE_HEIGHT, NOTE_HEIGHT], GAP));
  });

  it('trails a non-finite anchor while the finite ones keep their tops', () => {
    const items = noteItems([1, 2, 3]);

    const slots = assignMarginSlots(
      items,
      new Map([
        [1, 50],
        [2, Number.NaN],
        [3, 300],
      ]),
      heightsFor(items),
      GAP,
    );

    // Note 2 has no passage to sit beside, so it moves to the tail -- in the
    // rendered order as well as on screen, so the two can never disagree.
    expect(slots?.items.map((item) => item.key)).toEqual(['note-1', 'note-3', 'note-2']);
    expect(slots?.tops).toEqual([50, 300, 300 + NOTE_HEIGHT + GAP]);
  });

  it('merges a note that lost its passage into the tail by creation time', () => {
    const items = buildMarginItems(
      [note({ id: 1, anchor_start: 2 }), note({ id: 2, created_at: '2026-06-03T00:00:00Z' })],
      [
        suggestion({ id: 90, created_at: '2026-06-02T00:00:00Z' }),
        suggestion({ id: 91, created_at: '2026-06-04T00:00:00Z' }),
      ],
      new Set([1, 2]),
    );

    const slots = assignMarginSlots(items, new Map([[1, 0]]), heightsFor(items), GAP);

    expect(slots?.items.map((item) => item.key)).toEqual([
      'note-1',
      'suggestion-90',
      'note-2',
      'suggestion-91',
    ]);
  });

  it('treats an infinite anchor and an unanchored item as trailing', () => {
    const items = [
      ...noteItems([1, 2]),
      ...buildMarginItems([], [suggestion({ id: 90 })], new Set<number>()),
    ];

    const slots = assignMarginSlots(
      items,
      new Map([
        [1, 20],
        [2, Number.POSITIVE_INFINITY],
      ]),
      heightsFor(items),
      GAP,
    );

    const tail = 20 + NOTE_HEIGHT + GAP;
    expect(slots?.tops).toEqual([20, tail, tail + NOTE_HEIGHT + GAP]);
  });

  it('never lifts a note above the stream, where the banners above it live', () => {
    // Note 1's passage sits above the stream's top (a banner pushed the stream
    // down past it): it lands at the top instead, and note 2 clears it.
    const items = noteItems([1, 2]);

    const slots = assignMarginSlots(
      items,
      new Map([
        [1, -80],
        [2, 10],
      ]),
      heightsFor(items),
      GAP,
    );

    expect(slots?.tops).toEqual([0, NOTE_HEIGHT + GAP]);
  });

  it('keeps the flow layout until every slot has a finite height', () => {
    const items = noteItems([1, 2]);
    const anchors = new Map([
      [1, 10],
      [2, 200],
    ]);

    expect(assignMarginSlots(items, anchors, new Map([['note-1', NOTE_HEIGHT]]), GAP)).toBeNull();
    expect(
      assignMarginSlots(
        items,
        anchors,
        new Map([
          ['note-1', NOTE_HEIGHT],
          ['note-2', Number.NaN],
        ]),
        GAP,
      ),
    ).toBeNull();
  });

  it('keeps the flow layout when no anchored note has a finite top', () => {
    const items = noteItems([1, 2]);

    expect(assignMarginSlots(items, new Map([[1, Number.NaN]]), heightsFor(items), GAP)).toBeNull();
    expect(assignMarginSlots([], new Map(), new Map(), GAP)).toBeNull();
  });

  it('reports the extent as the lowest bottom edge', () => {
    const items = noteItems([1, 2, 3]);

    const slots = assignMarginSlots(
      items,
      new Map([
        [1, 50],
        [2, Number.NaN],
        [3, 300],
      ]),
      heightsFor(items),
      GAP,
    );

    const trailingTop = 300 + NOTE_HEIGHT + GAP;
    expect(slots?.extent).toBe(trailingTop + NOTE_HEIGHT);
  });

  it('keeps tops non-decreasing in rendered order, whatever anchors are missing', () => {
    const random = seededRandom(SEED);
    for (let run = 0; run < PROPERTY_RUNS; run += 1) {
      const { items, anchors, heights } = randomColumn(random);
      const slots = assignMarginSlots(items, anchors, heights, GAP);
      if (slots === null) continue;
      expect([...slots.items].sort(byKey)).toEqual([...items].sort(byKey));
      slots.tops.forEach((top, index) => {
        if (index === 0) return;
        const previous = slots.items[index - 1]!;
        // Tree order is screen order: each slot starts at or below the bottom
        // of the one rendered before it, plus the gap.
        expect(top).toBeGreaterThanOrEqual(
          slots.tops[index - 1]! + heights.get(previous.key)! + GAP,
        );
      });
    }
  });
});
