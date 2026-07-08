/* eslint-env jest */
// RED: `ReflectionSourcesPanel` does not exist yet -- `require(...)` throws
// until the implementation-specialist adds it.
//
// Assumed prop/callback contract (implementer: match this exactly):
//   interface ReflectionSourcesPanelProps {
//     items: ReflectionSourceItem[];
//     onInsertQuote: (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem) => void;
//     onClose?: () => void;
//   }
// Rendering rules pinned below: pending promoted quotes render as a distinct
// group above the chronological (oldest -> newest) entry/reflection list;
// `kind: 'reflection'` rows get testID `reflection-source-<id>` and show their
// `reflection_level`; `kind: 'entry'` rows get testID `entry-source-<id>`.
// Each row is collapsed to an excerpt until tapped, which reveals
// testID `source-body-<id>` with the full body. A pending quote is testID
// `pending-quote-<id>`; tapping it fires `onInsertQuote` and marks the quote
// included (dimmed / `accessibilityState.disabled`) without removing it.
// Layout is responsive on `useWindowDimensions().width`: < 600 wraps the
// panel in a bottom-sheet `Modal` (testID `reflection-sources-sheet`); >= 600
// renders an inline side pane (testID `reflection-sources-pane`).
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PromotedQuoteSummary, ReflectionSourceItem } from '@/api';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;

function quote(overrides: Partial<PromotedQuoteSummary> = {}): PromotedQuoteSummary {
  return {
    id: 1,
    anchor_start: 0,
    anchor_end: 10,
    anchor_text: 'a steady walk',
    pending: true,
    ...overrides,
  };
}

function item(overrides: Partial<ReflectionSourceItem> = {}): ReflectionSourceItem {
  return {
    kind: 'entry',
    id: 1,
    title: 'Entry title',
    timestamp: '2026-06-01T00:00:00Z',
    body: 'The full body of the entry, longer than any excerpt.',
    reflection_level: null,
    promoted_quotes: [],
    ...overrides,
  };
}

describe('ReflectionSourcesPanel -- pending quotes', () => {
  it('renders pending promoted quotes at the top, ahead of the chronological feed', () => {
    const items = [
      item({
        id: 1,
        timestamp: '2026-06-05T00:00:00Z',
        promoted_quotes: [quote({ id: 90, pending: true })],
      }),
    ];
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    expect(getByTestId('pending-quote-90')).toBeTruthy();
  });

  it('fires onInsertQuote with the quote and its source item when tapped', () => {
    const onInsertQuote = jest.fn();
    const sourceItem = item({
      id: 1,
      timestamp: '2026-06-05T00:00:00Z',
      promoted_quotes: [quote({ id: 90, pending: true })],
    });
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={onInsertQuote} />,
    );
    fireEvent.press(getByTestId('pending-quote-90'));
    expect(onInsertQuote).toHaveBeenCalledWith(sourceItem.promoted_quotes[0], sourceItem);
  });

  it('marks a tapped quote included (dimmed) without removing it from view', () => {
    const sourceItem = item({
      id: 1,
      promoted_quotes: [quote({ id: 90, pending: true })],
    });
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={jest.fn()} />,
    );
    fireEvent.press(getByTestId('pending-quote-90'));
    const quoteNode = getByTestId('pending-quote-90');
    expect(quoteNode).toBeTruthy();
    expect(quoteNode.props.accessibilityState?.disabled).toBe(true);
  });
});

describe('ReflectionSourcesPanel -- chronological feed', () => {
  it('renders entry and reflection rows oldest to newest', () => {
    const items = [
      item({ kind: 'entry', id: 3, timestamp: '2026-06-15T00:00:00Z' }),
      item({ kind: 'entry', id: 1, timestamp: '2026-06-01T00:00:00Z' }),
      item({
        kind: 'reflection',
        id: 2,
        reflection_level: 'week',
        timestamp: '2026-06-08T00:00:00Z',
      }),
    ];
    const { getAllByTestId } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    const rowIds = getAllByTestId(/^(entry|reflection)-source-\d+$/).map(
      (node) => node.props.testID as string,
    );
    expect(rowIds).toEqual(['entry-source-1', 'reflection-source-2', 'entry-source-3']);
  });

  it('visually distinguishes a reflection row and shows its level label', () => {
    const items = [item({ kind: 'reflection', id: 2, reflection_level: 'week' })];
    const { getByTestId, getByText } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    expect(getByTestId('reflection-source-2')).toBeTruthy();
    expect(getByText(/week/i)).toBeTruthy();
  });

  it('expands a row to reveal its full body on tap', () => {
    const items = [item({ id: 5, body: 'A very particular sentence about the river.' })];
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    expect(queryByTestId('source-body-5')).toBeNull();
    fireEvent.press(getByTestId('entry-source-5'));
    expect(getByTestId('source-body-5').props.children).toContain(
      'A very particular sentence about the river.',
    );
  });
});

describe('ReflectionSourcesPanel -- responsive layout', () => {
  it('renders as a bottom-sheet Modal on a narrow viewport', () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
    try {
      const { getByTestId, queryByTestId } = render(
        <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} />,
      );
      expect(getByTestId('reflection-sources-sheet')).toBeTruthy();
      expect(queryByTestId('reflection-sources-pane')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('renders as an inline side pane on a wide viewport', () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 1280, height: 900, scale: 1, fontScale: 1 });
    try {
      const { getByTestId, queryByTestId } = render(
        <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} />,
      );
      expect(getByTestId('reflection-sources-pane')).toBeTruthy();
      expect(queryByTestId('reflection-sources-sheet')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
