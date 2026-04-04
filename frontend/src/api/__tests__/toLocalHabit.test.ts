/* eslint-env jest */
/* global describe, test, expect */
import { toLocalHabit } from '../index';
import type { ApiHabitWithGoals } from '../index';

describe('toLocalHabit', () => {
  const apiHabit: ApiHabitWithGoals = {
    id: 1,
    user_id: 10,
    name: 'Drink Water',
    icon: '💧',
    start_date: '2024-01-15',
    energy_cost: 1,
    energy_return: 2,
    stage: 'aptitude',
    streak: 5,
    notification_times: ['08:00'],
    notification_frequency: 'daily',
    notification_days: ['mon', 'wed'],
    milestone_notifications: true,
    sort_order: 1,
    goals: [
      {
        id: 100,
        habit_id: 1,
        title: 'Drink 8 glasses',
        tier: 'clear',
        target: 8,
        target_unit: 'glasses',
        frequency: 1,
        frequency_unit: 'per_day',
        is_additive: true,
      },
    ],
  };

  test('converts start_date string to Date object', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.start_date).toBeInstanceOf(Date);
    expect(local.start_date.toISOString()).toContain('2024-01-15');
  });

  test('preserves id as required number', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.id).toBe(1);
  });

  test('preserves stage field', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.stage).toBe('aptitude');
  });

  test('preserves streak field', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.streak).toBe(5);
  });

  test('maps goals from API format', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.goals).toHaveLength(1);
    expect(local.goals[0]!.title).toBe('Drink 8 glasses');
    expect(local.goals[0]!.id).toBe(100);
  });

  test('maps notification fields', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.notificationTimes).toEqual(['08:00']);
    expect(local.notificationFrequency).toBe('daily');
    expect(local.notificationDays).toEqual(['mon', 'wed']);
    expect(local.milestoneNotifications).toBe(true);
  });

  test('initializes completions as empty array', () => {
    const local = toLocalHabit(apiHabit);
    expect(local.completions).toEqual([]);
  });

  test('handles null notification fields gracefully', () => {
    const minimal: ApiHabitWithGoals = {
      ...apiHabit,
      notification_times: null,
      notification_frequency: null,
      notification_days: null,
      goals: [],
    };
    const local = toLocalHabit(minimal);
    expect(local.notificationTimes).toBeUndefined();
    expect(local.notificationFrequency).toBeUndefined();
    expect(local.notificationDays).toBeUndefined();
  });
});
