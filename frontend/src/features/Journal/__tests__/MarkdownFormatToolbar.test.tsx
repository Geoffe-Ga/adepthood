/* eslint-env jest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { MarkdownCommand } from '../markdownCommands';
import MarkdownFormatToolbar from '../MarkdownFormatToolbar';

import { touchTarget } from '@/design/tokens';

const PLAIN = { bold: false, italic: false, underline: false, listLevel: null };

describe('MarkdownFormatToolbar -- inline styles', () => {
  const LABELLED: [label: string, command: MarkdownCommand][] = [
    ['Bold', 'bold'],
    ['Italic', 'italic'],
    ['Underline', 'underline'],
  ];
  it.each(LABELLED)('offers %s as a labelled button that runs the %s command', (label, command) => {
    const onCommand = jest.fn();
    const { getByRole } = render(<MarkdownFormatToolbar state={PLAIN} onCommand={onCommand} />);
    const button = getByRole('button', { name: label });
    fireEvent.press(button);
    expect(onCommand).toHaveBeenCalledWith(command);
  });

  it.each(['bold', 'italic', 'underline'] as const)(
    'marks %s selected exactly when the caret is in that style',
    (style) => {
      const { getByTestId, rerender } = render(
        <MarkdownFormatToolbar state={PLAIN} onCommand={jest.fn()} />,
      );
      expect(getByTestId(`journal-format-${style}`).props.accessibilityState).toMatchObject({
        selected: false,
      });
      rerender(<MarkdownFormatToolbar state={{ ...PLAIN, [style]: true }} onCommand={jest.fn()} />);
      expect(getByTestId(`journal-format-${style}`).props.accessibilityState).toMatchObject({
        selected: true,
      });
    },
  );

  it('gives every action at least the minimum touch target', () => {
    const { getByTestId } = render(<MarkdownFormatToolbar state={PLAIN} onCommand={jest.fn()} />);
    for (const style of ['bold', 'italic', 'underline']) {
      const flat = StyleSheet.flatten(getByTestId(`journal-format-${style}`).props.style);
      expect(flat.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(flat.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
  });

  it('is styled from Candle & Ink tokens, with no raw colour literals', () => {
    const source = readFileSync(join(__dirname, '..', 'MarkdownFormatToolbar.tsx'), 'utf8');
    expect(source).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(source).not.toMatch(/rgba?\(/iu);
  });
});

describe('MarkdownFormatToolbar -- list nesting', () => {
  it('offers Indent and Outdent only while the caret is on a list line', () => {
    const { queryByRole, rerender } = render(
      <MarkdownFormatToolbar state={PLAIN} onCommand={jest.fn()} />,
    );
    expect(queryByRole('button', { name: 'Indent list item' })).toBeNull();
    expect(queryByRole('button', { name: 'Outdent list item' })).toBeNull();

    rerender(<MarkdownFormatToolbar state={{ ...PLAIN, listLevel: 1 }} onCommand={jest.fn()} />);
    expect(queryByRole('button', { name: 'Indent list item' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Outdent list item' })).toBeTruthy();
  });

  it('disables Outdent at level 0 and enables it one level in', () => {
    const onCommand = jest.fn();
    const { getByTestId, rerender } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, listLevel: 0 }} onCommand={onCommand} />,
    );
    const outdent = () => getByTestId('journal-format-outdent');
    expect(outdent().props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(outdent());
    expect(onCommand).not.toHaveBeenCalled();
    expect(getByTestId('journal-format-indent').props.accessibilityState).toMatchObject({
      disabled: false,
    });

    rerender(<MarkdownFormatToolbar state={{ ...PLAIN, listLevel: 1 }} onCommand={onCommand} />);
    expect(outdent().props.accessibilityState).toMatchObject({ disabled: false });
    fireEvent.press(outdent());
    expect(onCommand).toHaveBeenCalledWith('outdent');
  });

  it('runs indent and keeps list actions at the minimum touch target', () => {
    const onCommand = jest.fn();
    const { getByRole, getByTestId } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, listLevel: 3 }} onCommand={onCommand} />,
    );
    fireEvent.press(getByRole('button', { name: 'Indent list item' }));
    expect(onCommand).toHaveBeenCalledWith('indent');
    for (const id of ['journal-format-indent', 'journal-format-outdent']) {
      const flat = StyleSheet.flatten(getByTestId(id).props.style);
      expect(flat.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(flat.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
  });
});
