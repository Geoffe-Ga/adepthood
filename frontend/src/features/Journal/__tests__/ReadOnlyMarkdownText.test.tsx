import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { JOURNAL_TASK_GLYPHS } from '../JournalListBlock';
import ReadOnlyMarkdownText, { splitTextStyle } from '../ReadOnlyMarkdownText';

import { colors, editorialType } from '@/design/tokens';

type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

/** Every string leaf under a node, verbatim, in render order. */
function renderedText(node: RenderedNode): string {
  if (node.props['aria-hidden'] === true) return '';
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

describe('ReadOnlyMarkdownText -- block dialect (#3251)', () => {
  it('stays one Text for a body with no rule and no list', () => {
    const { getByTestId } = render(
      <ReadOnlyMarkdownText body={'## Day\n*bold* line'} style={{ color: 'red' }} testID="flat" />,
    );
    const flat = getByTestId('flat');
    expect(flat.type).toBe('Text');
    expect(StyleSheet.flatten(flat.props.style).color).toBe('red');
    expect(renderedText(flat)).toBe('Day\nbold line');
  });

  it('draws list lines as hanging-indent rows between its prose (#3252)', () => {
    const { getByTestId } = render(
      <ReadOnlyMarkdownText
        body={'## Day\n1. a\n- [x] b\n  - *deep*\nafter'}
        style={{ color: 'red', paddingTop: 4 }}
        testID="flat"
      />,
    );
    const flat = getByTestId('flat');
    // The container takes the caller's box once; each text takes its type.
    expect(flat.type).toBe('View');
    expect(StyleSheet.flatten(flat.props.style)).toEqual({ paddingTop: 4 });
    expect(renderedText(flat)).toBe(`Day1. a${JOURNAL_TASK_GLYPHS.done} b  \u2022 deepafter`);
    const row = getByTestId('journal-markdown-item-20');
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row');
    const text = getByTestId('journal-markdown-item-text-20');
    expect(renderedText(text)).toBe('deep');
    const textStyle = StyleSheet.flatten(text.props.style);
    expect(textStyle).toEqual(expect.objectContaining({ color: 'red', flexGrow: 1, flexBasis: 0 }));
    expect(textStyle.paddingTop).toBeUndefined();
    expect(getByTestId('journal-markdown-bold-25')).toBeTruthy();
    const marker = StyleSheet.flatten(getByTestId('journal-markdown-ordinal-7').props.style);
    expect(marker.paddingTop).toBeUndefined();
  });

  it('splits a text style into its type and its box', () => {
    expect(
      splitTextStyle([
        { fontSize: 18, color: 'red' },
        { marginTop: 2, flex: 1 },
      ]),
    ).toEqual({
      type: { fontSize: 18, color: 'red' },
      box: { marginTop: 2, flex: 1 },
    });
    expect(splitTextStyle(undefined)).toEqual({ type: {}, box: {} });
  });

  it('draws a heading at its rung, inside the flat text', () => {
    const { getByTestId } = render(<ReadOnlyMarkdownText body={'x\n# Big'} testID="flat" />);
    const heading = getByTestId('journal-markdown-heading-2');
    expect(StyleSheet.flatten(heading.props.style).fontSize).toBe(editorialType.title.fontSize);
    expect(heading.props.accessibilityRole).toBe('header');
    expect(renderedText(heading)).toBe('Big');
  });

  it('dims a checked task and leaves an open one at full ink', () => {
    const { getByTestId, queryByTestId } = render(
      <ReadOnlyMarkdownText body={'- [X] done\n- [ ] open'} testID="flat" />,
    );
    const done = getByTestId('journal-markdown-task-done-0');
    expect(StyleSheet.flatten(done.props.style).color).toBe(colors.paper.inkSoft);
    expect(queryByTestId('journal-markdown-task-done-11')).toBeNull();
  });

  it('keeps task glyphs non-interactive when no finished-entry handler is supplied', () => {
    const { getByTestId } = render(<ReadOnlyMarkdownText body="- [ ] source task" testID="flat" />);
    const checkbox = getByTestId('journal-markdown-checkbox-0');

    expect(checkbox.props.onPress).toBeUndefined();
    expect(checkbox.props.accessibilityRole).toBeUndefined();
    expect(checkbox.props.accessibilityState).toBeUndefined();
  });

  it('splits around each rule, drawing a hairline and none of its characters', () => {
    const { getByTestId } = render(
      <ReadOnlyMarkdownText
        body={'above\n***\nbelow\n---'}
        style={{ color: 'red' }}
        testID="flat"
      />,
    );
    const container = getByTestId('flat');
    expect(renderedText(container)).toBe('abovebelow');
    const rule = getByTestId('journal-markdown-rule-6');
    expect(StyleSheet.flatten(rule.props.style).height).toBe(StyleSheet.hairlineWidth);
    expect(getByTestId('journal-markdown-rule-16')).toBeTruthy();
  });

  it('draws a body that is only a rule as the hairline alone', () => {
    const { getByTestId } = render(<ReadOnlyMarkdownText body="___" testID="flat" />);
    expect(renderedText(getByTestId('flat'))).toBe('');
    expect(getByTestId('journal-markdown-rule-0')).toBeTruthy();
  });
});

/** The unseen sizers are hidden from assistive technology, so queries must ask for them. */
const HIDDEN = { includeHiddenElements: true };

/** The text of every unseen (aria-hidden) element under a node, in order. */
function unseenTexts(node: RenderedNode): string[] {
  if (node.props['aria-hidden'] === true && typeof node.type === 'string') {
    return [node.children.join('')];
  }
  return node.children.flatMap((child: RenderedNode | string) =>
    typeof child === 'string' ? [] : unseenTexts(child),
  );
}

describe('ReadOnlyMarkdownText -- continuation lines (#3800)', () => {
  it.each([
    ['a bullet', '- one\n  two', ['\u2022 ']],
    ['a numbered item', '1. one\n   two', ['0. ']],
    ['a checkbox', '- [x] one\n      two', [`${JOURNAL_TASK_GLYPHS.done} `]],
  ])(
    'sets a continuation line of %s as a row on its item’s marker column, with no marker',
    (_name, body, sizers) => {
      const { getByTestId, queryByTestId } = render(
        <ReadOnlyMarkdownText body={body} testID="flat" />,
      );
      const start = String(body.indexOf('\n') + 1);
      const row = getByTestId(`journal-markdown-continuation-${start}`);
      expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row');
      // The block's marker shapes, in no ink: the column is as wide as the
      // item's, so the text below starts exactly where the text above does.
      const column = getByTestId(`journal-markdown-item-marker-${start}`, HIDDEN);
      expect(unseenTexts(column)).toEqual(sizers);
      expect(renderedText(column)).toBe('');
      expect(renderedText(getByTestId(`journal-markdown-item-text-${start}`))).toBe('two');
      expect(queryByTestId(`journal-markdown-item-${start}`)).toBeNull();
      expect(renderedText(getByTestId('flat')).endsWith('onetwo')).toBe(true);
    },
  );

  it('keeps the unseen sizers in the ordinal’s tabular figures', () => {
    const { UNSAFE_getAllByProps } = render(<ReadOnlyMarkdownText body={'12. one\n    two'} />);
    const sizers = UNSAFE_getAllByProps({ 'aria-hidden': true }).filter(
      (node) => typeof node.type === 'string',
    );
    expect(sizers.length).toBeGreaterThan(0);
    for (const sizer of sizers) {
      const style = StyleSheet.flatten(sizer.props.style);
      expect(style.fontVariant).toEqual(['tabular-nums']);
      expect(style.color).toBe('transparent');
      expect(sizer.props.selectable).toBe(false);
    }
  });

  it('indents a nested item’s continuation line with the item', () => {
    const { getByTestId } = render(<ReadOnlyMarkdownText body={'- a\n  - b\n    c'} />);
    expect(renderedText(getByTestId('journal-markdown-item-4'))).toBe('  \u2022 b');
    expect(renderedText(getByTestId('journal-markdown-continuation-10'))).toBe('  c');
  });

  it('dims the continuation line of a checked task with it', () => {
    const { getByTestId } = render(<ReadOnlyMarkdownText body={'- [x] one\n      two'} />);
    expect(renderedText(getByTestId('journal-markdown-task-done-10'))).toBe('two');
  });
});
