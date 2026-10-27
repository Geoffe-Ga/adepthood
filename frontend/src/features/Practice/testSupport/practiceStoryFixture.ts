import type { PracticeStoryResponse } from '@/api';

const FIRST_DAY = '2026-10-19';
const WEEK_STARTS = [
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
  '2026-10-12',
  FIRST_DAY,
];
export function storyFixture(
  overrides: Partial<PracticeStoryResponse> = {},
): PracticeStoryResponse {
  return {
    total_minutes: 65,
    total_sessions: 2,
    weekly: Array.from({ length: 8 }, (_, index) => ({
      week_start: WEEK_STARTS[index]!,
      count: index === 7 ? 2 : 0,
    })),
    weekly_target: 4,
    recent_sits: [
      {
        timestamp: '2026-10-19T18:00:00Z',
        duration_minutes: 45,
        completed: true,
        mode: 'meditation_timer',
      },
      {
        timestamp: '2026-10-25T23:00:00Z',
        duration_minutes: 20,
        completed: false,
        mode: 'interval_bells',
      },
    ],
    time_of_day: { dawn: 0, day: 1, dusk: 1, night: 0 },
    modes: { meditation_timer: 1, interval_bells: 1 },
    stage_ask_minutes: 45,
    stage_average_minutes: 32.5,
    stage_session_count: 2,
    stage_partial_sessions: 1,
    partial_sessions: 1,
    insight_count: 1,
    last_insight: 'A **quiet** moment.',
    last_insight_timestamp: '2026-10-26T01:00:00Z',
    mode_totals: {},
    first_session_on: FIRST_DAY,
    observations: ['Your sits have room to grow.'],
    milestones: [{ kind: 'practice_minutes', value: 60, reached_on: FIRST_DAY }],
    ...overrides,
  };
}
