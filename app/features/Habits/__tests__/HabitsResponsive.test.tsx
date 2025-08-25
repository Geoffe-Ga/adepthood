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
jest.mock('../components/StatsModal', () => () => null);

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

        expect(tileHeight).toBeLessThanOrEqual(height / 5);
        expect(colorValues).toContain(style.borderColor);

        const fill = t.findByProps({ testID: 'progress-fill' });
        const fillStyle = Array.isArray(fill.props.style) ? fill.props.style[1] : fill.props.style;
        const val = parseFloat(fillStyle.width);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
        expect(fillStyle.backgroundColor).toBe(style.borderColor);
      });
    });
  });
});
