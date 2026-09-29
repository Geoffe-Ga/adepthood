import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import HighlightedBody from '../HighlightedBody';
import { drawnNoteIds } from '../marginLayout';

import type { Marginalia, PromotedQuote } from '@/api';

// The margin decides which notes lead (sit beside a passage) by drawnNoteIds;
// the body decides which notes get a highlight run by rendering. When the two
// disagree, a note leads the margin with no passage to measure, and trails
// visually while leading the tree (#2418 review). They must agree exactly.

function note(id: number, start: number, end: number, status = 'active'): Marginalia {
  return {
    id,
    journal_entry_id: 1,
    kind: 'theme',
    anchor_start: start,
    anchor_end: end,
    anchor_text: 'x',
    note: 'n',
    essay: null,
    essay_generated_at: null,
    status: status as Marginalia['status'],
    created_at: '',
    updated_at: '',
  };
}

/** The note ids the rendered body gives a primary highlight run. */
function highlightedIds(body: string, notes: Marginalia[], quotes: PromotedQuote[]): number[] {
  const view = render(
    <HighlightedBody body={body} notes={notes} quotes={quotes} onOpen={jest.fn()} />,
  );
  return notes
    .map((n) => n.id)
    .filter((id) => view.queryByTestId(`highlight-${String(id)}`) !== null);
}

const CASES: Array<[string, string, Marginalia[]]> = [
  // A whitespace-only anchor on the blank line between two paragraphs.
  ['a blank line between paragraphs', 'alpha\n\nbeta', [note(1, 5, 7), note(2, 0, 5)]],
  ['several blank lines', 'a\n\n\n\nb', [note(1, 2, 4), note(2, 5, 6)]],
  ['one line feed', 'alpha\nbeta', [note(1, 5, 6), note(2, 6, 10)]],
  [
    'a quote block and a list',
    '> quoted line\n\n- first\n- second\n\nplain end.',
    [note(1, 2, 8), note(2, 13, 15), note(3, 17, 22), note(4, 34, 39)],
  ],
  ['hidden markdown only', 'a **b** c', [note(1, 2, 4), note(2, 7, 9, 'stale')]],
];

describe('drawnNoteIds agrees with what HighlightedBody draws', () => {
  it.each(CASES)('for %s', (_why, body, notes) => {
    expect([...drawnNoteIds(body, notes, [])].sort()).toEqual(highlightedIds(body, notes, []));
  });

  it('leaves a note on a blank line between paragraphs undrawn', () => {
    expect([...drawnNoteIds('alpha\n\nbeta', [note(1, 5, 7)], [])]).toEqual([]);
    expect([...drawnNoteIds('a\n\n\n\nb', [note(1, 2, 4)], [])]).toEqual([]);
  });
});
