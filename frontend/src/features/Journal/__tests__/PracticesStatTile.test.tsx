/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

interface WeeklyProgressMock {
  count: number;
  isLoading: boolean;
  error: Error | null;
}

let mockWeeklyProgress: WeeklyProgressMock = { count: 0, isLoading: false, error: null };

jest.mock('@/features/Practice/hooks/useWeeklyProgress', () => ({
  useWeeklyProgress: () => mockWeeklyProgress,
}));

import PracticesStatTile from '../PracticesStatTile';

import { WEEKLY_TARGET } from '@/features/Practice/constants';

beforeEach(() => {
  mockNavigate.mockClear();
  mockWeeklyProgress = { count: 0, isLoading: false, error: null };
});

describe('PracticesStatTile', () => {
  it('shows the raw session count against the weekly target', () => {
    mockWeeklyProgress = { count: 2, isLoading: false, error: null };
    const { getByText } = render(<PracticesStatTile />);
    expect(getByText(`2/${String(WEEKLY_TARGET)} this week`)).toBeTruthy();
  });

  it('navigates to Practice when pressed and labels the count in the a11y string', () => {
    mockWeeklyProgress = { count: 2, isLoading: false, error: null };
    const { getByTestId } = render(<PracticesStatTile />);
    fireEvent.press(getByTestId('journal-practices-tile'));
    expect(mockNavigate).toHaveBeenCalledWith('Practice');
    const label = getByTestId('journal-practices-tile').props.accessibilityLabel as string;
    expect(label).toContain(`2 of ${String(WEEKLY_TARGET)} done`);
  });

  it('does not clamp a count that exceeds the weekly target', () => {
    mockWeeklyProgress = { count: 9, isLoading: false, error: null };
    const { getByText } = render(<PracticesStatTile />);
    expect(getByText(`9/${String(WEEKLY_TARGET)} this week`)).toBeTruthy();
  });

  it('shows the skeleton and no stat text while loading', () => {
    mockWeeklyProgress = { count: 0, isLoading: true, error: null };
    const { getByTestId, queryByText } = render(<PracticesStatTile />);
    expect(getByTestId('journal-practices-tile-skeleton')).toBeTruthy();
    expect(queryByText(/this week/)).toBeNull();
  });

  it('degrades to a countless, still-pressable tile on error', () => {
    mockWeeklyProgress = { count: 0, isLoading: false, error: new Error('boom') };
    const { getByTestId, queryByText } = render(<PracticesStatTile />);
    expect(queryByText(/this week/)).toBeNull();
    const tile = getByTestId('journal-practices-tile');
    expect(tile).toBeTruthy();
    const label = tile.props.accessibilityLabel as string;
    expect(label).toContain('count unavailable');
    fireEvent.press(tile);
    expect(mockNavigate).toHaveBeenCalledWith('Practice');
  });
});
