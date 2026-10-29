import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import { CalendarDays } from 'lucide-react-native';
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

  it('draws the door as the day-by-day calendar it opens, not an info mark', () => {
    const { getByRole } = render(
      <HabitTile habit={storyHabit()} onOpenStory={jest.fn()} tz="UTC" />,
    );
    expect(
      within(getByRole('button', { name: 'Story' })).UNSAFE_getByType(CalendarDays),
    ).toBeTruthy();
  });

  it('opens the Story from the run chip too, leaving the name for goals', () => {
    const onOpenStory = jest.fn();
    const onOpenGoals = jest.fn();
    const habit = storyHabit({ streak: 9 });
    const { getByTestId } = render(
      <HabitTile habit={habit} onOpenStory={onOpenStory} onOpenGoals={onOpenGoals} tz="UTC" />,
    );
    const chip = getByTestId('habit-streak');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityHint).toBe(`Opens the story of ${habit.name}`);
    fireEvent.press(chip);
    expect(onOpenStory).toHaveBeenCalledWith(habit);
    expect(onOpenGoals).not.toHaveBeenCalled();
  });

  it('leaves the run chip plain text when nothing opens the Story', () => {
    const chip = render(<HabitTile habit={storyHabit()} tz="UTC" />).getByTestId('habit-streak');
    expect(chip.props.accessibilityRole).toBeUndefined();
    expect(chip.props.onPress).toBeUndefined();
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
