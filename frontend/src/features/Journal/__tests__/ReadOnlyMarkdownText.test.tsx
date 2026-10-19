import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import ReadOnlyMarkdownText, {
  JOURNAL_ORDINAL_PAD,
  JOURNAL_TASK_GLYPHS,
} from '../ReadOnlyMarkdownText';

import { colors, editorialType } from '@/design/tokens';

type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

/** Every string leaf under a node, verbatim, in render order. */
function renderedText(node: RenderedNode): string {
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

describe('ReadOnlyMarkdownText -- block dialect (#3251)', () => {
  it('stays one Text for a body without a rule', () => {
    const { getByTestId } = render(
      <ReadOnlyMarkdownText
        body={'## Day\n1. a\n- [x] b'}
        style={{ color: 'red' }}
        testID="flat"
      />,
    );
    const flat = getByTestId('flat');
    expect(StyleSheet.flatten(flat.props.style).color).toBe('red');
    expect(renderedText(flat)).toBe(
      `Day\n${JOURNAL_ORDINAL_PAD}1. a\n${JOURNAL_TASK_GLYPHS.done} b`,
    );
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
