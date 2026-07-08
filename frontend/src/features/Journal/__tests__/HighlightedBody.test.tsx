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
