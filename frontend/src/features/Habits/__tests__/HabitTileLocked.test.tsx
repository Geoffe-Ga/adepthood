/* eslint-env jest */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import type { Habit } from '../Habits.types';
import { HabitTile } from '../HabitTile';

const makeHabit = (overrides: Partial<Habit> = {}): Habit => ({
  id: 1,
  stage: 'Purple',
  name: 'Locked Habit',
  icon: '🔮',
  streak: 0,
  energy_cost: 5,
  energy_return: 7,
  start_date: new Date(Date.now() + 7 * 86_400_000), // 7 days from now
  goals: [
    {
      title: 'Low',
      tier: 'low',
      target: 1,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Clear',
      tier: 'clear',
      target: 2,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
    {
      title: 'Stretch',
      tier: 'stretch',
      target: 3,
      target_unit: 'u',
      frequency: 1,
      frequency_unit: 'per_day',
      is_additive: true,
    },
  ],
  completions: [],
  revealed: false,
  ...overrides,
});

describe('HabitTile locked state', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-06T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders a non-interactive locked tile with lock icon', () => {
    const habit = makeHabit({ start_date: new Date('2026-04-13T00:00:00Z') });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const tile = component.root.findByProps({ testID: 'habit-tile' });

    // Should have reduced opacity
    expect(tile.props.style.opacity).toBe(0.4);

    // Should have greyed-out background
    expect(tile.props.style.backgroundColor).toBe('#e8e8e8');
  });

  it('shows lock icon instead of streak data', () => {
    const habit = makeHabit();

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const { Text } = require('react-native');
    const texts = component.root.findAllByType(Text);
    const textContents = texts.map((t: { props: { children: string } }) => t.props.children);

    // Should contain lock icon
    expect(textContents).toContain('🔒');

    // Should contain habit name
    expect(textContents).toContain('Locked Habit');

    // Should NOT contain streak text
    const hasStreakText = textContents.some(
      (t: string) => typeof t === 'string' && t.includes('DAYS'),
    );
    expect(hasStreakText).toBe(false);
  });

  it('shows "Unlocks in X days" countdown for future start dates', () => {
    const habit = makeHabit({ start_date: new Date('2026-04-13T00:00:00Z') });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const unlockLabel = component.root.findByProps({ testID: 'unlock-label' });
    expect(unlockLabel.props.children).toBe('Unlocks in 7 days');
  });

  it('shows singular "day" for 1 day remaining', () => {
    const habit = makeHabit({ start_date: new Date('2026-04-07T12:00:00Z') });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const unlockLabel = component.root.findByProps({ testID: 'unlock-label' });
    expect(unlockLabel.props.children).toBe('Unlocks in 1 day');
  });

  it('shows "Stage X · Locked" when start date has passed', () => {
    const habit = makeHabit({
      stage: 'Purple',
      start_date: new Date('2026-04-01T00:00:00Z'),
    });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const unlockLabel = component.root.findByProps({ testID: 'unlock-label' });
    expect(unlockLabel.props.children).toBe('Stage Purple · Locked');
  });

  it('does not render progress bar for locked tiles', () => {
    const habit = makeHabit();

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const progressFills = component.root.findAllByProps({ testID: 'progress-fill' });
    expect(progressFills).toHaveLength(0);
  });

  it('renders normally when not locked', () => {
    const habit = makeHabit({ revealed: true });

    const onOpenGoals = jest.fn();
    const onLongPress = jest.fn();

    const component = renderer.create(
      <HabitTile habit={habit} onOpenGoals={onOpenGoals} onLongPress={onLongPress} />,
    );

    const tile = component.root.findByProps({ testID: 'habit-tile' });

    // Should have normal background
    expect(tile.props.style.backgroundColor).toBe('#f8f8f8');

    // Should have progress bar
    const progressFills = component.root.findAllByProps({ testID: 'progress-fill' });
    expect(progressFills.length).toBeGreaterThanOrEqual(1);

    // Should be interactive
    renderer.act(() => {
      tile.props.onPress();
    });
    expect(onOpenGoals).toHaveBeenCalled();
  });

  it('has accessible label for locked tiles', () => {
    const habit = makeHabit({ name: 'Sangha' });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.accessibilityLabel).toBe('Sangha locked');
  });

  it('uses the stage color for tile border even when locked', () => {
    const habit = makeHabit({ stage: 'Purple' });

    const component = renderer.create(
      <HabitTile habit={habit} locked onOpenGoals={() => {}} onLongPress={() => {}} />,
    );

    const tile = component.root.findByProps({ testID: 'habit-tile' });
    expect(tile.props.style.borderColor).toBe('#a093c6');
  });
});
