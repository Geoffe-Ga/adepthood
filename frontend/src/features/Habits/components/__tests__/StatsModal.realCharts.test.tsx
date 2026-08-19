/**
 * Renders StatsModal against the *real* react-native-chart-kit.
 *
 * The two existing StatsModal suites both `jest.mock('react-native-chart-kit')`,
 * which is right for them -- they assert the props StatsModal computes, and a
 * stub is the cleanest way to capture those. But it means no test in the tree
 * has ever executed the charting library itself, so a major upgrade of it could
 * land fully green while rendering nothing. That is the gap this file closes:
 * the charting library is real here, and so is `react-native-svg`, since that is
 * what the charts actually draw with. Only the calendar is stubbed, because it
 * belongs to the one tab these two assertions do not look at.
 *
 * It earned itself immediately: chart-kit 7 ships ESM where 6 shipped CJS, and
 * the real module would not even parse until it was added to
 * `transformIgnorePatterns`.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-calendars', () => ({
  Calendar: () => null,
}));

import type { Habit, HabitStatsData } from '../../Habits.types';
import { StatsModal } from '../StatsModal';

const habit: Habit = {
  id: 42,
  stage: 'Beige',
  name: 'Meditation',
  icon: '\u{1F9D8}',
  streak: 5,
  energy_cost: 2,
  energy_return: 3,
  start_date: new Date('2024-01-01'),
  goals: [],
  completions: [],
};

// Non-zero and uneven on purpose: a flat all-zero series can be drawn by a
// degenerate implementation that never computes a scale.
const stats: HabitStatsData = {
  values: [1, 4, 2, 7, 3, 6, 5],
  completionsByDay: [1, 2, 0, 4, 3, 2, 1],
  dayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  longestStreak: 4,
  currentStreak: 2,
  totalCompletions: 13,
  completionRate: 0.6,
  completionDates: ['2024-01-01'],
};

describe('StatsModal against the real charting library', () => {
  it('draws the progress line chart without throwing', () => {
    const { getByText, UNSAFE_root } = render(
      <StatsModal habit={habit} stats={stats} visible onClose={() => undefined} />,
    );

    fireEvent.press(getByText('Progress'));

    // Charts draw in SVG, so a rendered chart means Svg host views exist in the
    // tree. Asserting on the host element name rather than a testID because the
    // library owns this subtree and publishes no testIDs of its own.
    expect(UNSAFE_root.findAllByType('RNSVGSvgView' as never).length).toBeGreaterThan(0);
  });

  it('draws the by-day bar chart without throwing', () => {
    const { getByText, UNSAFE_root } = render(
      <StatsModal habit={habit} stats={stats} visible onClose={() => undefined} />,
    );

    fireEvent.press(getByText('By Day'));

    expect(UNSAFE_root.findAllByType('RNSVGSvgView' as never).length).toBeGreaterThan(0);
  });
});
