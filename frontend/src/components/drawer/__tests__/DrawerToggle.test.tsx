import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import DrawerToggle from '@/components/drawer/DrawerToggle';

afterEach(() => {
  jest.clearAllMocks();
});

describe('DrawerToggle', () => {
  it('mounts the lucide Menu icon without throwing', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerToggle screenName="Habits" expanded={false} onPress={onPress} />,
    );

    expect(getByTestId('drawer-toggle')).toBeTruthy();
  });

  it('labels the toggle with the screen name', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerToggle screenName="Journal" expanded={false} onPress={onPress} />,
    );

    const toggle = getByTestId('drawer-toggle');
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityLabel).toBe('Open Journal menu');
  });

  it('reflects expanded=false in accessibilityState', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerToggle screenName="Journal" expanded={false} onPress={onPress} />,
    );

    expect(getByTestId('drawer-toggle').props.accessibilityState).toEqual({ expanded: false });
  });

  it('reflects expanded=true in accessibilityState after a rerender', () => {
    const onPress = jest.fn();
    const { getByTestId, rerender } = render(
      <DrawerToggle screenName="Journal" expanded={false} onPress={onPress} />,
    );

    rerender(<DrawerToggle screenName="Journal" expanded onPress={onPress} />);

    expect(getByTestId('drawer-toggle').props.accessibilityState).toEqual({ expanded: true });
  });

  it('fires onPress when pressed', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerToggle screenName="Habits" expanded={false} onPress={onPress} />,
    );

    fireEvent.press(getByTestId('drawer-toggle'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('supports a custom testID', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <DrawerToggle
        screenName="Habits"
        expanded={false}
        onPress={onPress}
        testID="habits-drawer-toggle"
      />,
    );

    expect(getByTestId('habits-drawer-toggle')).toBeTruthy();
  });
});
