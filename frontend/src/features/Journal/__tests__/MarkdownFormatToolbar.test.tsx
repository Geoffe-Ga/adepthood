/* eslint-env jest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { MarkdownCommand } from '../markdownCommands';
import MarkdownFormatToolbar from '../MarkdownFormatToolbar';

import { colors, touchTarget } from '@/design/tokens';

/** WCAG 1.4.11: a state indicator is a non-text UI component. */
const NON_TEXT_CONTRAST = 3;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

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

describe('MarkdownFormatToolbar -- pressed state for assistive technology and sight', () => {
  const Platform = require('react-native').Platform as { OS: string };
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('exposes each style toggle as aria-pressed on web, which reads no accessibilityState', () => {
    Platform.OS = 'web';
    const { getByTestId } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, bold: true }} onCommand={jest.fn()} />,
    );
    expect(getByTestId('journal-format-bold').props['aria-pressed']).toBe(true);
    expect(getByTestId('journal-format-italic').props['aria-pressed']).toBe(false);
    expect(getByTestId('journal-format-underline').props['aria-pressed']).toBe(false);
  });

  it('leaves list actions without a pressed state: they are commands, not toggles', () => {
    Platform.OS = 'web';
    const { getByTestId } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, listLevel: 1 }} onCommand={jest.fn()} />,
    );
    expect(getByTestId('journal-format-indent').props['aria-pressed']).toBeUndefined();
  });

  it('keeps native on accessibilityState alone', () => {
    Platform.OS = 'ios';
    const { getByTestId } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, bold: true }} onCommand={jest.fn()} />,
    );
    expect(getByTestId('journal-format-bold').props['aria-pressed']).toBeUndefined();
  });

  it('marks the pressed state with an ink bar at 3:1 or better against the page', () => {
    const { getByTestId } = render(
      <MarkdownFormatToolbar state={{ ...PLAIN, bold: true }} onCommand={jest.fn()} />,
    );
    const on = StyleSheet.flatten(getByTestId('journal-format-bold').props.style);
    const off = StyleSheet.flatten(getByTestId('journal-format-italic').props.style);
    expect(on.borderBottomWidth).toBeGreaterThan(0);
    expect(off.borderBottomWidth).toBe(on.borderBottomWidth);
    expect(off.borderBottomColor).toBe('transparent');
    expect(contrast(String(on.borderBottomColor), colors.paper.background)).toBeGreaterThanOrEqual(
      NON_TEXT_CONTRAST,
    );
  });
});
