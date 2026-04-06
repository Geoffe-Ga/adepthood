/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

// Mock chart libraries that don't render in test env
jest.mock('react-native-calendars', () => ({
  Calendar: () => null,
}));
jest.mock('react-native-chart-kit', () => ({
  LineChart: () => null,
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
    dates: [],
    values: [0, 0, 0, 0, 0, 0, 0],
    completionsByDay: [0, 0, 0, 0, 0, 0, 0],
    dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    longestStreak: 0,
    currentStreak: 0,
    totalCompletions: 0,
    completionRate: 0,
    completionDates: [],
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
  dates: [],
  values: [0, 0, 0, 0, 0, 0, 0],
  completionsByDay: [0, 0, 0, 0, 0, 0, 0],
  dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  longestStreak: 0,
  currentStreak: 0,
  totalCompletions: 0,
  completionRate: 0,
  completionDates: [],
};

const apiResponse = {
  day_labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  values: [1, 3, 2, 2, 3, 2, 2],
  completions_by_day: [1, 1, 1, 1, 1, 1, 1],
  longest_streak: 7,
  current_streak: 3,
  total_completions: 15,
  completion_rate: 0.75,
  completion_dates: ['2024-01-01', '2024-01-02', '2024-01-03'],
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

  it('fetches stats from API when opened', async () => {
    (mockGetStats as any).mockResolvedValueOnce(apiResponse);

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={jest.fn() as any} />,
    );

    // Should show loading state
    expect(getByText('Loading stats...')).toBeTruthy();

    await waitFor(() => {
      expect(mockGetStats).toHaveBeenCalledWith(42);
    });

    // After API response, should show API stats
    await waitFor(() => {
      expect(getByText('7 days')).toBeTruthy(); // longest streak
      expect(getByText('3 days')).toBeTruthy(); // current streak
      expect(getByText('75%')).toBeTruthy(); // completion rate
      expect(getByText('15')).toBeTruthy(); // total completions
    });
  });

  it('falls back to local stats when API fails', async () => {
    (mockGetStats as any).mockRejectedValueOnce(new Error('Network error'));

    const fallbackStats: HabitStatsData = {
      ...localStats,
      longestStreak: 2,
      currentStreak: 1,
      totalCompletions: 4,
      completionRate: 0.5,
    };

    const { getByText } = render(
      <StatsModal
        visible={true}
        habit={baseHabit}
        stats={fallbackStats}
        onClose={jest.fn() as any}
      />,
    );

    await waitFor(() => {
      expect(getByText('2 days')).toBeTruthy(); // longest streak from local
      expect(getByText('4')).toBeTruthy(); // total completions from local
      expect(getByText('50%')).toBeTruthy(); // completion rate from local
    });
  });

  it('displays habit name and icon in header', async () => {
    (mockGetStats as any).mockResolvedValueOnce(apiResponse);

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={jest.fn() as any} />,
    );

    expect(getByText(/Meditation Stats/)).toBeTruthy();
    expect(getByText('🧘')).toBeTruthy();
  });

  it('calls onClose when close button is pressed', async () => {
    (mockGetStats as any).mockResolvedValueOnce(apiResponse);
    const onClose = jest.fn() as any;

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={onClose} />,
    );

    fireEvent.press(getByText('×'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between tabs', async () => {
    (mockGetStats as any).mockResolvedValueOnce(apiResponse);

    const { getByText } = render(
      <StatsModal visible={true} habit={baseHabit} stats={localStats} onClose={jest.fn() as any} />,
    );

    // Default tab is calendar
    await waitFor(() => {
      expect(getByText('Longest Streak:')).toBeTruthy();
    });

    // Switch to progress tab
    fireEvent.press(getByText('Progress'));
    expect(getByText('Progress (Last 7 Days)')).toBeTruthy();

    // Switch to by-day tab
    fireEvent.press(getByText('By Day'));
    expect(getByText('Completions by Day of Week')).toBeTruthy();
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
