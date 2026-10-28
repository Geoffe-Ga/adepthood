import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { formatStreakText, HabitTile } from '../HabitTile';

import { touchTarget } from '@/design/tokens';
import { storyHabit } from '@/features/Habits/testSupport/habitStoryFixture';

describe('HabitTile Story door (#3526)', () => {
  it('opens the Story from a named glyph with a full touch target', () => {
    const onOpenStory = jest.fn();
    const onOpenGoals = jest.fn();
    const habit = storyHabit();
    const { getByRole } = render(
      <HabitTile habit={habit} onOpenStory={onOpenStory} onOpenGoals={onOpenGoals} tz="UTC" />,
    );
    const glyph = getByRole('button', { name: 'Story' });
    const style = StyleSheet.flatten(glyph.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    fireEvent.press(glyph);
    expect(onOpenStory).toHaveBeenCalledWith(habit);
    expect(onOpenGoals).not.toHaveBeenCalled();
  });

  it('shows no door when nothing opens it, nor on a locked tile', () => {
    const habit = storyHabit();
    expect(
      render(<HabitTile habit={habit} tz="UTC" />).queryByTestId('habit-story-glyph'),
    ).toBeNull();
    expect(
      render(<HabitTile habit={habit} locked onOpenStory={jest.fn()} tz="UTC" />).queryByTestId(
        'habit-story-glyph',
      ),
    ).toBeNull();
  });
});

describe('the Glance chip (D04)', () => {
  it('reads as a run in the habit cadence, never a streak', () => {
    const daily = storyHabit({ streak: 7 });
    expect(formatStreakText(daily, false, 'day')).toBe('7-DAY RUN');
    expect(formatStreakText(daily, true, 'day')).toBe('7-DAY RUN · KEPT TODAY');
    const weekly = storyHabit({
      streak: 2,
      goals: storyHabit().goals.map((goal) => ({ ...goal, frequency_unit: 'per_week' as const })),
    });
    expect(formatStreakText(weekly, true, 'week')).toBe('2-WEEK RUN · KEPT THIS WEEK');
    for (const text of [
      formatStreakText(daily, true, 'day'),
      formatStreakText(weekly, true, 'month'),
    ])
      expect(text).not.toMatch(/streak/i);
  });
});
