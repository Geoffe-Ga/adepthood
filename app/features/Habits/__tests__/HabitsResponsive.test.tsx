/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, afterEach, it, expect } from '@jest/globals';

const HabitsScreen = require('../HabitsScreen').default;

const renderer = require('react-test-renderer');

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (jest.fn() as any).mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn() as any,
  scheduleNotificationAsync: jest.fn() as any,
  cancelScheduledNotificationAsync: jest.fn() as any,
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
      jest
        .spyOn(require('react-native'), 'useWindowDimensions')
        .mockReturnValue({ width: w, height: w > 800 ? 600 : 800, scale: 1, fontScale: 1 });

      const tree = renderer.create(<HabitsScreen />).root;
      const list = tree.findByProps({ testID: 'habits-list' });
      const expectedColumns = w > (w > 800 ? 600 : 800) ? 2 : 1;
      expect(list.props.numColumns).toBe(expectedColumns);
      expect(list.props.horizontal).not.toBe(true);
      const fills = tree.findAllByProps({ testID: 'progress-fill' });
      fills.forEach((p: any) => {
        const widthStyle = Array.isArray(p.props.style)
          ? p.props.style[1].width
          : p.props.style.width;
        const val = parseFloat(widthStyle);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
      });
    });
  });
});
