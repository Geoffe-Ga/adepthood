/* eslint-env jest */
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockDismiss = jest.fn();
let mockInvitations: Invitation[] = [];
jest.mock('../useInvitations', () => ({
  useInvitations: () => ({ invitations: mockInvitations, dismiss: mockDismiss }),
}));

const mockDismissOffer = jest.fn();
const mockStart = jest.fn();
const mockPause = jest.fn();
const mockResume = jest.fn();
const mockLeave = jest.fn();
let mockMettaReturn: {
  eligible: boolean;
  weeks: ReturnWeek[];
  arc: ReturnArc | null;
  offerVisible: boolean;
};
jest.mock('../useMettaReturn', () => ({
  useMettaReturn: () => ({
    ...mockMettaReturn,
    dismissOffer: mockDismissOffer,
    start: mockStart,
    pause: mockPause,
    resume: mockResume,
    leave: mockLeave,
  }),
}));

import TodayScreen from '../TodayScreen';

import type { Invitation, ReturnArc, ReturnWeek } from '@/api';
import type { Habit } from '@/features/Habits/Habits.types';
import { useHabitStore } from '@/store/useHabitStore';
import { useProgramStore } from '@/store/useProgramStore';

const makeInvitation = (id: number): Invitation => ({
  id,
  target_type: 'practice',
  target_id: null,
  kind: 'readiness',
  created_at: '2026-01-01T00:00:00Z',
});

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

const makeWeek = (weekNumber: number): ReturnWeek => ({
  week_number: weekNumber,
  focus: 'self',
  title: `Toward yourself, week ${weekNumber}`,
  framing: 'Begin where you already are.',
});

const makeArc = (weekNumber: number): ReturnArc => ({
  started_at: '2026-06-24T00:00:00Z',
  paused: false,
  week: weekNumber,
  focus: 'self',
});

beforeEach(() => {
  mockNavigate.mockClear();
  mockDismiss.mockClear();
  mockDismissOffer.mockClear();
  mockStart.mockClear();
  mockPause.mockClear();
  mockResume.mockClear();
  mockLeave.mockClear();
  mockInvitations = [];
  mockMettaReturn = { eligible: false, weeks: [], arc: null, offerVisible: false };
  useProgramStore.setState({ programStartDate: new Date() });
  useHabitStore.setState({ habits: [], loading: false });
});

describe('TodayScreen', () => {
  it('shows the journey position in the hero', () => {
    const { getByTestId, getByText } = render(<TodayScreen />);
    expect(getByTestId('today-hero')).toBeTruthy();
    expect(getByText(/Week 1 of 36/)).toBeTruthy();
  });

  it('shows a not-yet-started journey and a generic journal prompt with no program anchor', () => {
    useProgramStore.setState({ programStartDate: null });
    const { getByText } = render(<TodayScreen />);
    expect(getByText('Your journey awaits')).toBeTruthy();
    expect(getByText('Open your journal.')).toBeTruthy();
  });

  it('summarises today’s habits and routes to Habits on press', () => {
    useHabitStore.setState({ habits: [makeHabit(1, true), makeHabit(2, false)], loading: false });
    const { getByTestId, getByText } = render(<TodayScreen />);
    expect(getByText('1/2 done')).toBeTruthy();
    expect(getByText('Keep the streak alive.')).toBeTruthy();
    fireEvent.press(getByTestId('today-habits-band'));
    expect(mockNavigate).toHaveBeenCalledWith('Habits');
  });

  it('celebrates when every habit is done today', () => {
    useHabitStore.setState({ habits: [makeHabit(1, true), makeHabit(2, true)], loading: false });
    const { getByText } = render(<TodayScreen />);
    expect(getByText('2/2 done')).toBeTruthy();
    expect(getByText('All caught up — beautiful.')).toBeTruthy();
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

  it('renders no invitation surface when there are none (silence by default)', () => {
    const { queryByTestId, getByTestId } = render(<TodayScreen />);
    expect(queryByTestId(/^invitation-/)).toBeNull();
    // Silence must not blank the screen — the hero and bands still render.
    expect(getByTestId('today-hero')).toBeTruthy();
    expect(getByTestId('today-practice-band')).toBeTruthy();
  });

  it('renders a pending invitation card between the hero and the bands', () => {
    mockInvitations = [makeInvitation(7)];
    const { getByTestId } = render(<TodayScreen />);
    expect(getByTestId('invitation-7')).toBeTruthy();
    expect(getByTestId('today-hero')).toBeTruthy();
    expect(getByTestId('today-practice-band')).toBeTruthy();
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

  it('shows no Return offer card when offerVisible is false', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: false };
    const { queryByTestId } = render(<TodayScreen />);
    expect(queryByTestId('return-offer-card')).toBeNull();
  });

  it('shows the Return offer card when offerVisible is true', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: true };
    const { getByTestId } = render(<TodayScreen />);
    expect(getByTestId('return-offer-card')).toBeTruthy();
  });

  it('shows the Return arc card when an arc is active', () => {
    mockMettaReturn = {
      eligible: true,
      weeks: [makeWeek(1)],
      arc: makeArc(1),
      offerVisible: false,
    };
    const { getByTestId } = render(<TodayScreen />);
    expect(getByTestId('return-arc-card')).toBeTruthy();
  });

  it('shows no Return arc card when there is no active arc', () => {
    mockMettaReturn = { eligible: true, weeks: [makeWeek(1)], arc: null, offerVisible: false };
    const { queryByTestId } = render(<TodayScreen />);
    expect(queryByTestId('return-arc-card')).toBeNull();
  });

  describe('time-of-day greeting', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('greets "Good morning" before noon', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T08:00:00'));
      const { getByText } = render(<TodayScreen />);
      expect(getByText('Good morning')).toBeTruthy();
    });

    it('greets "Good afternoon" between noon and 6pm', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T14:00:00'));
      const { getByText } = render(<TodayScreen />);
      expect(getByText('Good afternoon')).toBeTruthy();
    });

    it('greets "Good evening" after 6pm', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T20:00:00'));
      const { getByText } = render(<TodayScreen />);
      expect(getByText('Good evening')).toBeTruthy();
    });
  });
});
