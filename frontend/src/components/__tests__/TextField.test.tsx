/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { TextField } from '../TextField';

import { accent, colors, ink, surface, touchTarget } from '@/design/tokens';

describe('TextField', () => {
  it('forwards onChangeText and renders the value', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <TextField testID="f" value="hi" onChangeText={onChangeText} placeholder="Email" />,
    );
    fireEvent.changeText(getByTestId('f'), 'there');
    expect(onChangeText).toHaveBeenCalledWith('there');
  });

  it('uses the warm ground, ink text, and ink.muted placeholder at 44dp', () => {
    const { getByTestId } = render(<TextField testID="f" placeholder="Email" />);
    const field = getByTestId('f');
    expect(field.props.placeholderTextColor).toBe(ink.muted);
    const flat = StyleSheet.flatten(field.props.style);
    expect(flat.color).toBe(ink.primary);
    expect(flat.backgroundColor).toBe(surface.raised);
    expect(flat.minHeight).toBe(touchTarget.minimum);
  });

  it('uses the bevel ground for the recessed variant', () => {
    const { getByTestId } = render(<TextField testID="f" recessed />);
    expect(StyleSheet.flatten(getByTestId('f').props.style).backgroundColor).toBe(
      colors.bevel.recessedSurface,
    );
  });

  it('shows a terracotta focus border on focus', () => {
    const { getByTestId } = render(<TextField testID="f" />);
    fireEvent(getByTestId('f'), 'focus');
    expect(StyleSheet.flatten(getByTestId('f').props.style).borderColor).toBe(accent.primary);
  });
});
