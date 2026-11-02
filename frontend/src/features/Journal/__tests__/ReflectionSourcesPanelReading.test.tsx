// #3659: a Course or letter quote waiting for this review has no feed row to
// ride under, so the panel gathers them in one "From your reading" group --
// the same QuoteRow, the same heading face, absent when there are none -- and a
// tap folds one in through the composer's own path.
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { FoldCandidate } from '../quoteBatch';
import type { BatchFoldResult } from '../useReflectionMode';

import type { PromotedQuoteSummary, ReadingQuoteItem, ReflectionSourceItem } from '@/api';
import { editorialType, ink } from '@/design/tokens';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;
const { SIDE_PANE_BREAKPOINT } = require('../ReflectionSourcesPanel') as {
  SIDE_PANE_BREAKPOINT: number;
};

const ENTRY_QUOTE: PromotedQuoteSummary = {
  id: 11,
  anchor_start: 0,
  anchor_end: 4,
  anchor_text: 'one',
  pending: true,
};

const SOURCE: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Monday',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'first body',
  reflection_level: null,
  promoted_quotes: [ENTRY_QUOTE],
};

const COURSE: ReadingQuoteItem = {
  id: 81,
  source_kind: 'course',
  source_title: 'Beige 1',
  anchor_start: 4,
  anchor_end: 28,
  anchor_text: 'the body keeps the score',
  pending: true,
  created_at: '2026-06-03T10:00:00Z',
};

const LETTER: ReadingQuoteItem = {
  id: 82,
  source_kind: 'letter',
  source_title: 'Monday',
  anchor_start: 0,
  anchor_end: 23,
  anchor_text: 'you are allowed to rest',
  pending: true,
  created_at: '2026-06-02T10:00:00Z',
};

type InsertMany = (_c: readonly FoldCandidate[]) => Promise<BatchFoldResult>;

function allIncluded(): jest.Mock<InsertMany> {
  return jest.fn<InsertMany>((candidates) =>
    Promise.resolve({ included: candidates.map((c) => c.id), failed: [], gone: [], skipped: [] }),
  );
}

function renderPanel(props: Record<string, unknown> = {}): ReturnType<typeof render> {
  const rn = require('react-native');
  jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width: SIDE_PANE_BREAKPOINT, height: 900, scale: 1, fontScale: 1 });
  return render(
    <ReflectionSourcesPanel
      items={[SOURCE]}
      readingQuotes={[COURSE, LETTER]}
      onInsertQuote={jest.fn()}
      onInsertReadingQuote={jest.fn(() => Promise.resolve(true))}
      onInsertQuotes={allIncluded()}
      onClose={jest.fn()}
      {...props}
    />,
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ReflectionSourcesPanel -- From your reading (#3659)', () => {
  it('lists reading quotes under their own heading, oldest first, each saying where it came from', () => {
    const { getByTestId, getByText } = renderPanel();

    const group = getByTestId('reading-quotes');
    within(group).getByText('From your reading');
    const rows = within(group)
      .getAllByTestId(/^reading-quote-\d+$/)
      .map((row) => row.props.testID);
    expect(rows).toEqual(['reading-quote-82', 'reading-quote-81']);
    expect(getByTestId('reading-quote-81-caption').props.children).toBe('From “Beige 1”');
    expect(getByTestId('reading-quote-82-caption').props.children).toBe('From a letter · Monday');
    // Its name carries what it does and every word of its caption.
    expect(getByTestId('reading-quote-81').props.accessibilityLabel).toBe(
      'Fold the quote "the body keeps the score" into your reflection, from “Beige 1”',
    );
    // The entry quotes keep their own group, above.
    expect(getByText('Quotes to fold in')).toBeTruthy();
  });

  it("wears the same heading face as the panel's other group", () => {
    const { getByText } = renderPanel();
    for (const label of ['Quotes to fold in', 'From your reading']) {
      const style = StyleSheet.flatten(getByText(label).props.style);
      expect(style.textTransform).toBe('uppercase');
      expect(style.fontSize).toBe(editorialType.caption.fontSize);
      expect(style.color).toBe(ink.muted);
    }
  });

  it('is absent when there is nothing from your reading, or only quotes already used', () => {
    const none = renderPanel({ readingQuotes: [] });
    expect(none.queryByText('From your reading')).toBeNull();
    none.unmount();

    const used = renderPanel({ readingQuotes: [{ ...COURSE, pending: false }] });
    expect(used.queryByText('From your reading')).toBeNull();
  });

  it('folds a tapped reading quote in through the composer, and shows it folded', async () => {
    const onInsertReadingQuote = jest.fn(() => Promise.resolve(true));
    const { getByTestId } = renderPanel({ onInsertReadingQuote });

    await act(async () => {
      fireEvent.press(getByTestId('reading-quote-81'));
    });

    expect(onInsertReadingQuote).toHaveBeenCalledWith(COURSE);
    const folded = getByTestId('reading-quote-81');
    expect(folded.props.accessibilityState).toEqual({ disabled: true });
    expect(folded.props.accessibilityLabel).toMatch(/— already in your review$/);
  });

  it('undims a reading quote whose fold did not take', async () => {
    const { getByTestId } = renderPanel({
      onInsertReadingQuote: jest.fn(() => Promise.resolve(false)),
    });

    await act(async () => {
      fireEvent.press(getByTestId('reading-quote-81'));
    });

    expect(getByTestId('reading-quote-81').props.accessibilityState).toEqual({ disabled: false });
  });

  it('shows a reading quote the composer already folded, by any route, as folded', () => {
    const { getByTestId } = renderPanel({ foldedIds: new Set([82]) });
    expect(getByTestId('reading-quote-82').props.accessibilityState).toEqual({ disabled: true });
  });

  it('checks reading quotes with the rest, and folds the selection in the order shown', async () => {
    const onInsertQuotes = allIncluded();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });

    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByLabelText('Select all'));
    expect(getByTestId('reading-quote-81').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 3 quotes into this review',
    );
    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });

    expect(onInsertQuotes).toHaveBeenCalledWith([
      { id: 11, anchorText: 'one', attribution: 'Monday' },
      { id: 82, anchorText: 'you are allowed to rest', attribution: 'From a letter' },
      { id: 81, anchorText: 'the body keeps the score', attribution: 'From “Beige 1”' },
    ]);
  });

  it('offers selection under the reading group when no entry quote is waiting', () => {
    const { getByTestId, queryByText } = renderPanel({
      items: [{ ...SOURCE, promoted_quotes: [] }],
    });

    expect(queryByText('Quotes to fold in')).toBeNull();
    expect(within(getByTestId('reading-quotes')).getByLabelText('Select quotes')).toBeTruthy();
  });
});
