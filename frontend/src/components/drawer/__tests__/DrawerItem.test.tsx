import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import DrawerItem from '@/components/drawer/DrawerItem';
import { surface } from '@/design/tokens';

afterEach(() => {
  jest.clearAllMocks();
});

describe('DrawerItem', () => {
  it('renders the label text', () => {
    const onPress = jest.fn();
    const { getByText } = render(<DrawerItem label="Quick Log" onPress={onPress} />);

    expect(getByText('Quick Log')).toBeTruthy();
  });

  it('renders the optional icon slot when given', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerItem label="Quick Log" onPress={onPress} icon={<View testID="probe-icon" />} />,
    );

    expect(getByTestId('probe-icon')).toBeTruthy();
  });

  it('exposes a button role labeled with the visible text by default', () => {
    const onPress = jest.fn();
    const { getByRole } = render(<DrawerItem label="Quick Log" onPress={onPress} />);

    expect(getByRole('button', { name: 'Quick Log' })).toBeTruthy();
  });

  it('overrides the accessibility label when one is given', () => {
    const onPress = jest.fn();
    const { getByRole, getByText } = render(
      <DrawerItem label="Quick Log" onPress={onPress} accessibilityLabel="Log a habit now" />,
    );

    expect(getByText('Quick Log')).toBeTruthy();
    const button = getByRole('button', { name: 'Log a habit now' });
    expect(button.props.accessibilityLabel).toBe('Log a habit now');
  });

  it('fires onPress when pressed', () => {
    const onPress = jest.fn();
    const { getByRole } = render(<DrawerItem label="Quick Log" onPress={onPress} />);

    fireEvent.press(getByRole('button', { name: 'Quick Log' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('supports a custom testID', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerItem label="Quick Log" onPress={onPress} testID="quick-log-item" />,
    );

    expect(getByTestId('quick-log-item')).toBeTruthy();
  });

  it('does not mark the row selected when the selected prop is omitted', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerItem label="Quick Log" onPress={onPress} testID="quick-log-item" />,
    );

    const row = getByTestId('quick-log-item');
    expect(row.props.accessibilityState?.selected).not.toBe(true);
  });

  it('marks the row selected and applies the sunken background when selected', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerItem label="Quick Log" onPress={onPress} testID="quick-log-item" selected />,
    );

    const row = getByTestId('quick-log-item');
    expect(row.props.accessibilityState.selected).toBe(true);
    const flatStyle = StyleSheet.flatten(row.props.style) as { backgroundColor?: string };
    expect(flatStyle.backgroundColor).toBe(surface.sunken);
  });
});
