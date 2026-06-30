/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

import TodayScreen from '../TodayScreen';

import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitStore } from '@/store/useHabitStore';
import { useProgramStore } from '@/store/useProgramStore';

const makeHabit = (id: number, completedToday: boolean): Habit =>
  ({
    id,
    stage: 'beige',
    name: `Habit ${id}`,
    icon: '🌱',
    streak: 0,
    energy_cost: 1,
    energy_return: 2,
    start_date: new Date('2025-01-01'),
    goals: [],
    completions: completedToday
      ? [{ id: `c-${id}`, timestamp: new Date(), completed_units: 1 }]
      : [],
  }) as Habit;

beforeEach(() => {
  mockNavigate.mockClear();
  useProgramStore.setState({ programStartDate: new Date() });
  useHabitStore.setState({ habits: [], loading: false });
});

describe('TodayScreen', () => {
  it('shows the journey position in the hero', () => {
    const { getByTestId, getByText } = render(<TodayScreen />);
    expect(getByTestId('today-hero')).toBeTruthy();
    expect(getByText(/Week 1 of 36/)).toBeTruthy();
  });

  it('summarises today’s habits and routes to Habits on press', () => {
    useHabitStore.setState({ habits: [makeHabit(1, true), makeHabit(2, false)], loading: false });
    const { getByTestId, getByText } = render(<TodayScreen />);
    expect(getByText('1/2 done')).toBeTruthy();
    fireEvent.press(getByTestId('today-habits-band'));
    expect(mockNavigate).toHaveBeenCalledWith('Habits');
  });

  it('shows a habits skeleton while loading', () => {
    useHabitStore.setState({ habits: [], loading: true });
    const { getByTestId } = render(<TodayScreen />);
    expect(getByTestId('today-habits-skeleton')).toBeTruthy();
  });

  it('shows the habits empty state with no habits (other bands still render)', () => {
    const { getByTestId } = render(<TodayScreen />);
    expect(getByTestId('today-habits-empty-cta')).toBeTruthy();
    // One source being empty must not blank the screen — sibling bands still render.
    expect(getByTestId('today-practice-band')).toBeTruthy();
    expect(getByTestId('today-course-band')).toBeTruthy();
  });

  it('routes each band into its feature tab', () => {
    const { getByTestId } = render(<TodayScreen />);
    fireEvent.press(getByTestId('today-practice-band'));
    fireEvent.press(getByTestId('today-journal-band'));
    fireEvent.press(getByTestId('today-course-band'));
    expect(mockNavigate).toHaveBeenCalledWith('Practice');
    expect(mockNavigate).toHaveBeenCalledWith('Journal');
    expect(mockNavigate).toHaveBeenCalledWith('Course');
  });
});
