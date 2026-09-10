/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import HighlightedBody from '../HighlightedBody';

import type { Marginalia, PromotedQuote } from '@/api';
import { colors } from '@/design/tokens';

const BODY = 'I walked by the river and the willow bent.';

function note(overrides: Partial<Marginalia> = {}): Marginalia {
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

function quote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  const start = BODY.indexOf('the willow');
  return {
    id: 90,
    source_entry_id: 1,
    anchor_start: start,
    anchor_end: start + 'the willow'.length,
    anchor_text: 'the willow',
    pending: true,
    stale: false,
    ...overrides,
  };
}

describe('HighlightedBody -- render parity with no quotes (existing behavior)', () => {
  it('renders identical testIDs to the pre-existing (notes-only) tree when quotes is []', () => {
    const n = note({ id: 7 });
    const { getByTestId, queryAllByTestId } = render(
      <HighlightedBody body={BODY} notes={[n]} onOpen={jest.fn()} quotes={[]} />,
    );
    expect(getByTestId('journal-body-read')).toBeTruthy();
    expect(getByTestId('highlight-7')).toBeTruthy();
    expect(queryAllByTestId(/^quote-highlight-/)).toHaveLength(0);
  });

  it('renders the same tree when quotes is omitted entirely (default [])', () => {
    const { getByTestId, queryAllByTestId } = render(
      <HighlightedBody body={BODY} notes={[]} onOpen={jest.fn()} />,
    );
    expect(getByTestId('journal-body-read')).toBeTruthy();
    expect(queryAllByTestId(/^quote-highlight-/)).toHaveLength(0);
  });

  it('keeps the body container noninteractive when no remove card is open', () => {
    const { getByTestId } = render(<HighlightedBody body={BODY} notes={[]} onOpen={jest.fn()} />);
    const body = getByTestId('journal-body-read');

    expect(body.props.onPress).toBeUndefined();
    expect(body.props.accessibilityRole).toBeUndefined();
    expect(body.props.accessible).toBe(false);
    expect(body.props.tabIndex).not.toBe(0);
  });
});

describe('HighlightedBody -- lightweight Markdown', () => {
  it('renders *asterisk text* as bold and _underscore text_ as italics', () => {
    const { getByTestId, queryByText } = render(
      <HighlightedBody
        body="A *bold thought* and an _italic thought_."
        notes={[]}
        onOpen={jest.fn()}
      />,
    );

    const bold = getByTestId('journal-markdown-bold-3');
    const italic = getByTestId('journal-markdown-italic-25');
    expect(bold.props.children).toBe('bold thought');
    expect(StyleSheet.flatten(bold.props.style).fontWeight).toBe('700');
    expect(italic.props.children).toBe('italic thought');
    expect(StyleSheet.flatten(italic.props.style).fontStyle).toBe('italic');
    expect(queryByText('*bold thought*')).toBeNull();
    expect(queryByText('_italic thought_')).toBeNull();
  });

  it('renders consecutive > lines as one accessible quote block without the markers', () => {
    const { getByTestId, queryByText } = render(
      <HighlightedBody
        body={'Before\n> First quoted line\n> _Second quoted line_\nAfter'}
        notes={[]}
        onOpen={jest.fn()}
      />,
    );

    const block = getByTestId('journal-markdown-quote-7');
    expect(block.props.accessibilityLabel).toBe('Quote block');
    expect(StyleSheet.flatten(block.props.style).borderLeftColor).toBe(colors.paper.inkSoft);
    expect(getByTestId('journal-markdown-italic-30').props.children).toBe('Second quoted line');
    expect(queryByText(/> First quoted line/u)).toBeNull();
  });

  it('keeps malformed markers and HTML-looking prose as literal text', () => {
    const body = 'An *unfinished thought and <script>alert(1)</script>.';
    const { getByTestId, getByText, queryAllByTestId } = render(
      <HighlightedBody body={body} notes={[]} onOpen={jest.fn()} />,
    );

    expect(getByTestId('journal-body-read').props.children).toBeTruthy();
    expect(getByText(body)).toBeTruthy();
    expect(queryAllByTestId(/^journal-markdown-bold-/u)).toHaveLength(0);
    expect(queryAllByTestId(/^journal-markdown-italic-/u)).toHaveLength(0);
  });

  it('preserves code-point anchor offsets when formatting markers are hidden', () => {
    const body = '🌊 *river* reflection';
    const anchored = note({
      id: 81,
      anchor_start: Array.from(body).indexOf('r'),
      anchor_end: Array.from(body).indexOf('r') + 'river'.length,
      anchor_text: 'river',
    });
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={onOpen} />,
    );

    const highlight = getByTestId('highlight-81');
    expect(getByTestId('journal-markdown-bold-3').props.children).toBe('river');
    fireEvent.press(highlight);
    expect(onOpen).toHaveBeenCalledWith(anchored);
  });

  it('keeps an anchor reachable when it includes the hidden quote marker', () => {
    const body = '> *Quoted river*';
    const anchored = note({
      id: 82,
      anchor_start: 0,
      anchor_end: Array.from(body).length,
      anchor_text: body,
    });
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={jest.fn()} />,
    );

    expect(getByTestId('highlight-82')).toBeTruthy();
    expect(queryByTestId('highlight-82-continuation')).toBeNull();
    expect(getByTestId('journal-markdown-bold-3').props.children).toBe('Quoted river');
  });

  it('keeps syntax-only note anchors visible and actionable', () => {
    const anchored = note({ id: 83, anchor_start: 0, anchor_end: 1, anchor_text: '*' });
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body="*bold*" notes={[anchored]} onOpen={onOpen} />,
    );

    const highlight = getByTestId('highlight-83');
    expect(highlight.props.children).toEqual(['*']);
    fireEvent.press(highlight);
    expect(onOpen).toHaveBeenCalledWith(anchored);
  });

  it('keeps syntax-only promoted quote anchors visible and removable', () => {
    const anchored = quote({
      id: 93,
      anchor_start: 0,
      anchor_end: 2,
      anchor_text: '> ',
    });
    const onQuotePress = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody
        body="> quoted"
        notes={[]}
        onOpen={jest.fn()}
        quotes={[anchored]}
        onQuotePress={onQuotePress}
      />,
    );

    const highlight = getByTestId('quote-highlight-93');
    expect(highlight.props.children).toEqual(['> ']);
    fireEvent.press(highlight);
    expect(onQuotePress).toHaveBeenCalledWith(anchored);
  });
});

describe('HighlightedBody -- quote spans', () => {
  it('renders a pending quote span with a testID, link role, and the quote wash', () => {
    const q = quote({ id: 90, pending: true });
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[q]}
        onQuotePress={jest.fn()}
      />,
    );
    const span = getByTestId('quote-highlight-90');
    expect(span.props.accessibilityRole).toBe('link');
    const style = StyleSheet.flatten(span.props.style);
    expect(style.backgroundColor).toBe(colors.paper.quoteHighlight);
    expect(style.color).toBe(colors.paper.ink);
  });

  it('renders an included (non-pending) quote span dimmed, with no wash', () => {
    const q = quote({ id: 91, pending: false });
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[q]}
        onQuotePress={jest.fn()}
      />,
    );
    const span = getByTestId('quote-highlight-91');
    const style = StyleSheet.flatten(span.props.style);
    expect(style.color).toBe(colors.paper.inkSoft);
    expect(style.backgroundColor).not.toBe(colors.paper.quoteHighlight);
  });

  it('fires onQuotePress with the quote when its span is pressed', () => {
    const onQuotePress = jest.fn();
    const q = quote({ id: 92 });
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[q]}
        onQuotePress={onQuotePress}
      />,
    );
    fireEvent.press(getByTestId('quote-highlight-92'));
    expect(onQuotePress).toHaveBeenCalledWith(q);
  });

  it('splits the body correctly when a note and a quote both anchor into it', () => {
    const n = note({ id: 7, anchor_start: 0, anchor_end: 8 }); // "I walked"
    const q = quote({ id: 90 });
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[n]}
        onOpen={jest.fn()}
        quotes={[q]}
        onQuotePress={jest.fn()}
      />,
    );
    expect(getByTestId('highlight-7')).toBeTruthy();
    expect(getByTestId('quote-highlight-90')).toBeTruthy();
  });
});
