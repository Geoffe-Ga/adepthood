import { z } from 'zod';

/** Mirrors ``backend/src/schemas/progress.py::ProgressOverviewResponse`` (#3522). */
export const progressOverviewSchema = z.object({
  arc: z.object({
    program_started_at: z.string().nullable(),
    cycle_number: z.number(),
    current_stage: z.number(),
    current_week: z.number().nullable(),
    stages: z.array(
      z.object({
        stage_number: z.number(),
        aspect: z.string(),
        weeks: z.number(),
        opens_on: z.string().nullable(),
        practice_ask_minutes: z.number().nullable(),
      }),
    ),
    habit_births: z.array(
      z.object({
        habit_id: z.number(),
        name: z.string(),
        icon: z.string(),
        week: z.number().nullable(),
        stage_number: z.number().nullable(),
        is_carryover: z.boolean(),
      }),
    ),
  }),
  rhythm: z.object({
    days: z.array(
      z.object({
        date: z.string(),
        rate: z.number(),
        daily_met: z.number(),
        daily_scheduled: z.number(),
        window_days: z.number(),
      }),
    ),
    fullest_fortnight_ending: z.string().nullable(),
    longest_rest: z.object({ start: z.string(), end: z.string() }).nullable(),
    rising_since: z.string().nullable(),
  }),
  cycles: z.array(
    z.object({
      stage_number: z.number(),
      rates: z.array(
        z.object({
          cycle: z.number(),
          rate: z.number(),
          scheduled_days: z.number(),
          met_days: z.number(),
        }),
      ),
    }),
  ),
  energy: z.object({
    weeks: z.array(z.object({ week_start: z.string(), net: z.number() })),
    formula: z.string(),
  }),
  /** Rhythm captions from the observations engine (#3525); absent until it lands. */
  observations: z.array(z.string()).optional(),
});
export type ApiProgressOverview = z.infer<typeof progressOverviewSchema>;
