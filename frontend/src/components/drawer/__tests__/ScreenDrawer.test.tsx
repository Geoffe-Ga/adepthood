import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import type { ScaledSize } from 'react-native';

const mockUseReducedMotion = jest.fn<() => boolean>();
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

import ScreenDrawer from '@/components/drawer/ScreenDrawer';

const DEFAULT_DIMENSIONS: ScaledSize = { width: 390, height: 844, scale: 2, fontScale: 1 };

type AnimatedNode = { __getValue: () => number };

type WindowDimensionsSpy = ReturnType<typeof jest.spyOn>;
let dimensionsSpy: WindowDimensionsSpy;

const setDimensions = (dimensions: ScaledSize): void => {
  dimensionsSpy.mockReturnValue(dimensions);
};

beforeEach(() => {
  const rn = require('react-native') as { useWindowDimensions: () => ScaledSize };
  dimensionsSpy = jest.spyOn(rn, 'useWindowDimensions').mockReturnValue(DEFAULT_DIMENSIONS);
  mockUseReducedMotion.mockReturnValue(false);
});

afterEach(() => {
  dimensionsSpy.mockRestore();
  jest.clearAllMocks();
});

describe('ScreenDrawer', () => {
  it('renders nothing when not visible', () => {
    const onClose = jest.fn();
    const { queryByText, queryByTestId } = render(
      <ScreenDrawer visible={false} onClose={onClose} screenName="Habits">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    expect(queryByText('Drawer body')).toBeNull();
    expect(queryByTestId('screen-drawer-scrim')).toBeNull();
  });

  it('renders the title and children when visible', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Habits" title="Menu">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    expect(getByText('Menu')).toBeTruthy();
    expect(getByText('Drawer body')).toBeTruthy();
  });

  it('omits the title when none is given', () => {
    const onClose = jest.fn();
    const { getByText, queryByText } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Habits">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    expect(getByText('Drawer body')).toBeTruthy();
    expect(queryByText('Menu')).toBeNull();
  });

  it('exposes the scrim as a labeled close control that fires onClose when pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Journal">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    const scrim = getByTestId('screen-drawer-scrim');
    expect(scrim.props.accessibilityRole).toBe('button');
    expect(scrim.props.accessibilityLabel).toBe('Close Journal menu');

    fireEvent.press(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when the Modal reports an Android back request', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Journal">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    const modal = getByTestId('screen-drawer');
    modal.props.onRequestClose();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('defaults the Modal testID to screen-drawer and accepts an override', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Journal" testID="journal-drawer">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    expect(getByTestId('journal-drawer')).toBeTruthy();
  });

  describe('panel width clamping', () => {
    it('sizes the panel to 80% of a narrow viewport', () => {
      setDimensions({ width: 320, height: 640, scale: 2, fontScale: 1 });
      const onClose = jest.fn();
      const { getByTestId } = render(
        <ScreenDrawer visible onClose={onClose} screenName="Habits">
          <Text>Drawer body</Text>
        </ScreenDrawer>,
      );

      const panel = getByTestId('screen-drawer-panel');
      const flatStyle = StyleSheet.flatten(panel.props.style) as { width?: number };
      expect(flatStyle.width).toBe(256);
    });

    it('clamps the panel width to 320 on a wide viewport', () => {
      setDimensions({ width: 1200, height: 800, scale: 2, fontScale: 1 });
      const onClose = jest.fn();
      const { getByTestId } = render(
        <ScreenDrawer visible onClose={onClose} screenName="Habits">
          <Text>Drawer body</Text>
        </ScreenDrawer>,
      );

      const panel = getByTestId('screen-drawer-panel');
      const flatStyle = StyleSheet.flatten(panel.props.style) as { width?: number };
      expect(flatStyle.width).toBe(320);
    });
  });

  it('snaps the panel to the open position without animating under reduced motion', () => {
    mockUseReducedMotion.mockReturnValue(true);
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ScreenDrawer visible onClose={onClose} screenName="Habits">
        <Text>Drawer body</Text>
      </ScreenDrawer>,
    );

    const panel = getByTestId('screen-drawer-panel');
    const flatStyle = StyleSheet.flatten(panel.props.style) as {
      transform?: Array<{ translateX: number | AnimatedNode }>;
    };
    const transforms = flatStyle.transform;
    if (transforms === undefined || transforms[0] === undefined) {
      throw new Error('expected a translateX transform on the panel');
    }
    const translateX = transforms[0].translateX;
    const value = typeof translateX === 'number' ? translateX : translateX.__getValue();
    expect(value).toBe(0);
  });
});
