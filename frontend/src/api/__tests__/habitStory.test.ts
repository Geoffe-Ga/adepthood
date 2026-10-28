/* global beforeEach, expect, it, jest */
import { habits } from '../index';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const counts = { low: 0, clear: 0, stretch: 0, under: 0, quiet: 1 };
const rate = { met: 0, scheduled: 1 };
const story = {
  polarity: 'additive',
  cadence: 'day',
  unit: 'pages',
  start_date: '2026-06-01',
  today: '2026-06-01',
  logged_days: 0,
  log_count: 0,
  days: [],
  stages: [],
  continuity: { current_run: 0, longest_run: 0, returns: 0, days_with: 0, unit: 'days' },
  rates: { last_7: rate, last_21: rate, last_30: rate, all_time: rate, unit: 'days' },
  tiers: { totals: counts, weekly: [], last_30_delta: { low: 0, clear: 0, stretch: 0 } },
  patterns: {
    weekday_units: Array.from({ length: 7 }, () => 0),
    weekday_by_time_of_day: Array.from({ length: 7 }, () => [0, 0, 0, 0]),
    unknown_time_units: 0,
    time_of_day_available_since: null,
  },
  logs: [],
  observations: [],
  milestones: [],
};

function respond(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload });
}

beforeEach(() => {
  mockFetch.mockReset();
});

it('reads and validates the requested habit Story with the captured credential', async () => {
  respond(story);
  await expect(habits.getStory(7, 'story-owner-token')).resolves.toEqual(story);
  expect(mockFetch).toHaveBeenCalledWith(
    'http://test/habits/7/story',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer story-owner-token' }),
    }),
  );
});

it('rejects a response whose explicit scheduled denominator disappeared', async () => {
  respond({ ...story, rates: { ...story.rates, last_21: { met: 0 } } });
  await expect(habits.getStory(7)).rejects.toThrow();
});

it('preserves signed operations and an honest unknown-timing residual', async () => {
  const payload = {
    ...story,
    log_count: 1,
    logs: [
      {
        timestamp: '2026-06-01T23:30:00Z',
        local_day: '2026-05-31',
        delta_units: -8,
        via_timer: false,
        source: 'manual',
      },
    ],
    patterns: { ...story.patterns, unknown_time_units: 64 },
  };
  respond(payload);
  const result = await habits.getStory(7);
  expect(result.logs[0]).toEqual(payload.logs[0]);
  expect(result.patterns.unknown_time_units).toBe(64);
  expect(result.patterns.time_of_day_available_since).toBeNull();
});
