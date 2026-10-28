import type { ApiHabitStory } from '@/api';
import type { Goal, Habit } from '@/features/Habits/Habits.types';

type StoryDay = ApiHabitStory['days'][number];

const DAY_MS = 86_400_000;
const dateAt = (start: string, offset: number): string =>
  new Date(Date.parse(`${start}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);

/** ``count`` consecutive scheduled days from ``start``, every one kept at Clear. */
export function storyDays(start: string, count: number, overrides: Partial<StoryDay>[] = []) {
  return Array.from({ length: count }, (_, index): StoryDay => ({
    date: dateAt(start, index),
    units: 2,
    unknown_time_units: 0,
    tier: 'clear',
    logged: true,
    scheduled: true,
    met: true,
    ...overrides[index],
  }));
}

const START = '2026-09-07';

const PATTERNS: ApiHabitStory['patterns'] = {
  weekday_units: [10, 8, 9, 12, 6, 4, 5],
  weekday_by_time_of_day: [
    [6, 2, 2, 0],
    [4, 2, 2, 0],
    [5, 2, 2, 0],
    [8, 2, 2, 0],
    [2, 2, 2, 0],
    [0, 2, 2, 0],
    [1, 2, 2, 0],
  ],
  unknown_time_units: 12,
  time_of_day_available_since: '2026-10-01',
};

const LOGS: ApiHabitStory['logs'] = [
  {
    timestamp: '2026-10-27T14:05:00Z',
    local_day: '2026-10-27',
    delta_units: 2,
    via_timer: true,
    source: 'manual',
  },
  {
    timestamp: '2026-10-26T15:00:00Z',
    local_day: '2026-10-26',
    delta_units: -1,
    via_timer: false,
    source: 'manual',
  },
];

/** A Morning-pages story with enough history to draw every chart. */
export function habitStoryFixture(overrides: Partial<ApiHabitStory> = {}): ApiHabitStory {
  return {
    polarity: 'additive',
    cadence: 'day',
    unit: 'pages',
    start_date: START,
    today: '2026-10-27',
    logged_days: 45,
    log_count: 50,
    days: storyDays(START, 51),
    stages: [
      { stage_number: 1, opens_on: START, closes_on: '2026-09-27' },
      { stage_number: 2, opens_on: '2026-09-28', closes_on: '2026-10-18' },
      { stage_number: 3, opens_on: '2026-10-19', closes_on: '2026-11-08' },
    ],
    continuity: { current_run: 7, longest_run: 15, returns: 9, days_with: 45, unit: 'days' },
    rates: {
      last_7: { met: 7, scheduled: 7 },
      last_21: { met: 16, scheduled: 21 },
      last_30: { met: 22, scheduled: 30 },
      all_time: { met: 45, scheduled: 51 },
      unit: 'days',
    },
    tiers: {
      totals: { low: 9, clear: 26, stretch: 10, under: 2, quiet: 4 },
      weekly: [
        { week_start: '2026-10-13', low: 1, clear: 4, stretch: 1, under: 0, quiet: 1 },
        { week_start: '2026-10-20', low: 2, clear: 3, stretch: 2, under: 0, quiet: 0 },
      ],
      last_30_delta: { low: -2, clear: 9, stretch: 0 },
    },
    patterns: PATTERNS,
    logs: LOGS,
    observations: [],
    milestones: [],
    ...overrides,
  };
}

/** A server-backed daily habit that the Story sheet can open. */
export function storyHabit(overrides: Partial<Habit> = {}): Habit {
  const goal = (id: number, tier: Goal['tier'], target: number): Goal => ({
    id,
    title: tier,
    tier,
    target,
    target_unit: 'pages',
    frequency: 1,
    frequency_unit: 'per_day',
    is_additive: true,
  });
  return {
    id: 3,
    name: 'Morning pages',
    icon: '📝',
    stage: 'Beige',
    streak: 7,
    energy_cost: 2,
    energy_return: 5,
    start_date: new Date(2026, 8, 7),
    goals: [goal(31, 'low', 1), goal(32, 'clear', 2), goal(33, 'stretch', 3)],
    completions: [],
    revealed: true,
    ...overrides,
  } as Habit;
}
