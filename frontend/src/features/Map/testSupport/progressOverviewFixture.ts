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
      unit_histories: [
        {
          unit: 'pages',
          days: [
            { date: '2026-05-18', units: 0, average: 0 },
            { date: '2026-05-19', units: 2, average: 1 },
          ],
        },
      ],
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
    window_met: 14,
    window_scheduled: 21,
    window_days: 7,
  })),
  fullest_week_ending: '2026-06-26',
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

type Pass = NonNullable<ApiProgressOverview['arc']['passes']>[number];
type Marker = Pass['markers'][number];

const WEEK_DAYS = 7;
const PAGES = [1, 'Morning pages'] as const;
const WALK = [2, 'Evening walk'] as const;
const SITTING = [3, 'Meditation'] as const;
const PARTIAL_START = '2025-01-05';
const COMPLETE_START = '2025-06-01';
const LIVE_START = '2026-06-01';

const marker = (
  started: string,
  [habitId, name]: readonly [number, string],
  programNumber: number,
  week: number,
  locked = false,
): Marker => ({
  habit_id: habitId,
  name,
  icon: '•',
  program_number: programNumber,
  week,
  unlocked_on: dateAt(started, (week - 1) * WEEK_DAYS),
  currently_locked: locked,
});

/** A begun pass; `reached` is `[stage, week]`. */
const begun = (
  [passNumber, startedOn, endedOn]: [number, string, string | null],
  origin: Pass['origin'],
  [stage, week]: [number, number],
  markers: Marker[],
): Pass => ({
  pass_number: passNumber,
  started_on: startedOn,
  ended_on: endedOn,
  origin,
  state: endedOn === null ? 'live' : 'ended',
  days_until_start: 0,
  reached_stage: stage,
  reached_week: week,
  completed: week === WEEKS.reduce((sum, weeks) => sum + weeks, 0),
  markers,
});

/**
 * Four passes, oldest first: one that stopped in stage 7, one that ran all
 * 36 weeks, the live one in week 8 (pass 3 was never recorded, so numbers
 * skip), and one held to begin later.
 */
export function passesFixture(): Pass[] {
  return [
    begun(
      [1, PARTIAL_START, '2025-05-31'],
      'first_run',
      [7, 21],
      [
        marker(PARTIAL_START, PAGES, 1, 1),
        marker(PARTIAL_START, WALK, 2, 4),
        marker(PARTIAL_START, SITTING, 3, 8, true),
      ],
    ),
    begun(
      [2, COMPLETE_START, '2026-02-07'],
      'begin_again',
      [10, 36],
      [marker(COMPLETE_START, PAGES, 1, 1)],
    ),
    begun(
      [4, LIVE_START, null],
      'rescaffold',
      [3, 8],
      [
        marker(LIVE_START, PAGES, 1, 1),
        marker(LIVE_START, WALK, 2, 1),
        marker(LIVE_START, SITTING, 5, 8, true),
      ],
    ),
    {
      pass_number: 5,
      started_on: '2026-08-31',
      ended_on: null,
      origin: 'rescaffold',
      state: 'pending',
      days_until_start: 12,
      reached_stage: null,
      reached_week: null,
      completed: false,
      markers: [],
    },
  ];
}

type ReturnArc = NonNullable<ApiProgressOverview['arc']['return_arcs']>[number];

const RETURN_WEEKS = 5;

/** A Return arc measured as the server measures it (#3745). */
const returnArc = (
  startedOn: string,
  state: ReturnArc['state'],
  reachedWeek: number,
  [endedOn, passNumber]: [string | null, number | null],
): ReturnArc => ({
  started_on: startedOn,
  ended_on: endedOn,
  state,
  weeks_total: RETURN_WEEKS,
  reached_week: reachedWeek,
  completed: state === 'complete',
  pass_number: passNumber,
});

/**
 * Three Metta Return arcs, oldest first, each begun inside one of
 * `passesFixture`'s passes: one set down in week 3 of the partial pass, one
 * lived through in the completed pass and never left, and one running in
 * week 3 of the live pass.
 */
export function returnArcsFixture(): ReturnArc[] {
  return [
    returnArc('2025-02-10', 'left', 3, ['2025-02-24', 1]),
    returnArc('2025-07-07', 'complete', RETURN_WEEKS, [null, 2]),
    returnArc('2026-08-03', 'active', 3, [null, 4]),
  ];
}
