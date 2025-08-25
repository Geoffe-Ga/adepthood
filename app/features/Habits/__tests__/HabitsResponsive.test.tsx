/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, afterEach, it, expect } from '@jest/globals';

import { STAGE_COLORS } from '../../../constants/stageColors';

const HabitsScreen = require('../HabitsScreen').default;

const renderer = require('react-test-renderer');

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
  getExpoPushTokenAsync: (jest.fn() as any).mockResolvedValue({ data: 'token' }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children }: { children: any }) => <>{children}</>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../components/GoalModal', () => () => null);
jest.mock('../components/HabitSettingsModal', () => () => null);
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/OnboardingModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

const widths = [320, 390, 600, 900, 1200];

describe('HabitsScreen responsive layout', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  widths.forEach((w) => {
    it(`renders correctly at width ${w}`, () => {
      const height = w > 800 ? 600 : 800;
      jest
        .spyOn(require('react-native'), 'useWindowDimensions')
        .mockReturnValue({ width: w, height, scale: 1, fontScale: 1 });

      const tree = renderer.create(<HabitsScreen />).root;
      const list = tree.findByProps({ testID: 'habits-list' });
      const expectedColumns = w > height ? 2 : 1;
      expect(list.props.numColumns).toBe(expectedColumns);
      expect(list.props.horizontal).not.toBe(true);

      const tiles = tree.findAllByProps({ testID: 'habit-tile' });
      const colorValues = Object.values(STAGE_COLORS);

      tiles.forEach((t: any) => {
        const style = Array.isArray(t.props.style)
          ? t.props.style.reduce((acc: any, s: any) => ({ ...acc, ...s }), {})
          : t.props.style;

        const tileHeight =
          (style.minHeight ?? 0) + 2 * (style.padding ?? 0) + 2 * (style.margin ?? 0);

        const maxTileHeight = (height * expectedColumns) / 10;
        expect(tileHeight).toBeLessThanOrEqual(maxTileHeight);
        if (expectedColumns === 2) {
          expect(style.flex).toBe(1);
        }
        expect(colorValues).toContain(style.borderColor);

        const fill = t.findByProps({ testID: 'progress-fill' });
        const fillStyle = Array.isArray(fill.props.style) ? fill.props.style[1] : fill.props.style;
        const val = parseFloat(fillStyle.width);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
        expect(fillStyle.backgroundColor).toBe(style.borderColor);
      });

      const iconTopExpected = expectedColumns === 2 && w / expectedColumns >= 400;
      const iconTopNodes = tree.findAllByProps({ testID: 'habit-icon-top' });
      if (iconTopExpected) {
        expect(iconTopNodes.length).toBeGreaterThan(0);
      } else {
        expect(iconTopNodes.length).toBe(0);
      }
    });
  });

  it('remounts list when column count changes', () => {
    const dimSpy = jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 900, height: 600, scale: 1, fontScale: 1 });

    const { FlatList } = require('react-native');
    const testRenderer = renderer.create(<HabitsScreen />);
    const firstList = testRenderer.root.findByType(FlatList);
    expect(firstList.props.numColumns).toBe(2);

    dimSpy.mockReturnValue({ width: 320, height: 800, scale: 1, fontScale: 1 });

    expect(() => {
      renderer.act(() => {
        testRenderer.update(<HabitsScreen />);
      });
    }).not.toThrow();

    const secondList = testRenderer.root.findByType(FlatList);
    expect(secondList.props.numColumns).toBe(1);
  });

  it('renders overflow menu above tiles', () => {
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 900, height: 600, scale: 1, fontScale: 1 });

    const testRenderer = renderer.create(<HabitsScreen />);
    const { StyleSheet } = require('react-native');
    const wrapper = testRenderer.root.findByProps({ testID: 'overflow-menu-wrapper' });
    const wrapperStyle = StyleSheet.flatten(wrapper.props.style);
    expect(wrapperStyle.position).toBe('absolute');
    expect(wrapperStyle.zIndex).toBeGreaterThan(0);

    const toggle = testRenderer.root.findByProps({ testID: 'overflow-menu-toggle' });

    renderer.act(() => {
      toggle.props.onPress();
    });

    const menu = testRenderer.root.findByProps({ testID: 'overflow-menu' });
    const style = Array.isArray(menu.props.style)
      ? menu.props.style.reduce((acc: any, s: any) => ({ ...acc, ...s }), {})
      : menu.props.style;

    expect(style.zIndex).toBeGreaterThan(0);
  });

  it('opens stats modal when stats mode is enabled', () => {
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 900, height: 600, scale: 1, fontScale: 1 });

    const StatsModal = require('../components/StatsModal').default as jest.Mock;

    const testRenderer = renderer.create(<HabitsScreen />);
    const toggle = testRenderer.root.findByProps({ testID: 'overflow-menu-toggle' });

    renderer.act(() => {
      toggle.props.onPress();
    });

    const { TouchableOpacity, Text } = require('react-native');
    const options = testRenderer.root.findAll(
      (n: any) =>
        n.type === TouchableOpacity &&
        n.findAllByType(Text).some((t: any) => t.props.children === 'Stats'),
    );
    renderer.act(() => {
      options[0].props.onPress();
    });

    const tiles = testRenderer.root.findAllByProps({ testID: 'habit-tile' });
    renderer.act(() => {
      tiles[0].props.onPress();
    });

    expect(StatsModal).toHaveBeenCalled();
    const call = StatsModal.mock.calls.pop() as any;
    expect(call?.[0].visible).toBe(true);
  });

  it('archives energy scaffolding button into menu', () => {
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 900, height: 600, scale: 1, fontScale: 1 });

    const { Text } = require('react-native');
    const testRenderer = renderer.create(<HabitsScreen />);
    const archive = testRenderer.root.findByProps({ testID: 'archive-energy-cta' });

    jest.useFakeTimers();
    renderer.act(() => {
      archive.props.onPress();
    });

    const texts = testRenderer.root.findAllByType(Text).map((t: any) => t.props.children);
    expect(texts).not.toContain('Perform Energy Scaffolding');
    expect(texts).toContain('Energy Scaffolding button moved to menu.');

    renderer.act(() => {
      jest.advanceTimersByTime(3000);
    });

    const postTimerTexts = testRenderer.root.findAllByType(Text).map((t: any) => t.props.children);
    expect(postTimerTexts).not.toContain('Energy Scaffolding button moved to menu.');

    const toggle = testRenderer.root.findByProps({ testID: 'overflow-menu-toggle' });
    renderer.act(() => {
      toggle.props.onPress();
    });

    const hasMenuItem = testRenderer.root
      .findAllByType(Text)
      .some((t: any) => t.props.children === 'Energy Scaffolding');
    expect(hasMenuItem).toBe(true);
    jest.useRealTimers();
  });
});
