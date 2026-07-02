import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { SaveButton } from '../SaveButton';

import { colors } from '@/design/tokens';

const flatten = (style: unknown): Record<string, unknown> => {
  const flattened = Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean))
    : (style as Record<string, unknown>);
  return flattened;
};

describe('SaveButton', () => {
  it('renders the label text', () => {
    const { getByText } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
      />,
    );
    expect(getByText('Save session')).toBeTruthy();
  });

  it('exposes the button accessibility role', () => {
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
      />,
    );
    expect(getByTestId('save-probe').props.accessibilityRole).toBe('button');
  });

  it('forwards the accessibilityLabel', () => {
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
      />,
    );
    expect(getByTestId('save-probe').props.accessibilityLabel).toBe('Save session and reflect');
  });

  it('fires onPress when enabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
        onPress={onPress}
      />,
    );
    fireEvent.press(getByTestId('save-probe'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
        onPress={onPress}
        disabled
      />,
    );
    fireEvent.press(getByTestId('save-probe'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('dims to opacity 0.5 when disabled, via a flat style array', () => {
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
        disabled
      />,
    );
    const flattened = flatten(getByTestId('save-probe').props.style);
    expect(flattened.opacity).toBe(0.5);
  });

  it('reflects disabled in accessibilityState', () => {
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
        disabled
      />,
    );
    expect(getByTestId('save-probe').props.accessibilityState).toEqual({ disabled: true });
  });

  it('fills the background with the success token', () => {
    const { getByTestId } = render(
      <SaveButton
        label="Save session"
        testID="save-probe"
        accessibilityLabel="Save session and reflect"
      />,
    );
    const flattened = StyleSheet.flatten(getByTestId('save-probe').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe(colors.success);
  });
});
