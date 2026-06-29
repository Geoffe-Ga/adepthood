/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { Button } from '../Button';

import { accent, surface, touchTarget } from '@/design/tokens';

describe('Button', () => {
  it('renders the label and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(<Button label="Save" onPress={onPress} testID="b" />);
    expect(getByText('Save')).toBeTruthy();
    fireEvent.press(getByTestId('b'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled or busy', () => {
    const onPress = jest.fn();
    const { getByTestId, rerender } = render(
      <Button label="Save" onPress={onPress} disabled testID="b" />,
    );
    fireEvent.press(getByTestId('b'));
    rerender(<Button label="Save" onPress={onPress} busy testID="b" />);
    fireEvent.press(getByTestId('b'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders each variant with its warm fill/outline', () => {
    const onPress = jest.fn();
    const flat = (variant: 'primary' | 'secondary' | 'tertiary') => {
      const { getByTestId } = render(
        <Button label="X" onPress={onPress} variant={variant} testID={variant} />,
      );
      return StyleSheet.flatten(getByTestId(variant).props.style);
    };
    expect(flat('primary').backgroundColor).toBe(accent.primary);
    expect(flat('secondary').borderColor).toBe(accent.primary);
    expect(flat('secondary').backgroundColor).toBe(surface.raised);
    expect(flat('tertiary').backgroundColor).toBe('transparent');
  });

  it('meets the 44dp minimum touch target', () => {
    const { getByTestId } = render(<Button label="X" onPress={jest.fn()} testID="b" />);
    expect(StyleSheet.flatten(getByTestId('b').props.style).minHeight).toBe(touchTarget.minimum);
  });
});
