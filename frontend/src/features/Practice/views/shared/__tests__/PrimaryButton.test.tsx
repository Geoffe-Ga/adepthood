import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { PrimaryButton } from '../PrimaryButton';

import { colors } from '@/design/tokens';

const flatten = (style: unknown): Record<string, unknown> => {
  const flattened = Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean))
    : (style as Record<string, unknown>);
  return flattened;
};

describe('PrimaryButton', () => {
  it('renders the label text', () => {
    const { getByText } = render(
      <PrimaryButton
        label="Begin meditation"
        testID="primary-probe"
        accessibilityLabel="Begin meditation"
      />,
    );
    expect(getByText('Begin meditation')).toBeTruthy();
  });

  it('exposes the button accessibility role', () => {
    const { getByTestId } = render(
      <PrimaryButton label="Begin" testID="primary-probe" accessibilityLabel="Begin" />,
    );
    expect(getByTestId('primary-probe').props.accessibilityRole).toBe('button');
  });

  it('forwards the accessibilityLabel', () => {
    const { getByTestId } = render(
      <PrimaryButton label="Begin" testID="primary-probe" accessibilityLabel="Begin meditation" />,
    );
    expect(getByTestId('primary-probe').props.accessibilityLabel).toBe('Begin meditation');
  });

  it('fires onPress when enabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PrimaryButton
        label="Begin"
        testID="primary-probe"
        accessibilityLabel="Begin"
        onPress={onPress}
      />,
    );
    fireEvent.press(getByTestId('primary-probe'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <PrimaryButton
        label="Begin"
        testID="primary-probe"
        accessibilityLabel="Begin"
        onPress={onPress}
        disabled
      />,
    );
    fireEvent.press(getByTestId('primary-probe'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('dims to opacity 0.5 when disabled, via a flat style array', () => {
    const { getByTestId } = render(
      <PrimaryButton label="Begin" testID="primary-probe" accessibilityLabel="Begin" disabled />,
    );
    const flattened = flatten(getByTestId('primary-probe').props.style);
    expect(flattened.opacity).toBe(0.5);
  });

  it('reflects disabled in accessibilityState', () => {
    const { getByTestId } = render(
      <PrimaryButton label="Begin" testID="primary-probe" accessibilityLabel="Begin" disabled />,
    );
    expect(getByTestId('primary-probe').props.accessibilityState).toEqual({ disabled: true });
  });

  it('fills the background with the primary token', () => {
    const { getByTestId } = render(
      <PrimaryButton label="Begin" testID="primary-probe" accessibilityLabel="Begin" />,
    );
    const flattened = StyleSheet.flatten(getByTestId('primary-probe').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe(colors.primary);
  });
});
