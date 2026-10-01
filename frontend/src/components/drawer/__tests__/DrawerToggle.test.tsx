import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { PanelLeftOpen } from 'lucide-react-native';
import React from 'react';
import { Platform } from 'react-native';

import { decorativeHidden } from '@/components/a11yHidden';
import DrawerToggle from '@/components/drawer/DrawerToggle';

const originalOS = Platform.OS;

function asPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => {
  jest.clearAllMocks();
  asPlatform(originalOS);
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

  it('hides its glyph from every reader and keeps its name, role and state (#2829)', () => {
    const { getByRole, UNSAFE_getByType, rerender } = render(
      <DrawerToggle screenName="Journal" expanded={false} onPress={jest.fn()} />,
    );
    expect(UNSAFE_getByType(PanelLeftOpen).props).toMatchObject(decorativeHidden());
    expect(getByRole('button', { name: 'Open Journal menu', expanded: false })).toBeTruthy();
    rerender(<DrawerToggle screenName="Journal" expanded onPress={jest.fn()} />);
    expect(getByRole('button', { name: 'Open Journal menu', expanded: true })).toBeTruthy();
  });

  it('hands the web svg aria-hidden alone, never the DOM-invalid accessible (#2829)', () => {
    asPlatform('web');
    const { UNSAFE_getByType } = render(
      <DrawerToggle screenName="Journal" expanded={false} onPress={jest.fn()} />,
    );
    const glyph = UNSAFE_getByType(PanelLeftOpen);
    expect(glyph.props['aria-hidden']).toBe(true);
    expect(glyph.props).not.toHaveProperty('accessible');
    expect(glyph.props).not.toHaveProperty('accessibilityElementsHidden');
    expect(glyph.props).not.toHaveProperty('importantForAccessibility');
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
