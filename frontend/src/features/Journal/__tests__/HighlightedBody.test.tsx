/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import HighlightedBody from '../HighlightedBody';
import { JOURNAL_ORDINAL_PAD, JOURNAL_TASK_GLYPHS } from '../ReadOnlyMarkdownText';

import type { Marginalia, PromotedQuote } from '@/api';
import { SPACING, colors, editorialType } from '@/design/tokens';

const BODY = 'I walked by the river and the willow bent.';

/**
 * Every string leaf under a node, concatenated in render order.
 *
 * Read verbatim rather than through a text matcher: the bullet decoration is
 * leading whitespace plus a glyph, and a normalising matcher would collapse
 * exactly the indent under test.
 */
type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

function renderedText(node: RenderedNode): string {
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

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

  it.each([
    ['> *Quoted river*', 'Quoted river'],
    ['- *Listed river*', 'Listed river'],
  ])('keeps an anchor reachable when it includes the hidden marker of %j', (body, inner) => {
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
    expect(getByTestId('journal-markdown-bold-3').props.children).toBe(inner);
  });

  it.each([
    ['*bold*', 0, 1, '*'],
    ['- one', 0, 1, '-'],
    ['> quoted', 0, 2, '> '],
    ['a <u>und</u> b', 2, 5, '<u>'],
  ])(
    'keeps syntax-only note anchors visible and actionable in %j',
    (body, anchorStart, anchorEnd, literal) => {
      const anchored = note({
        id: 83,
        anchor_start: anchorStart,
        anchor_end: anchorEnd,
        anchor_text: literal,
      });
      const onOpen = jest.fn();
      const { getByTestId } = render(
        <HighlightedBody body={body} notes={[anchored]} onOpen={onOpen} />,
      );

      const highlight = getByTestId('highlight-83');
      expect(highlight.props.children).toEqual([literal]);
      fireEvent.press(highlight);
      expect(onOpen).toHaveBeenCalledWith(anchored);
    },
  );

  it.each([
    ['> quoted', '> '],
    ['- listed', '- '],
  ])('keeps syntax-only promoted quote anchors visible and removable in %j', (body, literal) => {
    // The server snapshots the span's text with its edges trimmed.
    const anchored = quote({
      id: 93,
      anchor_start: 0,
      anchor_end: 2,
      anchor_text: literal.trim(),
    });
    const onQuotePress = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody
        body={body}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[anchored]}
        onQuotePress={onQuotePress}
      />,
    );

    const highlight = getByTestId('quote-highlight-93');
    expect(highlight.props.children).toEqual([literal]);
    fireEvent.press(highlight);
    expect(onQuotePress).toHaveBeenCalledWith(anchored);
  });

  it('renders adjacent bullet lines as one block, markers hidden, quotes unaffected', () => {
    const { getByTestId, queryByText } = render(
      <HighlightedBody body={'- one\n- two\n> q'} notes={[]} onOpen={jest.fn()} />,
    );

    const bullets = getByTestId('journal-markdown-bullet-0');
    expect(bullets.props.accessibilityLabel).toBe('List');
    expect(getByTestId('journal-markdown-quote-12')).toBeTruthy();
    expect(queryByText(/- one/u)).toBeNull();
  });

  it('draws a bullet glyph in place of every hidden marker, at the measured indent', () => {
    // The writer's own '- ' is hidden, so this glyph and this indent are the
    // whole visible payload of a list line. Three depths: flush, two spaces,
    // and a tab (JOURNAL_TAB_COLUMNS).
    const { getByTestId } = render(
      <HighlightedBody body={'- one\n  - nested\n\t- tabbed'} notes={[]} onOpen={jest.fn()} />,
    );

    expect(renderedText(getByTestId('journal-markdown-bullet-0'))).toBe(
      '\u2022 one\n  \u2022 nested\n    \u2022 tabbed',
    );
  });

  it('draws no bullet decoration on a quote or a prose block', () => {
    const { getByTestId } = render(
      <HighlightedBody body={'> quoted\nplain'} notes={[]} onOpen={jest.fn()} />,
    );

    expect(renderedText(getByTestId('journal-markdown-quote-0'))).toBe('quoted');
    expect(renderedText(getByTestId('journal-body-read'))).toBe('quotedplain');
  });

  it('renders <u>text</u> underlined at its exact source offset', () => {
    const { getByTestId, queryByText } = render(
      <HighlightedBody body="a <u>und</u> b" notes={[]} onOpen={jest.fn()} />,
    );

    const underline = getByTestId('journal-markdown-underline-5');
    expect(underline.props.children).toBe('und');
    expect(StyleSheet.flatten(underline.props.style).textDecorationLine).toBe('underline');
    expect(queryByText('a <u>und</u> b')).toBeNull();
    expect(renderedText(getByTestId('journal-body-read'))).toBe('a und b');
  });

  it('renders the retired ==text== spelling as the literal prose it now is', () => {
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body="a ==und== b" notes={[]} onOpen={jest.fn()} />,
    );

    expect(queryByTestId('journal-markdown-underline-4')).toBeNull();
    expect(queryByTestId('journal-markdown-underline-2')).toBeNull();
    expect(renderedText(getByTestId('journal-body-read'))).toBe('a ==und== b');
  });
});

/** Render under ``Platform.OS === 'web'``, restoring the platform afterwards. */
function onWeb<T>(run: () => T): T {
  const Platform = require('react-native').Platform as { OS: string };
  const original = Platform.OS;
  Platform.OS = 'web';
  try {
    return run();
  } finally {
    Platform.OS = original;
  }
}

describe('HighlightedBody -- headings, ordered items, tasks and rules (#3251)', () => {
  const TUESDAY = '## Tuesday\n1. walked\n2. wrote\n- [x] called Sam\n- [ ] book the room\n---';

  it.each([
    ['# One', editorialType.title.fontSize, editorialType.title.fontWeight],
    ['## Two', editorialType.heading.fontSize, editorialType.heading.fontWeight],
    ['### Three', editorialType.body.fontSize, '700'],
    ['###### Six', editorialType.body.fontSize, '700'],
  ])('draws %j at its rung of the type ramp, in ink, markers hidden', (body, size, weight) => {
    const { getByTestId } = render(<HighlightedBody body={body} notes={[]} onOpen={jest.fn()} />);
    const heading = getByTestId('journal-markdown-heading-0');
    const style = StyleSheet.flatten(heading.props.style);
    expect(style.fontSize).toBe(size);
    expect(style.fontWeight).toBe(weight);
    expect(style.color).toBe(colors.paper.ink);
    expect(renderedText(heading)).toBe(body.replace(/^#+ /u, ''));
  });

  it('announces a heading as a header on native', () => {
    const { getByTestId } = render(
      <HighlightedBody body="## Tuesday" notes={[]} onOpen={jest.fn()} />,
    );
    expect(getByTestId('journal-markdown-heading-0').props.accessibilityRole).toBe('header');
  });

  it('gives a heading role="heading" and its aria-level on web', () => {
    const heading = onWeb(() =>
      render(<HighlightedBody body={'x\n### Tuesday'} notes={[]} onOpen={jest.fn()} />).getByTestId(
        'journal-markdown-heading-2',
      ),
    );
    expect(heading.props.role).toBe('heading');
    expect(heading.props['aria-level']).toBe(3);
  });

  it('draws each ordered marker as typed, soft ink, padded to a two-digit column', () => {
    const { getByTestId } = render(
      <HighlightedBody body={'9. nine\n10. ten\n3) three'} notes={[]} onOpen={jest.fn()} />,
    );
    const block = getByTestId('journal-markdown-ordered-0');
    expect(block.props.accessibilityLabel).toBe('List');
    expect(renderedText(getByTestId('journal-markdown-ordinal-0'))).toBe(
      `${JOURNAL_ORDINAL_PAD}9. `,
    );
    expect(renderedText(getByTestId('journal-markdown-ordinal-8'))).toBe('10. ');
    expect(renderedText(getByTestId('journal-markdown-ordinal-16'))).toBe(
      `${JOURNAL_ORDINAL_PAD}3) `,
    );
    const style = StyleSheet.flatten(getByTestId('journal-markdown-ordinal-0').props.style);
    expect(style.color).toBe(colors.paper.inkSoft);
    expect(style.fontVariant).toEqual(['tabular-nums']);
    expect(renderedText(block)).toBe(
      `${JOURNAL_ORDINAL_PAD}9. nine\n10. ten\n${JOURNAL_ORDINAL_PAD}3) three`,
    );
  });

  it('draws a checkbox glyph for each task and dims, never strikes, a checked one', () => {
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={'- [x] called Sam\n  - [ ] book'} notes={[]} onOpen={jest.fn()} />,
    );
    const block = getByTestId('journal-markdown-task-0');
    expect(renderedText(block)).toBe(
      `${JOURNAL_TASK_GLYPHS.done} called Sam\n  ${JOURNAL_TASK_GLYPHS.open} book`,
    );
    expect(renderedText(getByTestId('journal-markdown-checkbox-0'))).toBe(
      `${JOURNAL_TASK_GLYPHS.done} `,
    );
    const done = StyleSheet.flatten(getByTestId('journal-markdown-task-done-0').props.style);
    expect(done.color).toBe(colors.paper.inkSoft);
    expect(done.textDecorationLine).toBeUndefined();
    expect(queryByTestId('journal-markdown-task-done-17')).toBeNull();
  });

  it('makes finished-entry task glyphs accessible and pressable without opening an anchor', () => {
    const body = '- [ ] *buy milk*';
    const anchored = note({
      id: 86,
      anchor_start: 0,
      anchor_end: Array.from(body).length,
      anchor_text: body,
    });
    const onOpen = jest.fn();
    const onTaskPress = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={onOpen} onTaskPress={onTaskPress} />,
    );

    const checkbox = getByTestId('journal-markdown-checkbox-0');
    expect(checkbox.props.accessibilityRole).toBe('checkbox');
    expect(checkbox.props.accessibilityState).toEqual({ checked: false });
    expect(checkbox.props.accessibilityLabel).toContain('buy milk');
    const target = StyleSheet.flatten(checkbox.props.style);
    expect(target.paddingHorizontal * 2 + editorialType.body.fontSize).toBeGreaterThanOrEqual(44);
    expect(target.paddingVertical * 2 + editorialType.body.lineHeight).toBeGreaterThanOrEqual(44);
    expect(target.marginHorizontal).toBe(-target.paddingHorizontal);
    expect(target.marginVertical).toBe(-target.paddingVertical);

    fireEvent.press(checkbox);

    expect(onTaskPress).toHaveBeenCalledWith(0);
    expect(onOpen).not.toHaveBeenCalled();

    const keyEvent = {
      key: ' ',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    checkbox.props.onKeyDown(keyEvent);

    expect(keyEvent.preventDefault).toHaveBeenCalled();
    expect(keyEvent.stopPropagation).toHaveBeenCalled();
    expect(onTaskPress).toHaveBeenLastCalledWith(0);
    expect(onTaskPress).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('draws a rule as a hairline with its characters hidden', () => {
    const { getByTestId } = render(
      <HighlightedBody body={'above\n---\nbelow'} notes={[]} onOpen={jest.fn()} />,
    );
    const rule = getByTestId('journal-markdown-rule-6');
    const style = StyleSheet.flatten(rule.props.style);
    expect(style.height).toBe(StyleSheet.hairlineWidth);
    expect(style.backgroundColor).toBe(colors.paper.hairline);
    expect(style.marginVertical).toBe(SPACING.sm);
    expect(renderedText(getByTestId('journal-body-read'))).toBe('abovebelow');
  });

  it('renders the issue example: heading, as-typed numbers, checkboxes and a rule', () => {
    const { getByTestId, queryByText } = render(
      <HighlightedBody body={TUESDAY} notes={[]} onOpen={jest.fn()} />,
    );
    expect(renderedText(getByTestId('journal-markdown-heading-0'))).toBe('Tuesday');
    expect(getByTestId('journal-markdown-ordered-11')).toBeTruthy();
    expect(getByTestId('journal-markdown-task-30')).toBeTruthy();
    expect(getByTestId(`journal-markdown-rule-${Array.from(TUESDAY).length - 3}`)).toBeTruthy();
    expect(queryByText(/##|\[x\]|---/u)).toBeNull();
  });

  it('keeps an anchor across a hidden ## and - [x] prefix whole and pressable', () => {
    const body = '## Tuesday\n- [x] called Sam';
    const chars = Array.from(body);
    const anchored = note({
      id: 84,
      anchor_start: chars.indexOf('d'),
      anchor_end: chars.indexOf('S') - 1,
      anchor_text: 'day\n- [x] called',
    });
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={onOpen} />,
    );
    expect(renderedText(getByTestId('highlight-84'))).toBe('day');
    expect(renderedText(getByTestId('highlight-84-continuation'))).toBe('called');
    fireEvent.press(getByTestId('highlight-84-continuation'));
    expect(onOpen).toHaveBeenCalledWith(anchored);
  });

  it('keeps a note anchored only on a rule visible and actionable', () => {
    const anchored = note({ id: 85, anchor_start: 2, anchor_end: 5, anchor_text: '---' });
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body={'a\n---'} notes={[anchored]} onOpen={onOpen} />,
    );
    expect(getByTestId('highlight-85').props.children).toEqual(['---']);
    fireEvent.press(getByTestId('highlight-85'));
    expect(onOpen).toHaveBeenCalledWith(anchored);
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

describe('HighlightedBody -- stale promoted quotes (#2891)', () => {
  it('shows a stale quote apart from the prose, labelled stale, never washed inline', () => {
    const stale = quote({ id: 1, stale: true, anchor_text: 'the willow' });
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={BODY} notes={[]} onOpen={jest.fn()} quotes={[stale]} />,
    );
    const row = getByTestId('stale-quote-1');
    expect(row.props.accessibilityLabel).toMatch(/stale/i);
    expect(row.props.accessibilityLabel).toContain('the willow');
    expect(queryByTestId('quote-highlight-1')).toBeNull();
  });

  it('draws a live quote inline and lists no stale row for it', () => {
    const live = quote({ id: 2, stale: false });
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={BODY} notes={[]} onOpen={jest.fn()} quotes={[live]} />,
    );
    expect(getByTestId('quote-highlight-2')).toBeTruthy();
    expect(queryByTestId('stale-quote-2')).toBeNull();
  });

  it('hands a pressed stale quote back so it can still be removed', () => {
    const stale = quote({ id: 3, stale: true, anchor_text: 'bygone words' });
    const onQuotePress = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[stale]}
        onQuotePress={onQuotePress}
      />,
    );
    fireEvent.press(getByTestId('stale-quote-3'));
    expect(onQuotePress).toHaveBeenCalledWith(stale);
  });

  it('opens the remove card for a stale quote with its own snapshot text', () => {
    const stale = quote({ id: 4, stale: true, anchor_text: 'bygone words' });
    const onConfirmRemove = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody
        body={BODY}
        notes={[]}
        onOpen={jest.fn()}
        quotes={[stale]}
        removeTargetId={4}
        onConfirmRemove={onConfirmRemove}
      />,
    );
    expect(getByTestId('promotion-remove-quote-4').props.children).toBe('bygone words');
    fireEvent.press(getByTestId('promotion-remove-4'));
    expect(onConfirmRemove).toHaveBeenCalled();
  });

  it('lists an included quote whose frozen offsets now address other words, not inline', () => {
    // BODY with text inserted before the passage: the included quote's offsets
    // were frozen at their pre-edit values and now address other words.
    const edited = `Earlier that day, ${BODY}`;
    const frozen = quote({ id: 5, pending: false });
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={edited} notes={[]} onOpen={jest.fn()} quotes={[frozen]} />,
    );
    expect(queryByTestId('quote-highlight-5')).toBeNull();
    expect(getByTestId('stale-quote-5').props.accessibilityLabel).toContain('the willow');
  });
});
