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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

// RED: `onPromoteSpan` prop and `source-promote-<kind>-<id>` don't exist yet.
describe('ReflectionSourcesPanel -- in-panel re-promotion opener', () => {
  it('shows the promote opener only on an expanded row when onPromoteSpan is provided', () => {
    const items = [item({ id: 1 })];
    const withPromote = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} onPromoteSpan={jest.fn()} />,
    );
    fireEvent.press(withPromote.getByTestId('entry-source-1'));
    expect(withPromote.getByTestId('source-promote-entry-1')).toBeTruthy();

    const withoutPromote = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    fireEvent.press(withoutPromote.getByTestId('entry-source-1'));
    expect(withoutPromote.queryByTestId('source-promote-entry-1')).toBeNull();
  });
});

describe('ReflectionSourcesPanel -- in-panel re-promotion selection surface', () => {
  it('confirming a selected span calls onPromoteSpan with the source item and offsets', async () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(true));
    const sourceItem = item({ id: 1 });
    const { getByTestId } = render(
      <ReflectionSourcesPanel
        items={[sourceItem]}
        onInsertQuote={jest.fn()}
        onPromoteSpan={onPromoteSpan}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    fireEvent.press(getByTestId('source-promote-entry-1'));
    const input = getByTestId('source-select-entry-1-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 9 } } });
    await act(async () => {
      fireEvent.press(getByTestId('source-select-entry-1-confirm'));
    });
    expect(onPromoteSpan).toHaveBeenCalledWith(sourceItem, { anchor_start: 2, anchor_end: 9 });
  });

  it('does not fire onPromoteSpan on a collapsed selection and stays on the selection surface', async () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(true));
    const items = [item({ id: 1 })];
    const { getByTestId } = render(
      <ReflectionSourcesPanel
        items={items}
        onInsertQuote={jest.fn()}
        onPromoteSpan={onPromoteSpan}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    fireEvent.press(getByTestId('source-promote-entry-1'));
    const input = getByTestId('source-select-entry-1-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    await act(async () => {
      fireEvent.press(getByTestId('source-select-entry-1-confirm'));
    });
    expect(onPromoteSpan).not.toHaveBeenCalled();
    expect(getByTestId('source-select-entry-1-input')).toBeTruthy();
  });

  it('cancel restores the plain body without firing onPromoteSpan', () => {
    const onPromoteSpan = jest.fn();
    const items = [item({ id: 1, body: 'A river-bank sentence to reread.' })];
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel
        items={items}
        onInsertQuote={jest.fn()}
        onPromoteSpan={onPromoteSpan}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    fireEvent.press(getByTestId('source-promote-entry-1'));
    fireEvent.press(getByTestId('source-select-entry-1-cancel'));
    expect(queryByTestId('source-select-entry-1-input')).toBeNull();
    expect(getByTestId('source-body-1').props.children).toContain(
      'A river-bank sentence to reread.',
    );
    expect(onPromoteSpan).not.toHaveBeenCalled();
  });

  it('shows a declinable hint when onPromoteSpan resolves false, and the opener stays usable', async () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(false));
    const items = [item({ id: 1 })];
    const { getByTestId, findByTestId } = render(
      <ReflectionSourcesPanel
        items={items}
        onInsertQuote={jest.fn()}
        onPromoteSpan={onPromoteSpan}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    fireEvent.press(getByTestId('source-promote-entry-1'));
    const input = getByTestId('source-select-entry-1-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 9 } } });
    await act(async () => {
      fireEvent.press(getByTestId('source-select-entry-1-confirm'));
    });
    expect(await findByTestId('source-promote-hint')).toBeTruthy();
    expect(getByTestId('source-promote-entry-1')).toBeTruthy();
  });
});

// RED: `onInsertQuote`'s Promise<boolean> result is not yet reconciled with the dim.
describe('ReflectionSourcesPanel -- dim reconciles with a failed fold-in', () => {
  it('reverts the dim when onInsertQuote resolves false, and a second press re-fires it', async () => {
    const onInsertQuote = jest.fn(() => Promise.resolve(false));
    const sourceItem = item({ id: 1, promoted_quotes: [quote({ id: 90, pending: true })] });
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={onInsertQuote} />,
    );
    fireEvent.press(getByTestId('pending-quote-90'));
    await waitFor(() => {
      expect(getByTestId('pending-quote-90').props.accessibilityState?.disabled).toBeFalsy();
    });
    fireEvent.press(getByTestId('pending-quote-90'));
    expect(onInsertQuote).toHaveBeenCalledTimes(2);
  });

  it('keeps the dim when onInsertQuote resolves true', async () => {
    const onInsertQuote = jest.fn(() => Promise.resolve(true));
    const sourceItem = item({ id: 1, promoted_quotes: [quote({ id: 90, pending: true })] });
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={onInsertQuote} />,
    );
    fireEvent.press(getByTestId('pending-quote-90'));
    await waitFor(() => expect(onInsertQuote).toHaveBeenCalledTimes(1));
    expect(getByTestId('pending-quote-90').props.accessibilityState?.disabled).toBe(true);
  });

  it('reverts the dim when onInsertQuote rejects', async () => {
    const onInsertQuote = jest.fn(() => Promise.reject(new Error('fold-in failed')));
    const sourceItem = item({ id: 1, promoted_quotes: [quote({ id: 90, pending: true })] });
    const { getByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={onInsertQuote} />,
    );
    fireEvent.press(getByTestId('pending-quote-90'));
    await waitFor(() => {
      expect(getByTestId('pending-quote-90').props.accessibilityState?.disabled).toBeFalsy();
    });
  });
});
