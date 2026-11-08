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
// Layout is responsive on `useWindowDimensions().width`, and a `Modal` at every
// width: below `CENTRED_MODAL_BREAKPOINT` a bottom sheet (testID
// `reflection-sources-sheet`); from it up a centred card (testID
// `reflection-sources-modal`, #3133).
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { Modal, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import type { PromotedQuoteSummary, ReflectionSourceItem } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { colors, editorialType, ink, journalLayout, touchTarget } from '@/design/tokens';

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

  // #2885 moved the folded state off ``selected``: a folded row reads as
  // disabled and says so in its name, and ``checked`` belongs to selection.
  it('shows a check glyph and reads as already folded once a quote is folded in (#2952)', () => {
    const sourceItem = item({
      id: 1,
      promoted_quotes: [quote({ id: 90, pending: true })],
    });
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={[sourceItem]} onInsertQuote={jest.fn()} />,
    );
    const hidden = { includeHiddenElements: true };
    expect(queryByTestId('pending-quote-90-check', hidden)).toBeNull();
    expect(getByTestId('pending-quote-90').props.accessibilityLabel).not.toMatch(/already/);
    fireEvent.press(getByTestId('pending-quote-90'));
    expect(getByTestId('pending-quote-90-check', hidden)).toBeTruthy();
    const folded = getByTestId('pending-quote-90');
    expect(folded.props.accessibilityState).toEqual({ disabled: true });
    expect(folded.props.accessibilityLabel).toMatch(/— already in your review$/);
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

  // The panel labels a SOURCE row, not an invitation, and its naive
  // capitalisation reads correctly for both new levels — so it is deliberately
  // left alone by #2866 rather than taught the invitation's title table. The
  // assertion is here so the choice is a decision and not an oversight.
  it.each([
    ['section', 'Section reflection'],
    ['course', 'Course reflection'],
  ])('labels a %s source row "%s"', (level, expected) => {
    const items = [item({ kind: 'reflection', id: 7, reflection_level: level })];
    const { getByText } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    expect(getByText(expected)).toBeTruthy();
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
      expect(queryByTestId('reflection-sources-modal')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('renders as a centred Modal card on a wide viewport', () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 1280, height: 900, scale: 1, fontScale: 1 });
    try {
      const { getByTestId, queryByTestId } = render(
        <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} />,
      );
      expect(getByTestId('reflection-sources-modal')).toBeTruthy();
      expect(queryByTestId('reflection-sources-sheet')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // #2883: the heading (title, period, X) is the panel's navigation. It sits
  // above the scroll so browsing a long feed can never carry the way out away.
  it('keeps the Sources heading and close control fixed outside the scrolling feed (narrow sheet and wide modal)', () => {
    const rn = require('react-native');
    const items = [1, 2, 3, 4, 5].map((id) => item({ id, timestamp: `2026-06-0${id}T00:00:00Z` }));
    for (const width of [390, 1280]) {
      const spy = jest
        .spyOn(rn, 'useWindowDimensions')
        .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
      try {
        const { getByTestId } = render(
          <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} onClose={jest.fn()} />,
        );
        const scroll = getByTestId('reflection-sources-scroll');
        expect(within(scroll).queryByTestId('reflection-sources-close')).toBeNull();
        expect(within(scroll).queryByTestId('reflection-sources-heading')).toBeNull();
        expect(within(scroll).getByTestId('entry-source-5')).toBeTruthy();
        const frame = getByTestId(
          width < 600 ? 'reflection-sources-sheet' : 'reflection-sources-modal',
        );
        expect(within(frame).getByTestId('reflection-sources-close')).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
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
      fireEvent.press(getByTestId('promote-selection-fab'));
    });
    // "e full " ends in a space; the server would trim it from anchor_text but
    // keep the offsets, so the span is trimmed to match before it is posted (#2891).
    expect(onPromoteSpan).toHaveBeenCalledWith(sourceItem, { anchor_start: 2, anchor_end: 8 });
  });

  it('a collapsed selection raises no floating Promote and never calls onPromoteSpan', () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(true));
    const items = [item({ id: 1 })];
    const { getByTestId, queryByTestId } = render(
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
    expect(queryByTestId('promote-selection-fab', { includeHiddenElements: true })).toBeNull();
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
      fireEvent.press(getByTestId('promote-selection-fab'));
    });
    expect(await findByTestId('source-promote-hint')).toBeTruthy();
    expect(getByTestId('source-promote-entry-1')).toBeTruthy();
  });
});

// RED: anchors are code points, but the shared surface's TextInput reports UTF-16 offsets.
describe('ReflectionSourcesPanel -- in-panel re-promotion code-point anchors (non-BMP)', () => {
  const EMOJI = '\u{1F600}';
  const EMOJI_BODY = `${EMOJI}went for a daily walk.`;

  it('converts a UTF-16 selection over an emoji-led body to code-point anchor offsets', async () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(true));
    const sourceItem = item({ id: 1, body: EMOJI_BODY });
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
    // The one leading astral char shifts every later UTF-16 offset by +1 vs its code-point index.
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 18 } } });
    await act(async () => {
      fireEvent.press(getByTestId('promote-selection-fab'));
    });
    expect(onPromoteSpan).toHaveBeenCalledWith(sourceItem, { anchor_start: 1, anchor_end: 17 });
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

describe('ReflectionSourcesPanel -- the two empty feeds', () => {
  it('says nothing was written when the period is known and simply held no entries', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel
        items={[]}
        onInsertQuote={jest.fn()}
        window={{ start: '2026-06-01T04:00:00Z', end: '2026-06-08T04:00:00Z' }}
        anchorStatus="recorded"
        feedStatus="ready"
      />,
    );
    expect(getByTestId('reflection-sources-empty').props.children).toMatch(/Nothing was written/i);
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
  });

  it('falls back to the plain empty copy when the server named no anchor status', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={[]} onInsertQuote={jest.fn()} />,
    );
    expect(getByTestId('reflection-sources-empty').props.children).toMatch(/Nothing was written/i);
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
  });

  it('says it can’t tell which dates were covered when that cycle lost its anchor', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel
        items={[]}
        onInsertQuote={jest.fn()}
        anchorStatus="unrecorded"
        feedStatus="ready"
      />,
    );
    const copy = getByTestId('reflection-sources-unrecorded').props.children;
    expect(copy).toMatch(/can’t tell which dates/i);
    // Warm and specific: it must say the writing itself is safe, and it must not
    // pretend the period was simply empty.
    expect(copy).toMatch(/still in your journal/i);
    expect(queryByTestId('reflection-sources-empty')).toBeNull();
  });

  it('does not claim the period was empty while the feed is still loading', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={[]} onInsertQuote={jest.fn()} feedStatus="loading" />,
    );
    expect(queryByTestId('reflection-sources-empty')).toBeNull();
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
    expect(getByTestId('reflection-sources-loading')).toBeTruthy();
  });

  it('does not claim the period was empty when the feed FAILED to load', () => {
    // Offline, a 500, or a 403: none of them is evidence about what was
    // written. Saying "nothing was written" here is a lie the reader cannot
    // check.
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={[]} onInsertQuote={jest.fn()} feedStatus="failed" />,
    );
    const copy = getByTestId('reflection-sources-unavailable').props.children;
    expect(copy).toMatch(/could(n.t| not) be loaded|didn.t load/i);
    expect(queryByTestId('reflection-sources-empty')).toBeNull();
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
  });

  it('prefers the failure over the anchor status, which is unknown when nothing arrived', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel
        items={[]}
        onInsertQuote={jest.fn()}
        feedStatus="failed"
        anchorStatus="unrecorded"
      />,
    );
    expect(getByTestId('reflection-sources-unavailable')).toBeTruthy();
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
  });

  it('shows no empty copy at all once the feed has something in it', () => {
    const { queryByTestId } = render(
      <ReflectionSourcesPanel
        items={[item({ id: 3 })]}
        onInsertQuote={jest.fn()}
        anchorStatus="unrecorded"
      />,
    );
    expect(queryByTestId('reflection-sources-empty')).toBeNull();
    expect(queryByTestId('reflection-sources-unrecorded')).toBeNull();
  });
});

describe('ReflectionSourcesPanel -- the review period', () => {
  const window = { start: '2026-06-01T04:00:00Z', end: '2026-06-08T04:00:00Z' };

  it('shows the review period beside a Sources heading', () => {
    const { getByText, getByTestId } = render(
      <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} window={window} />,
    );
    const heading = getByText('Sources');
    expect(heading.props.accessibilityRole).toBe('header');
    expect(getByTestId('reflection-sources-period').props.children).toMatch(/Jun 1.*Jun 7, 2026/);
  });

  it('shows the period in both the narrow sheet and the wide pane', () => {
    const rn = require('react-native');
    for (const width of [400, 1280]) {
      const spy = jest
        .spyOn(rn, 'useWindowDimensions')
        .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
      try {
        const { getByTestId } = render(
          <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} window={window} />,
        );
        expect(getByTestId('reflection-sources-period')).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('reads the period from the server window, never from the scope key', () => {
    const first = render(
      <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} window={window} />,
    );
    const firstLabel = first.getByTestId('reflection-sources-period').props.children;
    const second = render(
      <ReflectionSourcesPanel
        items={[item()]}
        onInsertQuote={jest.fn()}
        window={{ start: '2026-09-07T04:00:00Z', end: '2026-09-14T04:00:00Z' }}
      />,
    );
    expect(second.getByTestId('reflection-sources-period').props.children).not.toEqual(firstLabel);
    expect(second.getByTestId('reflection-sources-period').props.children).toMatch(
      /Sep 7.*Sep 13, 2026/,
    );
  });

  it('renders the feed with no period label when the server declared no window', () => {
    const { getByTestId, queryByTestId } = render(
      <ReflectionSourcesPanel items={[item({ id: 7 })]} onInsertQuote={jest.fn()} />,
    );
    expect(getByTestId('entry-source-7')).toBeTruthy();
    expect(queryByTestId('reflection-sources-period')).toBeNull();
  });

  it('names a clamped past-cycle period correctly, because both bounds are midnights', () => {
    // A cycle abandoned mid-week: the server clamped the end to the LOCAL
    // midnight of the loop day (2026-06-04), so the label must read through
    // Jun 3. A raw-instant clamp would have handed over a mid-morning bound and
    // the HALF_DAY_MS step back would name the wrong final day.
    const { getByTestId } = render(
      <ReflectionSourcesPanel
        items={[item()]}
        onInsertQuote={jest.fn()}
        window={{ start: '2026-06-01T00:00:00Z', end: '2026-06-04T00:00:00Z' }}
        timeZone="UTC"
        anchorStatus="recorded"
      />,
    );
    expect(getByTestId('reflection-sources-period').props.children).toMatch(/Jun 1.*Jun 3, 2026/);
  });

  it("keeps a source's date visible even when it has a title", () => {
    const { getByText, getByTestId } = render(
      <ReflectionSourcesPanel
        items={[item({ id: 4, title: 'Entry title', timestamp: '2026-06-01T12:00:00Z' })]}
        onInsertQuote={jest.fn()}
      />,
    );
    expect(getByText('Entry title')).toBeTruthy();
    expect(getByTestId('source-date-4').props.children).toMatch(/Jun 1, 2026/);
  });
});

describe('ReflectionSourcesPanel -- source bodies are rendered, never raw Markdown', () => {
  // A Creek chat transcript: the corpus stores speaker prefixes as bold.
  const CHAT_BODY =
    '**Me:** Idk if I told you but I am leaving today\n**Jonathon:** is it travel anxiety? i get that';

  it('strips the ** speaker markers from the collapsed excerpt', () => {
    const { getByText, queryByText } = render(
      <ReflectionSourcesPanel
        items={[item({ id: 1, body: CHAT_BODY })]}
        onInsertQuote={jest.fn()}
      />,
    );
    expect(getByText(/^Me: Idk if I told you/)).toBeTruthy();
    expect(queryByText(/\*\*/)).toBeNull();
  });

  it('renders the speaker label bold in the expanded body and shows no marker characters', () => {
    const { getByTestId, queryByText, queryByTestId } = render(
      <ReflectionSourcesPanel
        items={[item({ id: 1, body: CHAT_BODY })]}
        onInsertQuote={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    const bold = getByTestId('journal-markdown-bold-2');
    expect(bold.props.children).toBe('Me:');
    expect(StyleSheet.flatten(bold.props.style).fontWeight).toBe('700');
    expect(queryByText(/\*\*/)).toBeNull();
    expect(getByTestId('source-body-1')).toBeTruthy();
    // The reader's own body container must not be duplicated inside the sheet.
    expect(queryByTestId('journal-body-read')).toBeNull();
  });

  it('keeps promote offsets computed against the RAW body', async () => {
    const onPromoteSpan = jest.fn(() => Promise.resolve(true));
    const sourceItem = item({ id: 1, body: CHAT_BODY });
    const { getByTestId } = render(
      <ReflectionSourcesPanel
        items={[sourceItem]}
        onInsertQuote={jest.fn()}
        onPromoteSpan={onPromoteSpan}
      />,
    );
    fireEvent.press(getByTestId('entry-source-1'));
    fireEvent.press(getByTestId('source-promote-entry-1'));
    // The surface edits the raw string, markers and all, so it must hold them.
    expect(getByTestId('source-select-entry-1-input').props.value).toBe(CHAT_BODY);
    fireEvent(getByTestId('source-select-entry-1-input'), 'selectionChange', {
      nativeEvent: { selection: { start: 2, end: 9 } },
    });
    await act(async () => {
      fireEvent.press(getByTestId('promote-selection-fab'));
    });
    // UTF-16 2..9 of the RAW body is 'Me:** I' -- offsets never shift for display.
    expect(onPromoteSpan).toHaveBeenCalledWith(sourceItem, { anchor_start: 2, anchor_end: 9 });
    expect(CHAT_BODY.slice(2, 9)).toBe('Me:** I');
  });

  it('closes with an icon-only X whose accessible name is Done, and no visible Done text', () => {
    const { getByTestId, queryByText } = render(
      <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} onClose={jest.fn()} />,
    );
    const close = getByTestId('reflection-sources-close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('Done');
    // The X is hidden by the one helper, never by a DOM-invalid `accessible` (#2829).
    expect(within(close).UNSAFE_getByType(X).props).toMatchObject(decorativeHidden());
    expect(queryByText('Done')).toBeNull();
    const style = StyleSheet.flatten(close.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(style.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('renders no close control at all when onClose is not given (wide pane callers)', () => {
    const { queryByTestId, getByText } = render(
      <ReflectionSourcesPanel items={[item()]} onInsertQuote={jest.fn()} />,
    );
    expect(queryByTestId('reflection-sources-close')).toBeNull();
    expect(getByText('Sources').props.accessibilityRole).toBe('header');
  });

  it('puts the X in the heading row beside the Sources header, with the period still beneath the title', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ReflectionSourcesPanel
        items={[item()]}
        onInsertQuote={jest.fn()}
        onClose={onClose}
        window={{ start: '2026-06-01T04:00:00Z', end: '2026-06-08T04:00:00Z' }}
      />,
    );
    const heading = getByTestId('reflection-sources-heading');
    expect(within(heading).getByText('Sources').props.accessibilityRole).toBe('header');
    expect(within(heading).getByTestId('reflection-sources-period').props.children).toMatch(
      /Jun 1.*Jun 7, 2026/,
    );
    fireEvent.press(within(heading).getByTestId('reflection-sources-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ReflectionSourcesPanel -- one eyebrow face', () => {
  it('sets the group heading and the reflection level label in the same upper-cased caption', () => {
    const items = [
      item({
        kind: 'reflection',
        id: 2,
        reflection_level: 'week',
        promoted_quotes: [quote({ id: 90, pending: true })],
      }),
    ];
    const { getByText } = render(
      <ReflectionSourcesPanel items={items} onInsertQuote={jest.fn()} />,
    );
    for (const label of ['Quotes to fold in', 'Week reflection']) {
      const style = StyleSheet.flatten(getByText(label).props.style);
      expect(style.textTransform).toBe('uppercase');
      expect(style.fontSize).toBe(editorialType.caption.fontSize);
      expect(style.color).toBe(ink.muted);
    }
  });
});

// #2883 / #3133: below the breakpoint the panel is a bounded sheet as wide as
// the page; from it up, a card centred over the desk. Both are Modals that a
// backdrop tap, Escape, back or the X close -- and nothing else.
describe('ReflectionSourcesPanel -- centred-modal breakpoint and dismissal (#2883, #3133)', () => {
  const { CENTRED_MODAL_BREAKPOINT } = require('../ReflectionSourcesPanel') as {
    CENTRED_MODAL_BREAKPOINT: number;
  };

  function renderAt(width: number, props: Record<string, unknown> = {}) {
    const rn = require('react-native');
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
    return render(
      <ReflectionSourcesPanel items={[item({ id: 3 })]} onInsertQuote={jest.fn()} {...props} />,
    );
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the breakpoint where the page plus half a reading measure fits, so no narrower width changes', () => {
    // contentLayout.maxWidth (680 + 220) + half the reading measure (680 / 2).
    expect(CENTRED_MODAL_BREAKPOINT).toBe(1240);
  });

  it.each([
    [768, 'reflection-sources-sheet', 'reflection-sources-modal'],
    [1024, 'reflection-sources-sheet', 'reflection-sources-modal'],
    [1239, 'reflection-sources-sheet', 'reflection-sources-modal'],
    [1240, 'reflection-sources-modal', 'reflection-sources-sheet'],
  ])('at %ipx renders %s, not %s', (width, shown, absent) => {
    const { getByTestId, queryByTestId } = renderAt(width);
    expect(getByTestId(shown)).toBeTruthy();
    expect(queryByTestId(absent)).toBeNull();
  });

  it('closes the sheet on a backdrop tap', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderAt(390, { onClose });
    fireEvent.press(getByTestId('reflection-sources-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the backdrop out of the accessibility tree', () => {
    const { getByTestId } = renderAt(390, { onClose: jest.fn() });
    const backdrop = getByTestId('reflection-sources-backdrop');
    expect(backdrop.props.accessible).toBe(false);
    expect(backdrop.props.importantForAccessibility).toBe('no');
  });

  it('does not close when the sheet body or a row inside it is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderAt(390, { onClose });
    const body = getByTestId('reflection-sources-sheet-body');
    // The body is the backdrop's sibling, never its child: a press inside it
    // cannot bubble to the backdrop's handler.
    expect(
      within(getByTestId('reflection-sources-backdrop')).queryByTestId(
        'reflection-sources-sheet-body',
      ),
    ).toBeNull();
    fireEvent.press(body);
    fireEvent.press(getByTestId('entry-source-3'));
    expect(onClose).not.toHaveBeenCalled();
    expect(getByTestId('source-body-3')).toBeTruthy();
  });

  it('hands the Modal the same close for Escape and the platform back button', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderAt(390, { onClose });
    expect(getByTestId('reflection-sources-sheet').props.onRequestClose).toBe(onClose);
  });

  it('bounds the sheet as a column capped at the content width and centred', () => {
    const { getByTestId } = renderAt(1024, { onClose: jest.fn() });
    const style = StyleSheet.flatten(getByTestId('reflection-sources-sheet-body').props.style);
    expect(style.maxHeight).toBe('80%');
    expect(style.maxWidth).toBe(900);
    expect(style.alignSelf).toBe('center');
  });

  it.each([
    [390, 'reflection-sources-sheet'],
    [1280, 'reflection-sources-modal'],
  ])(
    'at %ipx leaves Escape and back to the Modal alone: one request, one close',
    (width, modalId) => {
      const rn = require('react-native');
      const add = jest.spyOn(rn.BackHandler, 'addEventListener');
      const onClose = jest.fn();
      const { getByTestId } = renderAt(width, { onClose });
      const modal = getByTestId(modalId);
      expect(modal.props.onRequestClose).toBe(onClose);
      act(() => {
        modal.props.onRequestClose();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
    },
  );

  it('closes the centred modal on a backdrop tap', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderAt(1280, { onClose });
    fireEvent.press(getByTestId('reflection-sources-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the centred modal backdrop out of the accessibility tree and the focus order', () => {
    const { getByTestId } = renderAt(1280, { onClose: jest.fn() });
    const backdrop = getByTestId('reflection-sources-backdrop');
    expect(backdrop.props.accessible).toBe(false);
    expect(backdrop.props.importantForAccessibility).toBe('no');
    expect(backdrop.props.focusable).toBe(false);
  });

  it('does not close when the centred card or a row inside it is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderAt(1280, { onClose });
    // The card is the backdrop's sibling, never its child: a press inside it
    // cannot bubble to the backdrop's handler.
    expect(
      within(getByTestId('reflection-sources-backdrop')).queryByTestId(
        'reflection-sources-modal-body',
      ),
    ).toBeNull();
    fireEvent.press(getByTestId('reflection-sources-modal-body'));
    fireEvent.press(getByTestId('entry-source-3'));
    expect(onClose).not.toHaveBeenCalled();
    expect(getByTestId('source-body-3')).toBeTruthy();
  });

  it.each([
    [390, 'reflection-sources-sheet', 'slide'],
    [1280, 'reflection-sources-modal', 'fade'],
  ])('at %ipx the %s arrives with a %s', (width, modalId, animation) => {
    const { getByTestId } = renderAt(width, { onClose: jest.fn() });
    expect(getByTestId(modalId).props.animationType).toBe(animation);
  });

  it.each([
    [390, 'reflection-sources-sheet'],
    [1280, 'reflection-sources-modal'],
  ])('at %ipx the %s does not move when the reader asks for reduced motion', (width, modalId) => {
    const motion = require('@/hooks/useReducedMotion');
    jest.spyOn(motion, 'useReducedMotion').mockReturnValue(true);
    const { getByTestId } = renderAt(width, { onClose: jest.fn() });
    expect(getByTestId(modalId).props.animationType).toBe('none');
  });

  it.each([
    [390, 'reflection-sources-sheet'],
    [1280, 'reflection-sources-modal'],
  ])('at %ipx names the %s dialog "Sources"', (width, modalId) => {
    const { getByTestId } = renderAt(width, { onClose: jest.fn() });
    expect(getByTestId(modalId).props['aria-label']).toBe('Sources');
  });

  function openSelection(width: number) {
    const utils = renderAt(width, { onClose: jest.fn(), onPromoteSpan: jest.fn() });
    fireEvent.press(utils.getByTestId('entry-source-3'));
    fireEvent.press(utils.getByTestId('source-promote-entry-3'));
    return utils;
  }

  it('bounds the selection field on native so the floating Promote and Cancel stay in the sheet', () => {
    // Jest mounts on ios; the bound is a share of the window's height (900).
    const { getByTestId, toJSON } = openSelection(390);
    const input = getByTestId('source-select-entry-3-input');
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBe(315);
    expect(input.props.scrollEnabled).toBe(true);
    const tree = JSON.stringify(toJSON());
    const at = (id: string) => tree.indexOf(id);
    expect(at('source-select-entry-3-input')).toBeLessThan(at('source-select-entry-3-dock'));
    expect(at('source-select-entry-3-input')).toBeLessThan(at('source-select-entry-3-cancel'));
  });

  it('leaves the field unbounded on web, where the actions footer is sticky', () => {
    const Platform = require('react-native').Platform as { OS: string };
    const original = Platform.OS;
    Platform.OS = 'web';
    try {
      const { getByTestId } = openSelection(390);
      const input = getByTestId('source-select-entry-3-input');
      expect(StyleSheet.flatten(input.props.style).maxHeight).toBeUndefined();
      expect(input.props.scrollEnabled).toBe(false);
    } finally {
      Platform.OS = original;
    }
  });
});

// #2883 / #3133: crossing the breakpoint (a tablet rotating, a window resized)
// swaps the sheet for the centred card. What the reader was doing -- an
// expanded row, a folded quote's dim, a passage mid-selection -- survives it,
// and the content is not even remounted: only the one Modal's props change.
describe('ReflectionSourcesPanel -- crossing the centred-modal breakpoint while open (#2883, #3133)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockWidth(width: number) {
    const rn = require('react-native');
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
  }

  it.each([
    [1280, 390, 'reflection-sources-sheet-body'],
    [390, 1280, 'reflection-sources-modal-body'],
  ])(
    'keeps the expanded row, the folded dim and the selection from %ipx to %ipx',
    async (from, to, frame) => {
      const onPromoteSpan = jest.fn(() => Promise.resolve(true));
      const selecting = item({ id: 3, body: 'A steady daily walk to the river.' });
      const other = item({
        id: 4,
        timestamp: '2026-06-02T00:00:00Z',
        body: 'Another full body.',
        promoted_quotes: [quote({ id: 90, pending: true })],
      });
      // A fresh element per render, so the rerender is not skipped as unchanged.
      const element = () => (
        <ReflectionSourcesPanel
          items={[selecting, other]}
          onInsertQuote={jest.fn()}
          onPromoteSpan={onPromoteSpan}
          onClose={jest.fn()}
        />
      );
      mockWidth(from);
      const screen = render(element());
      fireEvent.press(screen.getByTestId('pending-quote-90'));
      fireEvent.press(screen.getByTestId('entry-source-4'));
      fireEvent.press(screen.getByTestId('entry-source-3'));
      fireEvent.press(screen.getByTestId('source-promote-entry-3'));
      fireEvent(screen.getByTestId('source-select-entry-3-input'), 'selectionChange', {
        nativeEvent: { selection: { start: 2, end: 8 } },
      });
      const scrollBefore = screen.getByTestId('reflection-sources-scroll');

      mockWidth(to);
      screen.rerender(element());

      expect(within(screen.getByTestId(frame)).getByTestId('reflection-sources-scroll')).toBe(
        scrollBefore,
      );
      expect(screen.getByTestId('source-body-4')).toBeTruthy();
      expect(screen.getByTestId('pending-quote-90').props.accessibilityState?.disabled).toBe(true);
      expect(screen.getByTestId('source-select-entry-3-preview').props.children).toBe('steady');
      await act(async () => {
        fireEvent.press(screen.getByTestId('promote-selection-fab'));
      });
      expect(onPromoteSpan).toHaveBeenCalledWith(selecting, { anchor_start: 2, anchor_end: 8 });
    },
  );
});

/** The retired inline side pane's width (#3133): half the reading measure. */
const RETIRED_PANE_WIDTH = journalLayout.pageMaxWidth / 2;

/** A rendered node, read only for its style. */
type StyledNode = { props: { style?: StyleProp<ViewStyle> } };

// #3133: on a laptop a 340px column beside the page stranded the sources in a
// sliver. From the breakpoint up the panel opens as a centred modal card at the
// page's own reading measure, over a dimmed desk.
describe('ReflectionSourcesPanel -- centred modal at laptop widths (#3133)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([1240, 1440])(
    'at %ipx renders the panel in a centred Modal card at the reading measure, with no 340px pane',
    (width) => {
      const rn = require('react-native');
      jest
        .spyOn(rn, 'useWindowDimensions')
        .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
      const { getByTestId, queryByTestId, UNSAFE_getByType, UNSAFE_root } = render(
        <ReflectionSourcesPanel
          items={[item({ id: 3 })]}
          onInsertQuote={jest.fn()}
          onClose={jest.fn()}
        />,
      );
      const modal = UNSAFE_getByType(Modal);
      expect(modal.props.testID).toBe('reflection-sources-modal');
      expect(modal.props.transparent).toBe(true);
      const card = StyleSheet.flatten(getByTestId('reflection-sources-modal-body').props.style);
      expect(card.maxWidth).toBe(journalLayout.pageMaxWidth);
      expect(card.width).toBe('100%');
      expect(card.alignSelf).toBe('center');
      expect(card.maxHeight).toBe('90%');
      const scrimNode = getByTestId('reflection-sources-scrim');
      expect(within(scrimNode).getByTestId('reflection-sources-backdrop')).toBeTruthy();
      const scrim = StyleSheet.flatten(scrimNode.props.style);
      expect(scrim.justifyContent).toBe('center');
      expect(scrim.backgroundColor).toBe(colors.mystical.overlay);
      expect(queryByTestId('reflection-sources-pane')).toBeNull();
      expect(queryByTestId('reflection-sources-sheet')).toBeNull();
      const paneWide = UNSAFE_root.findAll(
        (node: StyledNode) => StyleSheet.flatten(node.props.style)?.width === RETIRED_PANE_WIDTH,
      );
      expect(paneWide).toHaveLength(0);
    },
  );
});
