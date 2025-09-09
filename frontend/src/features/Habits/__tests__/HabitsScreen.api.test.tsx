/* eslint-env jest */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { getHabits, createHabit, updateHabit, deleteHabit } from '../../../api/habits';
import HabitsScreen from '../HabitsScreen';

jest.mock('../../../api/habits');

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
jest.mock('../components/MissedDaysModal', () => () => null);
jest.mock('../components/ReorderHabitsModal', () => () => null);
jest.mock('../components/StatsModal', () => () => null);
jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

jest.mock('../components/OnboardingModal', () => {
  const { TouchableOpacity } = require('react-native');
  return ({ visible, onSaveHabits }: any) =>
    visible ? (
      <TouchableOpacity
        testID="trigger-onboarding-save"
        onPress={() =>
          onSaveHabits([
            {
              id: 'temp',
              name: 'New',
              icon: '🔥',
              energy_cost: 1,
              energy_return: 1,
              stage: 'Beige',
              start_date: new Date(),
            },
          ])
        }
      />
    ) : null;
});

jest.mock('../components/HabitSettingsModal', () => {
  const { TouchableOpacity } = require('react-native');
  return ({ onUpdate, onDelete }: any) => (
    <>
      <TouchableOpacity
        testID="trigger-update"
        onPress={() =>
          onUpdate({
            id: 1,
            stage: 'Beige',
            name: 'Updated',
            icon: '🔥',
            streak: 0,
            energy_cost: 0,
            energy_return: 0,
            start_date: new Date(),
            goals: [],
          })
        }
      />
      <TouchableOpacity testID="trigger-delete" onPress={() => onDelete(1)} />
    </>
  );
});

const mockGetHabits = getHabits as unknown as jest.Mock;
const mockCreateHabit = createHabit as unknown as jest.Mock;
const mockUpdateHabit = updateHabit as unknown as jest.Mock;
const mockDeleteHabit = deleteHabit as unknown as jest.Mock;

describe('HabitsScreen API interactions', () => {
  beforeEach(() => {
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 400, height: 800, scale: 1, fontScale: 1 });
    jest.clearAllMocks();
  });

  it('fetches habits on mount', async () => {
    (mockGetHabits as any).mockResolvedValue([
      {
        id: 1,
        stage: 'Beige',
        name: 'Test',
        icon: '🔥',
        streak: 0,
        energy_cost: 0,
        energy_return: 0,
        start_date: new Date(),
        goals: [] as any,
      },
    ]);

    render(<HabitsScreen />);
    await waitFor(() => expect(mockGetHabits).toHaveBeenCalled());
  });

  it('creates habits from onboarding', async () => {
    (mockGetHabits as any).mockResolvedValue([]);
    (mockCreateHabit as any).mockResolvedValue({
      id: 1,
      stage: 'Beige',
      name: 'New',
      icon: '🔥',
      streak: 0,
      energy_cost: 1,
      energy_return: 1,
      start_date: new Date(),
      goals: [] as any,
    });

    const { getByTestId } = render(<HabitsScreen />);
    await waitFor(() => expect(mockGetHabits).toHaveBeenCalled());
    fireEvent.press(getByTestId('trigger-onboarding-save'));
    await waitFor(() => expect(mockCreateHabit).toHaveBeenCalled());
  });

  it('updates and deletes habits', async () => {
    (mockGetHabits as any).mockResolvedValue([
      {
        id: 1,
        stage: 'Beige',
        name: 'Test',
        icon: '🔥',
        streak: 0,
        energy_cost: 0,
        energy_return: 0,
        start_date: new Date(),
        goals: [] as any,
      },
    ]);
    (mockUpdateHabit as any).mockResolvedValue({
      id: 1,
      stage: 'Beige',
      name: 'Updated',
      icon: '🔥',
      streak: 0,
      energy_cost: 0,
      energy_return: 0,
      start_date: new Date(),
      goals: [] as any,
    });
    (mockDeleteHabit as any).mockResolvedValue(undefined);

    const { getByTestId } = render(<HabitsScreen />);
    await waitFor(() => expect(mockGetHabits).toHaveBeenCalled());

    fireEvent.press(getByTestId('trigger-update'));
    await waitFor(() => expect(mockUpdateHabit).toHaveBeenCalled());

    fireEvent.press(getByTestId('trigger-delete'));
    await waitFor(() => expect(mockDeleteHabit).toHaveBeenCalled());
  });
});
