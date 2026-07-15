import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { SessionCtaButton } from '../SessionCtaButton';

import { colors } from '@/design/tokens';

const flatten = (style: unknown): Record<string, unknown> => {
  const flattened = Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean))
    : (style as Record<string, unknown>);
  return flattened;
};

describe('SessionCtaButton', () => {
  it('renders the label text', () => {
    const { getByText } = render(
      <SessionCtaButton
        label="Begin meditation"
        testID="cta"
        accessibilityLabel="Begin meditation"
      />,
    );
    expect(getByText('Begin meditation')).toBeTruthy();
  });

  it('exposes the button accessibility role', () => {
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin" />,
    );
    expect(getByTestId('cta').props.accessibilityRole).toBe('button');
  });

  it('forwards the accessibilityLabel', () => {
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin meditation" />,
    );
    expect(getByTestId('cta').props.accessibilityLabel).toBe('Begin meditation');
  });

  it('fires onPress when enabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin" onPress={onPress} />,
    );
    fireEvent.press(getByTestId('cta'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SessionCtaButton
        label="Begin"
        testID="cta"
        accessibilityLabel="Begin"
        onPress={onPress}
        disabled
      />,
    );
    fireEvent.press(getByTestId('cta'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('dims to opacity 0.5 when disabled, via a flat style array', () => {
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin" disabled />,
    );
    const flattened = flatten(getByTestId('cta').props.style);
    expect(flattened.opacity).toBe(0.5);
  });

  it('reflects disabled in accessibilityState', () => {
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin" disabled />,
    );
    expect(getByTestId('cta').props.accessibilityState).toEqual({ disabled: true });
  });

  it('fills the background with the primary token by default', () => {
    const { getByTestId } = render(
      <SessionCtaButton label="Begin" testID="cta" accessibilityLabel="Begin" />,
    );
    const flattened = StyleSheet.flatten(getByTestId('cta').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe(colors.primary);
  });

  it('fills the background with the success token for the success variant', () => {
    const { getByTestId } = render(
      <SessionCtaButton
        label="Save session"
        testID="cta"
        accessibilityLabel="Save session and reflect"
        variant="success"
      />,
    );
    const flattened = StyleSheet.flatten(getByTestId('cta').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe(colors.success);
  });
});
