/* eslint-env jest */
/* eslint-disable import/order */
import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';

import type { Habit, Goal } from '../Habits.types';
// ---------------------------------------------------------------------------
// Mocks — set up before importing the component under test
// ---------------------------------------------------------------------------

const mockLoadHabits = jest.fn();
const mockLogUnit = jest.fn();
const mockUpdateGoal = jest.fn();
const mockUpdateHabit = jest.fn();
const mockDeleteHabit = jest.fn();
const mockSaveHabitOrder = jest.fn();
const mockBackfillMissedDays = jest.fn();
const mockSetNewStartDate = jest.fn();
const mockOnboardingSave = jest.fn();
const mockIconPress = jest.fn();
const mockEmojiSelect = jest.fn();
const mockSetSelectedHabit = jest.fn();
const mockSetMode = jest.fn();

const sampleGoals: Goal[] = [
  {
    id: 1,
    tier: 'low',
    title: 'Low Goal',
    target: 1,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 2,
    tier: 'clear',
    title: 'Clear Goal',
    target: 2,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
  {
    id: 3,
    tier: 'stretch',
    title: 'Stretch Goal',
    target: 3,
    target_unit: 'units',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  },
];

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 5,
  energy_cost: 2,
  energy_return: 5,
  start_date: new Date('2025-01-01'),
  goals: sampleGoals,
  completions: [],
  revealed: true,
  ...overrides,
});

let mockHabits: Habit[] = [];
let mockMode: string = 'normal';

jest.mock('../hooks/useHabits', () => ({
  useHabits: () => ({
    habits: mockHabits,
    loading: false,
    error: null,
    selectedHabit: null,
    setSelectedHabit: mockSetSelectedHabit,
    mode: mockMode,
    setMode: mockSetMode,
    actions: {
      loadHabits: mockLoadHabits,
      logUnit: mockLogUnit,
      updateGoal: mockUpdateGoal,
      updateHabit: mockUpdateHabit,
      deleteHabit: mockDeleteHabit,
      saveHabitOrder: mockSaveHabitOrder,
      backfillMissedDays: mockBackfillMissedDays,
      setNewStartDate: mockSetNewStartDate,
      onboardingSave: mockOnboardingSave,
      iconPress: mockIconPress,
      emojiSelect: mockEmojiSelect,
    },
    ui: {
      showEnergyCTA: false,
      showArchiveMessage: false,
      archiveEnergyCTA: jest.fn(),
      emojiHabitIndex: null,
    },
  }),
}));

jest.mock('../hooks/useModalCoordinator', () => ({
  useModalCoordinator: () => ({
    goal: false,
    stats: false,
    settings: false,
    reorder: false,
    missedDays: false,
    onboarding: false,
    emojiPicker: false,
    menu: false,
    open: jest.fn(),
    close: jest.fn(),
    closeAll: jest.fn(),
    toggleMenu: jest.fn(),
  }),
}));

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => ({ onUpdate: jest.fn(), onEnd: jest.fn() }) },
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View', createAnimatedComponent: (c: unknown) => c },
  useSharedValue: () => ({ value: 0 }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
}));

jest.mock('../../../api', () => ({
  goalGroups: { list: jest.fn(() => Promise.resolve([])) },
}));

jest.mock('../../../storage/habitStorage', () => ({
  saveHabits: jest.fn(() => Promise.resolve(undefined)),
  loadHabits: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@react-native-community/slider', () => {
  const { View } = require('react-native');
  return (props: { testID?: string }) => <View testID={props.testID} />;
});
jest.mock('react-native-calendars', () => ({
  Calendar: 'Calendar',
}));
jest.mock('react-native-chart-kit', () => ({
  LineChart: 'LineChart',
  BarChart: 'BarChart',
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));

// Must import AFTER mocks
import HabitsScreen from '../HabitsScreen';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HabitsScreen integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMode = 'normal';
    mockHabits = [
      makeHabit({ id: 1, name: 'Meditation', icon: '🧘' }),
      makeHabit({ id: 2, name: 'Exercise', icon: '🏃' }),
    ];
  });

  it('renders habit tiles from the habits list', () => {
    const { getAllByTestId } = render(<HabitsScreen />);
    const tiles = getAllByTestId('habit-tile');
    expect(tiles).toHaveLength(2);
  });

  it('renders the overflow menu toggle', () => {
    const { getByTestId } = render(<HabitsScreen />);
    expect(getByTestId('overflow-menu-toggle')).toBeTruthy();
  });

  it('shows exit button when in a non-normal mode', () => {
    mockMode = 'quickLog';
    const { getByTestId, getByText } = render(<HabitsScreen />);
    expect(getByTestId('exit-mode')).toBeTruthy();
    expect(getByText('Quick Log Mode')).toBeTruthy();
  });

  it('shows stats mode banner when mode is stats', () => {
    mockMode = 'stats';
    const { getByText } = render(<HabitsScreen />);
    expect(getByText('Stats Mode')).toBeTruthy();
  });

  it('shows edit mode banner when mode is edit', () => {
    mockMode = 'edit';
    const { getByText } = render(<HabitsScreen />);
    expect(getByText('Edit Mode')).toBeTruthy();
  });

  it('does not show unrevealed habits', () => {
    mockHabits = [makeHabit({ id: 1, revealed: true }), makeHabit({ id: 2, revealed: false })];
    const { getAllByTestId } = render(<HabitsScreen />);
    expect(getAllByTestId('habit-tile')).toHaveLength(1);
  });
});
