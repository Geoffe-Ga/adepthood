// The batch fold-in's pure half (#2885): which blocks go into the body, where,
// and in what order. Every expected body is written out LITERALLY -- a test that
// recomputed it through spliceQuoteBlock would agree with any bug in it.
import { describe, it, expect } from '@jest/globals';

import {
  byPassageOrder,
  candidateFromListItem,
  candidateFromSource,
  planQuoteBatch,
  type FoldCandidate,
} from '../quoteBatch';
import { formatSourceDate, quoteAttribution, sourceAttribution } from '../reflectionCopy';

import type { PromotedQuoteListItem, PromotedQuoteSummary, ReflectionSourceItem } from '@/api';

const A: FoldCandidate = { id: 1, anchorText: 'first', attribution: 'Runs' };
const B: FoldCandidate = { id: 2, anchorText: 'second', attribution: 'Runs' };
const C: FoldCandidate = { id: 3, anchorText: 'third', attribution: 'Jun 2, 2026' };

const BLOCK_A = '> first\n> — Runs';
const BLOCK_B = '> second\n> — Runs';
const BLOCK_C = '> third\n> — Jun 2, 2026';

function sourceItem(overrides: Partial<ReflectionSourceItem> = {}): ReflectionSourceItem {
  return {
    kind: 'entry',
    id: 7,
    title: 'Runs',
    timestamp: '2026-06-15T12:00:00Z',
    body: 'went for a daily walk',
    reflection_level: null,
    promoted_quotes: [],
    ...overrides,
  };
}

function listItem(overrides: Partial<PromotedQuoteListItem> = {}): PromotedQuoteListItem {
  return {
    id: 11,
    source_entry_id: 7,
    anchor_start: 0,
    anchor_end: 4,
    anchor_text: 'went',
    pending: true,
    stale: false,
    created_at: '2026-06-20T00:00:00Z',
    source_title: 'Runs',
    source_timestamp: '2026-06-15T12:00:00Z',
    included_in_entry_id: null,
    included_in_title: null,
    ...overrides,
  };
}

describe('planQuoteBatch -- one splice for a whole selection (#2885)', () => {
  it('puts one quote at the start, one blank line before what follows', () => {
    expect(planQuoteBatch('Body.', [A], 0)).toEqual({
      text: '> first\n> — Runs\n\nBody.',
      nextCaret: 18,
      spliced: [1],
    });
  });

  it('puts three quotes in the middle, in the order given, one blank line apart', () => {
    const plan = planQuoteBatch('Before.\n\nAfter.', [A, B, C], 9);
    expect(plan.text).toBe(
      'Before.\n\n> first\n> — Runs\n\n> second\n> — Runs\n\n> third\n> — Jun 2, 2026\n\nAfter.',
    );
    expect(plan.spliced).toEqual([1, 2, 3]);
    expect(plan.text.slice(plan.nextCaret ?? 0)).toBe('After.');
  });

  it('pads a middle caret that sits right against the text on both sides', () => {
    expect(planQuoteBatch('AB', [A, B], 1).text).toBe(
      'A\n\n> first\n> — Runs\n\n> second\n> — Runs\n\nB',
    );
  });

  it('appends at the end, in order, when the caret is at the end', () => {
    expect(planQuoteBatch('Body.', [A, B], 5).text).toBe(
      'Body.\n\n> first\n> — Runs\n\n> second\n> — Runs\n\n',
    );
  });

  it('appends at the end, in order, when no caret was ever reported', () => {
    expect(planQuoteBatch('Body.', [A, B, C], null).text).toBe(
      'Body.\n\n> first\n> — Runs\n\n> second\n> — Runs\n\n> third\n> — Jun 2, 2026\n\n',
    );
  });

  it('skips a block the body already holds and splices the rest', () => {
    const body = `${BLOCK_B}\n\nMine.`;
    const plan = planQuoteBatch(body, [A, B, C], null);
    expect(plan.spliced).toEqual([1, 3]);
    expect(plan.text).toBe(`${BLOCK_B}\n\nMine.\n\n${BLOCK_A}\n\n${BLOCK_C}\n\n`);
  });

  it('writes two identical candidates once, naming only the first as spliced', () => {
    const twin: FoldCandidate = { ...A, id: 99 };
    const plan = planQuoteBatch('', [A, twin], null);
    expect(plan.text).toBe(`${BLOCK_A}\n\n`);
    expect(plan.spliced).toEqual([1]);
  });

  it('leaves the body and caret untouched when every block is already there', () => {
    const body = `${BLOCK_A}\n\n${BLOCK_B}`;
    expect(planQuoteBatch(body, [A, B], 3)).toEqual({ text: body, nextCaret: 3, spliced: [] });
  });

  it('plans nothing for an empty selection', () => {
    expect(planQuoteBatch('Body.', [], 2)).toEqual({ text: 'Body.', nextCaret: 2, spliced: [] });
  });
});

describe('candidate adapters -- one attribution whichever surface folds (#2885)', () => {
  it('builds a panel candidate from the quote and its source', () => {
    const quote: PromotedQuoteSummary = {
      id: 5,
      anchor_start: 0,
      anchor_end: 4,
      anchor_text: 'went',
      pending: true,
    };
    expect(candidateFromSource(quote, sourceItem())).toEqual({
      id: 5,
      anchorText: 'went',
      attribution: 'Runs',
    });
  });

  it.each([
    ['a titled source', 'Runs'],
    ['a whitespace-only title', '   '],
    ['an untitled source', null],
  ])('writes the same attribution from the screen as from the panel for %s', (_name, title) => {
    const fromScreen = candidateFromListItem(listItem({ source_title: title }));
    const fromPanel = sourceAttribution(sourceItem({ title }));
    expect(fromScreen.attribution).toBe(fromPanel);
  });

  it('dates an untitled source and trims a titled one', () => {
    expect(quoteAttribution({ title: '  Runs  ', timestamp: '2026-06-15T12:00:00Z' })).toBe('Runs');
    expect(quoteAttribution({ title: ' ', timestamp: '2026-06-15T12:00:00Z' })).toBe(
      formatSourceDate('2026-06-15T12:00:00Z'),
    );
  });
});

describe('byPassageOrder -- the screen folds in the order the panel would (#2885)', () => {
  it('orders by source date, then by where the passage sits, then by id', () => {
    const later = listItem({ id: 1, source_timestamp: '2026-06-16T00:00:00Z', anchor_start: 0 });
    const tail = listItem({ id: 2, anchor_start: 30, created_at: '2026-06-01T00:00:00Z' });
    const head = listItem({ id: 3, anchor_start: 5, created_at: '2026-06-30T00:00:00Z' });
    const twinLow = listItem({ id: 4, anchor_start: 40 });
    const twinHigh = listItem({ id: 5, anchor_start: 40 });
    const sorted = [later, twinHigh, tail, twinLow, head].sort(byPassageOrder);
    expect(sorted.map((row) => row.id)).toEqual([3, 2, 4, 5, 1]);
  });
});
