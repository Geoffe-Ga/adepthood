import type { ApiProgressOverview } from '@/api';

/** Neutral aspect labels: the Map spells no stage words of its own (stageCanonDrift). */
const ASPECTS = Array.from({ length: 10 }, (_, index) => `Aspect ${index + 1}`);
const WEEKS = [3, 3, 3, 3, 4, 4, 4, 4, 4, 4];
const DAY_MS = 86_400_000;
const dateAt = (start: string, offset: number): string =>
  new Date(Date.parse(`${start}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);

const ARC: ApiProgressOverview['arc'] = {
  program_started_at: '2026-05-18T12:00:00Z',
  cycle_number: 2,
  current_stage: 7,
  current_week: 23,
  stages: ASPECTS.map((aspect, index) => ({
    stage_number: index + 1,
    aspect,
    weeks: WEEKS[index] ?? 4,
    opens_on: null,
    practice_ask_minutes: null,
  })),
  habit_births: [
    {
      habit_id: 1,
      name: 'Morning pages',
      icon: '📝',
      week: 1,
      stage_number: 1,
      is_carryover: false,
    },
    {
      habit_id: 2,
      name: 'Evening walk',
      icon: '🚶',
      week: 10,
      stage_number: 4,
      is_carryover: false,
    },
    { habit_id: 3, name: 'Water', icon: '💧', week: null, stage_number: null, is_carryover: true },
  ],
};

const RHYTHM_DAYS = 60;
const RHYTHM_PERIOD = 9;
const rhythm = (): ApiProgressOverview['rhythm'] => ({
  days: Array.from({ length: RHYTHM_DAYS }, (_, index) => ({
    date: dateAt('2026-08-29', index),
    rate: 0.4 + 0.3 * Math.sin(index / RHYTHM_PERIOD),
    daily_met: 2,
    daily_scheduled: 3,
    window_days: 14,
  })),
  fullest_fortnight_ending: '2026-06-26',
  longest_rest: { start: '2026-08-03', end: '2026-08-24' },
  rising_since: '2026-09-14',
});

const CYCLES: ApiProgressOverview['cycles'] = [
  {
    stage_number: 1,
    rates: [
      { cycle: 1, rate: 0.4, scheduled_days: 21, met_days: 8 },
      { cycle: 2, rate: 0.7, scheduled_days: 21, met_days: 15 },
    ],
  },
  {
    stage_number: 2,
    rates: [
      { cycle: 1, rate: 0.8, scheduled_days: 21, met_days: 17 },
      { cycle: 2, rate: 0.6, scheduled_days: 21, met_days: 13 },
    ],
  },
];

const NETS = [4, 6, -2, 8, 3, 0, 5, -1, 7, 9, 2, 6];
const energy = (): ApiProgressOverview['energy'] => ({
  weeks: NETS.map((net, index) => ({ week_start: dateAt('2026-08-10', index * 7), net })),
  formula: 'sum(return - cost) over completions',
});

/** A week-23 overview with a full rhythm, two cycles and twelve energy weeks. */
export function progressOverviewFixture(
  overrides: Partial<ApiProgressOverview> = {},
): ApiProgressOverview {
  return {
    arc: structuredClone(ARC),
    rhythm: rhythm(),
    cycles: structuredClone(CYCLES),
    energy: energy(),
    ...overrides,
  };
}
