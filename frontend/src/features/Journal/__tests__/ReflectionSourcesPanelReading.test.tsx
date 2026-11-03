// The Sources pane's "From your reading" group (#3659): Course and letter
// quotes promoted inside the review's window have no entry in the feed to ride
// with, so they wait under their own sub-label, each captioned with where it
// came from, and fold in through the same paths as an entry's quotes.
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import type { FoldCandidate } from '../quoteBatch';
import type { BatchFoldResult } from '../useReflectionMode';

import type { PromotedQuoteSummary, ReadingQuoteItem, ReflectionSourceItem } from '@/api';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;
const { SIDE_PANE_BREAKPOINT, READING_QUOTES_LABEL } = require('../ReflectionSourcesPanel') as {
  SIDE_PANE_BREAKPOINT: number;
  READING_QUOTES_LABEL: string;
};

function quote(id: number, text: string): PromotedQuoteSummary {
  return { id, anchor_start: 0, anchor_end: 4, anchor_text: text, pending: true };
}

const MONDAY: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Monday',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'first body',
  reflection_level: null,
  promoted_quotes: [quote(11, 'one')],
};

function reading(overrides: Partial<ReadingQuoteItem> = {}): ReadingQuoteItem {
  return {
    id: 71,
    source_kind: 'course',
    source_title: 'Beige 1',
    anchor_start: 3,
    anchor_end: 14,
    anchor_text: 'warm hearth',
    pending: true,
    created_at: '2026-06-02T08:00:00Z',
    ...overrides,
  };
}

const CHAPTER = reading();
const LETTER = reading({
  id: 72,
  source_kind: 'letter',
  source_title: 'Rain',
  anchor_text: 'be gentle',
});

type InsertMany = (_c: readonly FoldCandidate[]) => Promise<BatchFoldResult>;
type InsertReading = (_q: ReadingQuoteItem) => Promise<boolean>;

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
      items={[MONDAY]}
      readingQuotes={[CHAPTER, LETTER]}
      onInsertQuote={jest.fn()}
      onInsertReadingQuote={jest.fn<InsertReading>(() => Promise.resolve(true))}
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
  it('lists the reading quotes under their own label, after the entries’ quotes', () => {
    const { getByTestId, getAllByTestId } = renderPanel();

    const group = getByTestId('reading-quotes');
    expect(within(group).getByTestId('reading-quotes-label').props.children).toBe(
      'From your reading',
    );
    expect(READING_QUOTES_LABEL).toBe('From your reading');
    const order = getAllByTestId(/^(pending|reading)-quote-\d+$/).map((n) => n.props.testID);
    expect(order).toEqual(['pending-quote-11', 'reading-quote-71', 'reading-quote-72']);
  });

  it('captions each with where it came from, and names the row by it too', () => {
    const { getByTestId } = renderPanel();

    expect(getByTestId('reading-quote-71-caption').props.children).toBe('From “Beige 1”');
    expect(getByTestId('reading-quote-72-caption').props.children).toBe('From a letter · Rain');
    const row = getByTestId('reading-quote-71');
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe(
      'Fold the quote "warm hearth" into your reflection, From “Beige 1”',
    );
  });

  it('shows no group when the window holds no reading quotes, or only folded ones', () => {
    const none = renderPanel({ readingQuotes: [] });
    expect(none.queryByTestId('reading-quotes')).toBeNull();
    none.unmount();

    const used = renderPanel({ readingQuotes: [reading({ pending: false })] });
    expect(used.queryByTestId('reading-quotes')).toBeNull();
  });

  it('still offers the quotes band when only reading quotes wait', () => {
    const { getByText, getByTestId } = renderPanel({ items: [] });

    expect(getByText('Quotes to fold in')).toBeTruthy();
    expect(getByTestId('reading-quote-71')).toBeTruthy();
    expect(getByTestId('pending-quotes-select-toggle')).toBeTruthy();
  });

  it('folds one in on a tap, and dims it as folded once marked', async () => {
    const onInsertReadingQuote = jest.fn<InsertReading>(() => Promise.resolve(true));
    const { getByTestId } = renderPanel({ onInsertReadingQuote });

    await act(async () => {
      fireEvent.press(getByTestId('reading-quote-72'));
    });

    expect(onInsertReadingQuote).toHaveBeenCalledWith(LETTER);
    const row = getByTestId('reading-quote-72');
    expect(row.props.accessibilityState.disabled).toBe(true);
    expect(row.props.accessibilityLabel).toMatch(/ — already in your review$/);
    expect(getByTestId('reading-quote-72-check', { includeHiddenElements: true })).toBeTruthy();
  });

  it('undims a reading quote whose mark did not land', async () => {
    const onInsertReadingQuote = jest.fn<InsertReading>(() => Promise.resolve(false));
    const { getByTestId } = renderPanel({ onInsertReadingQuote });

    await act(async () => {
      fireEvent.press(getByTestId('reading-quote-71'));
    });

    expect(getByTestId('reading-quote-71').props.accessibilityState.disabled).toBe(false);
  });

  it('shows a quote the composer already folded as folded', () => {
    const { getByTestId } = renderPanel({ foldedIds: new Set([71]) });
    expect(getByTestId('reading-quote-71').props.accessibilityState.disabled).toBe(true);
  });

  it('checks reading quotes in selection mode and folds them after the entries’ quotes', async () => {
    const onInsertQuotes = allIncluded();
    const { getByTestId, getByLabelText } = renderPanel({ onInsertQuotes });
    fireEvent.press(getByLabelText('Select quotes'));
    expect(getByTestId('reading-quote-72').props.accessibilityRole).toBe('checkbox');
    fireEvent.press(getByTestId('reading-quote-72'));
    fireEvent.press(getByTestId('pending-quote-11'));
    fireEvent.press(getByTestId('reading-quote-71'));

    await act(async () => {
      fireEvent.press(getByTestId('quote-fold-action'));
    });

    expect(onInsertQuotes).toHaveBeenCalledWith([
      { id: 11, anchorText: 'one', attribution: 'Monday' },
      { id: 71, anchorText: 'warm hearth', attribution: 'From “Beige 1”' },
      { id: 72, anchorText: 'be gentle', attribution: 'From a letter' },
    ]);
  });

  it('takes the reading quotes into Select all', () => {
    const { getByTestId, getByLabelText } = renderPanel();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByLabelText('Select all'));

    expect(getByTestId('quote-fold-action').props.accessibilityLabel).toBe(
      'Fold 3 quotes into this review',
    );
  });

  it('drops a checked reading quote that leaves the feed from the selection', () => {
    const { getByTestId, getByLabelText, rerender } = renderPanel();
    fireEvent.press(getByLabelText('Select quotes'));
    fireEvent.press(getByTestId('reading-quote-71'));

    rerender(
      <ReflectionSourcesPanel
        items={[MONDAY]}
        readingQuotes={[LETTER]}
        onInsertQuote={jest.fn()}
        onInsertQuotes={allIncluded()}
        onClose={jest.fn()}
      />,
    );

    expect(getByTestId('quote-fold-action').props.accessibilityState.disabled).toBe(true);
  });
});
