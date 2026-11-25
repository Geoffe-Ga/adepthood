/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import HighlightedBody from '../HighlightedBody';
import { JOURNAL_TASK_GLYPHS } from '../JournalListBlock';

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
  // An unseen marker sizer (aria-hidden) is layout, not text the reader gets.
  if (node.props['aria-hidden'] === true) return '';
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

/** Whether a rendered node sits under the element carrying ``testID``. */
function isInside(node: RenderedNode, testID: string): boolean {
  for (let at = node.parent; at != null; at = at.parent) {
    if (at.props.testID === testID) return true;
  }
  return false;
}

/** Every unseen (aria-hidden) host element under a node, in order. */
function unseenNodes(node: RenderedNode): RenderedNode[] {
  if (node.props['aria-hidden'] === true && typeof node.type === 'string') return [node];
  return node.children.flatMap((child: RenderedNode | string) =>
    typeof child === 'string' ? [] : unseenNodes(child),
  );
}

/** The text of every unseen host element under a node, in order. */
function unseenTexts(node: RenderedNode): string[] {
  return unseenNodes(node).map((unseen) => unseen.children.join(''));
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
    source_kind: 'entry',
    source_entry_id: 1,
    source_content_id: null,
    source_marginalia_id: null,
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
    // and a tab (JOURNAL_TAB_COLUMNS). Each line is its own row (#3252), so
    // no line feed joins them.
    const { getByTestId } = render(
      <HighlightedBody body={'- one\n  - nested\n\t- tabbed'} notes={[]} onOpen={jest.fn()} />,
    );

    expect(renderedText(getByTestId('journal-markdown-item-0'))).toBe('\u2022 one');
    expect(renderedText(getByTestId('journal-markdown-item-6'))).toBe('  \u2022 nested');
    expect(renderedText(getByTestId('journal-markdown-item-17'))).toBe('    \u2022 tabbed');
    expect(renderedText(getByTestId('journal-markdown-bullet-0'))).toBe(
      '\u2022 one  \u2022 nested    \u2022 tabbed',
    );
  });

  it('lays a list line out as indent, marker column and a wrapping text cell (#3252)', () => {
    // The hanging indent: the marker is a cell of its own, so the text cell is
    // the only thing that wraps and every visual line starts on its left edge.
    const { getByTestId } = render(
      <HighlightedBody body={'- one\n  - nested'} notes={[]} onOpen={jest.fn()} />,
    );

    const row = getByTestId('journal-markdown-item-6');
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row');
    const marker = getByTestId('journal-markdown-marker-6');
    expect(renderedText(marker)).toBe('\u2022 ');
    expect(marker.props.selectable).toBe(false);
    const text = getByTestId('journal-markdown-item-text-6');
    expect(renderedText(text)).toBe('nested');
    const textStyle = StyleSheet.flatten(text.props.style);
    expect(textStyle).toEqual(
      expect.objectContaining({ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }),
    );
    expect(textStyle.fontSize).toBe(editorialType.body.fontSize);
    // The marker is set in the body type, so its column is measured in it.
    expect(StyleSheet.flatten(marker.props.style).fontSize).toBe(editorialType.body.fontSize);
  });

  it('anchors a note that starts deep inside a long list line, in its text cell (#3252)', () => {
    // The passage sits far enough into the item to be on a later visual line
    // once the item wraps; its run must be a nested Text of the wrapping cell
    // (never the marker column), carrying exactly the anchored words.
    const body =
      '- A long thought that runs past the edge of the page and wraps onto a second line where the heron stood.\n- next';
    const start = body.indexOf('the heron stood');
    const anchored = note({
      id: 71,
      anchor_start: start,
      anchor_end: start + 'the heron stood'.length,
      anchor_text: 'the heron stood',
    });
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={onOpen} />,
    );

    const highlight = getByTestId('highlight-71');
    expect(renderedText(highlight)).toBe('the heron stood');
    expect(isInside(highlight, 'journal-markdown-item-text-0')).toBe(true);
    expect(isInside(highlight, 'journal-markdown-item-marker-0')).toBe(false);
    expect(renderedText(getByTestId('journal-markdown-item-text-0'))).toBe(body.slice(2, -7));
    fireEvent.press(highlight);
    expect(onOpen).toHaveBeenCalledWith(anchored);
  });

  it('keeps one note across two list items as a primary run and a continuation (#3252)', () => {
    const body = '- one\n- two';
    const anchored = note({ id: 72, anchor_start: 3, anchor_end: 11, anchor_text: 'ne\n- two' });
    const { getByTestId } = render(
      <HighlightedBody body={body} notes={[anchored]} onOpen={jest.fn()} />,
    );

    expect(renderedText(getByTestId('highlight-72'))).toBe('ne');
    expect(renderedText(getByTestId('highlight-72-continuation'))).toBe('two');
    expect(isInside(getByTestId('highlight-72-continuation'), 'journal-markdown-item-text-6')).toBe(
      true,
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

  it('draws each ordered marker as typed, soft ink, in one column per block (#3252)', () => {
    const { getByTestId } = render(
      <HighlightedBody body={'9. nine\n10. ten\n3) three'} notes={[]} onOpen={jest.fn()} />,
    );
    const block = getByTestId('journal-markdown-ordered-0');
    expect(block.props.accessibilityLabel).toBe('List');
    expect(renderedText(getByTestId('journal-markdown-ordinal-0'))).toBe('9. ');
    expect(renderedText(getByTestId('journal-markdown-ordinal-8'))).toBe('10. ');
    expect(renderedText(getByTestId('journal-markdown-ordinal-16'))).toBe('3) ');
    const style = StyleSheet.flatten(getByTestId('journal-markdown-ordinal-0').props.style);
    expect(style.color).toBe(colors.paper.inkSoft);
    expect(style.fontVariant).toEqual(['tabular-nums']);
    expect(renderedText(block)).toBe('9. nine10. ten3) three');
  });

  it('gives 9. and 10. the same marker column: every row holds every marker shape (#3252)', () => {
    // No width is measured in script. Each row's column carries an unseen copy
    // of each marker shape at its level, so the layout engine sizes all three
    // columns alike, and the number itself is pinned to the column's far edge.
    const { getByTestId } = render(
      <HighlightedBody body={'9. nine\n10. ten\n3) three'} notes={[]} onOpen={jest.fn()} />,
    );
    const sizersOf = (start: number): string[] =>
      unseenTexts(getByTestId(`journal-markdown-item-marker-${start}`));
    expect(sizersOf(0)).toEqual(['0. ', '00. ', '0) ']);
    expect(sizersOf(8)).toEqual(sizersOf(0));
    expect(sizersOf(16)).toEqual(sizersOf(0));

    const ordinal = StyleSheet.flatten(getByTestId('journal-markdown-ordinal-0').props.style);
    expect(ordinal).toEqual(expect.objectContaining({ position: 'absolute', right: 0, top: 0 }));
    // A sizer is unseen and unselectable, and wears the ordinal's own style so
    // it is exactly as wide; only the first gives the column a line of height.
    const [first, second] = unseenNodes(getByTestId('journal-markdown-item-marker-0'));
    const firstStyle = StyleSheet.flatten(first?.props.style);
    expect(firstStyle.color).toBe('transparent');
    expect(firstStyle.fontVariant).toEqual(['tabular-nums']);
    expect(firstStyle.height).toBeUndefined();
    expect(first?.props.selectable).toBe(false);
    expect(StyleSheet.flatten(second?.props.style).height).toBe(0);
  });

  it("gives a nested number the block's column, so its text sits its indent deeper (#3252)", () => {
    // One column width for the whole block: a nested "1." under "10." takes
    // the two-digit column too, and only its indent moves its text.
    const { getByTestId } = render(
      <HighlightedBody body={'10. ten\n  1. inner\n  2. other'} notes={[]} onOpen={jest.fn()} />,
    );
    expect(unseenTexts(getByTestId('journal-markdown-item-marker-8'))).toEqual(['00. ', '0. ']);
    expect(unseenTexts(getByTestId('journal-markdown-item-marker-0'))).toEqual(['00. ', '0. ']);
    expect(renderedText(getByTestId('journal-markdown-item-8'))).toBe('  1. inner');
  });

  it('draws a checkbox glyph for each task and dims, never strikes, a checked one', () => {
    const { getByTestId, queryByTestId } = render(
      <HighlightedBody body={'- [x] called Sam\n  - [ ] book'} notes={[]} onOpen={jest.fn()} />,
    );
    const block = getByTestId('journal-markdown-task-0');
    expect(renderedText(block)).toBe(
      `${JOURNAL_TASK_GLYPHS.done} called Sam  ${JOURNAL_TASK_GLYPHS.open} book`,
    );
    expect(renderedText(getByTestId('journal-markdown-checkbox-0'))).toBe(
      `${JOURNAL_TASK_GLYPHS.done} `,
    );
    const done = StyleSheet.flatten(getByTestId('journal-markdown-task-done-0').props.style);
    expect(done.color).toBe(colors.paper.inkSoft);
    expect(done.textDecorationLine).toBeUndefined();
    expect(queryByTestId('journal-markdown-task-done-17')).toBeNull();
  });

  it('holds open and done checkboxes to one column, and a lone glyph sizes itself (#3252)', () => {
    const { getByTestId } = render(
      <HighlightedBody body={'- [x] done\n- [ ] open'} notes={[]} onOpen={jest.fn()} />,
    );
    const open = getByTestId('journal-markdown-checkbox-11');
    expect(StyleSheet.flatten(open.props.style)).toEqual(
      expect.objectContaining({ position: 'absolute', left: 0, top: 0 }),
    );
    expect(renderedText(getByTestId('journal-markdown-item-11'))).toBe(
      `${JOURNAL_TASK_GLYPHS.open} open`,
    );

    // A block whose every marker is the same glyph needs no sizer: in the flow.
    const lone = render(
      <HighlightedBody body={'- [ ] a\n- [ ] b'} notes={[]} onOpen={jest.fn()} />,
    );
    const glyph = lone.getByTestId('journal-markdown-checkbox-0');
    expect(StyleSheet.flatten(glyph.props.style).position).toBeUndefined();
    expect(unseenTexts(lone.getByTestId('journal-markdown-item-marker-0'))).toEqual([]);
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
