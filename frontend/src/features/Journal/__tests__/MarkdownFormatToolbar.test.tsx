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

const PLAIN = { bold: false, italic: false, underline: false };

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
