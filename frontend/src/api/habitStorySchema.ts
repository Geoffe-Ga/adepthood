import { z } from 'zod';

const rate = z.object({ met: z.number(), scheduled: z.number() });
const counts = z.object({
  low: z.number(),
  clear: z.number(),
  stretch: z.number(),
  under: z.number(),
  quiet: z.number(),
});
export const habitStorySchema = z.object({
  polarity: z.enum(['additive', 'subtractive']),
  cadence: z.enum(['day', 'week', 'month']),
  unit: z.string(),
  start_date: z.string(),
  today: z.string(),
  logged_days: z.number(),
  log_count: z.number(),
  days: z.array(
    z.object({
      date: z.string(),
      units: z.number(),
      unknown_time_units: z.number(),
      tier: z.enum(['low', 'clear', 'stretch']).nullable(),
      logged: z.boolean(),
      scheduled: z.boolean(),
      met: z.boolean(),
    }),
  ),
  stages: z.array(
    z.object({ stage_number: z.number(), opens_on: z.string(), closes_on: z.string() }),
  ),
  continuity: z.object({
    current_run: z.number(),
    longest_run: z.number(),
    returns: z.number(),
    days_with: z.number(),
    unit: z.enum(['days', 'weeks', 'months']),
  }),
  rates: z.object({
    last_7: rate,
    last_21: rate,
    last_30: rate,
    all_time: rate,
    unit: z.enum(['days', 'weeks', 'months']),
  }),
  tiers: z.object({
    totals: counts,
    weekly: z.array(counts.extend({ week_start: z.string() })),
    last_30_delta: z.object({ low: z.number(), clear: z.number(), stretch: z.number() }),
  }),
  patterns: z.object({
    weekday_units: z.array(z.number()),
    weekday_by_time_of_day: z.array(z.array(z.number())),
    unknown_time_units: z.number(),
    time_of_day_available_since: z.string().nullable(),
  }),
  logs: z.array(
    z.object({
      timestamp: z.string(),
      local_day: z.string(),
      delta_units: z.number(),
      via_timer: z.boolean(),
      source: z.string(),
    }),
  ),
  observations: z.array(z.string()),
  milestones: z.array(z.object({ kind: z.string(), reached_on: z.string(), value: z.number() })),
});
export type ApiHabitStory = z.infer<typeof habitStorySchema>;
