/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

// Mock chart libraries that don't render in test env. The captured-props refs
// let branch tests inspect the color/config values computed by StatsModal
// without needing the real chart/calendar implementations.
const lastCalendarProps: { current: any } = { current: null };
const lastLineChartProps: { current: any } = { current: null };

jest.mock('react-native-calendars', () => ({
  Calendar: (props: any) => {
    lastCalendarProps.current = props;
    return null;
  },
}));
jest.mock('react-native-chart-kit', () => ({
  LineChart: (props: any) => {
    lastLineChartProps.current = props;
    return null;
  },
  BarChart: () => null,
}));

// Mock the API module
jest.mock('../../../../api', () => ({
  __esModule: true,
  habits: {
    getStats: jest.fn(),
  },
}));

// Mock HabitUtils to avoid indirect dependency issues
jest.mock('../../HabitUtils', () => ({
  generateStatsForHabit: jest.fn(() => ({
    values: [0, 0, 0, 0, 0, 0, 0],
    completionsByDay: [0, 0, 0, 0, 0, 0, 0],
    dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    longestStreak: 0,
    currentStreak: 0,
    totalCompletions: 0,
    completionRate: 0,
    completionDates: [],
  })),
  toLocalHabitStats: jest.fn((api: Record<string, unknown>) => ({
    values: api.values,
    completionsByDay: api.completions_by_day,
    dayLabels: api.day_labels,
    longestStreak: api.longest_streak,
    currentStreak: api.current_streak,
    totalCompletions: api.total_completions,
    completionRate: api.completion_rate,
    completionDates: api.completion_dates,
  })),
}));

// Import after mocks
import { habits as habitsApi } from '../../../../api';
import type { Habit, HabitStatsData } from '../../Habits.types';
import { StatsModal } from '../StatsModal';

const mockGetStats = habitsApi.getStats as jest.MockedFunction<typeof habitsApi.getStats>;

const baseHabit: Habit = {
  id: 42,
  stage: 'Beige',
  name: 'Meditation',
  icon: '🧘',
  streak: 5,
  energy_cost: 2,
  energy_return: 3,
  start_date: new Date('2024-01-01'),
  goals: [],
  completions: [],
};

const localStats: HabitStatsData = {
  values: [0, 0, 0, 0, 0, 0, 0],
  completionsByDay: [0, 0, 0, 0, 0, 0, 0],
  dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  longestStreak: 0,
  currentStreak: 0,
  totalCompletions: 0,
  completionRate: 0,
  completionDates: [],
};

describe('StatsModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when habit is null', () => {
    const { toJSON } = render(
      <StatsModal visible={true} habit={null} stats={null} onClose={jest.fn() as any} />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders the stats provided by the owner without fetching itself', () => {
    // The fetch is owned by useHabitStats (dedup); the modal only consumes the
    // result, so it must never call the API.
    const ownerStats: HabitStatsData = {
      ...localStats,
      values: [1, 3, 2, 2, 3, 2, 2],
      completionsByDay: [1, 2, 1, 2, 3, 1, 5],
      longestStreak: 7,
      currentStreak: 3,
      totalCompletions: 15,
      completionRate: 0.75,
      completionDates: ['2024-01-01', '2024-01-02', '2024-01-03'],
    };

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={ownerStats} onClose={jest.fn() as any} />,
    );

    expect(getByText('7 days')).toBeTruthy(); // longest streak
    expect(getByText('3 days')).toBeTruthy(); // current streak
    expect(getByText('75%')).toBeTruthy(); // completion rate
    expect(getByText('15')).toBeTruthy(); // total completions
    expect(mockGetStats).not.toHaveBeenCalled();
  });

  it('shows the loading state until the owner provides stats', () => {
    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={null} onClose={jest.fn() as any} />,
    );

    expect(getByText('Loading stats...')).toBeTruthy();
    expect(mockGetStats).not.toHaveBeenCalled();
  });

  it('displays habit name and icon in header', async () => {
    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={jest.fn() as any} />,
    );

    expect(getByText(/Meditation Stats/)).toBeTruthy();
    expect(getByText('🧘')).toBeTruthy();
  });

  it('calls onClose when close button is pressed', async () => {
    const onClose = jest.fn() as any;

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={onClose} />,
    );

    fireEvent.press(getByText('×'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between tabs', async () => {
    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={jest.fn() as any} />,
    );

    // Default tab is calendar
    await waitFor(() => {
      expect(getByText('Longest Streak:')).toBeTruthy();
    });

    // Switch to progress tab
    fireEvent.press(getByText('Progress'));
    expect(getByText('Units by Weekday')).toBeTruthy();

    // Switch to by-day tab
    fireEvent.press(getByText('By Day'));
    expect(getByText('Completions by Day of Week')).toBeTruthy();
  });

  it('falls back to the default calendar marker color for a stage without a design token', () => {
    const habit = { ...baseHabit, stage: 'NotARealStage' };
    const statsWithDates: HabitStatsData = { ...localStats, completionDates: ['2024-01-01'] };

    render(
      <StatsModal visible={true} habit={habit} stats={statsWithDates} onClose={jest.fn() as any} />,
    );

    expect(lastCalendarProps.current.markedDates['2024-01-01'].selectedColor).toBe('#50cebb');
  });

  it('falls back to the default chart color for a stage without a design token', () => {
    const habit = { ...baseHabit, stage: 'NotARealStage' };

    const { getByText } = render(
      <StatsModal visible={true} habit={habit} stats={localStats} onClose={jest.fn() as any} />,
    );
    fireEvent.press(getByText('Progress'));

    expect(lastLineChartProps.current.chartConfig.color()).toBe('rgba(134, 65, 244, 1)');
  });

  it('does not fetch when not visible', () => {
    render(
      <StatsModal
        visible={false}
        habit={baseHabit}
        stats={localStats}
        onClose={jest.fn() as any}
      />,
    );

    expect(mockGetStats).not.toHaveBeenCalled();
  });
});
