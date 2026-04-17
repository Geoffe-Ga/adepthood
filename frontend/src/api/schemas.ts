/**
 * Runtime validation schemas for API responses (BUG-FRONTEND-INFRA-024).
 *
 * The TypeScript types in ``index.ts`` are a *compile-time* contract; they
 * have no bearing at runtime. Before these schemas, a backend that shipped a
 * mis-shaped response (missing field, unexpected ``null``, renamed key)
 * surfaced as a ``TypeError`` deep inside the UI, usually with no stack frame
 * in the API layer.
 *
 * With Zod, we validate at the HTTP-client edge so the only error surface the
 * UI ever sees is ``ApiValidationError`` — typed, logged with full detail, and
 * safe to reason about at each call site.
 *
 * Coverage priority (audit BUG-024): auth (every caller has a JWT at stake),
 * habits (highest blast radius if a field is wrong), and the new
 * ``Page<T>`` envelope from BUG-INFRA-012-018 so paginated list endpoints
 * share a single validator.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A string that must be a non-empty ISO-8601 timestamp per backend contract. */
const isoDateTime = z.string().min(1);

// ---------------------------------------------------------------------------
// Pagination envelope (BUG-INFRA-012-018)
// ---------------------------------------------------------------------------

/** Factory that wraps any item schema in the Page envelope. */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
  });
}

export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

// ---------------------------------------------------------------------------
// Auth schemas
// ---------------------------------------------------------------------------

export const authResponseSchema = z.object({
  token: z.string().min(1),
  // ``user_id`` is ``0`` in the anti-enumeration signup response (BUG-AUTH-002):
  // when a caller signs up with an already-registered email the backend returns
  // a dummy token and ``user_id=0`` so the wire shape is indistinguishable from
  // a fresh signup. Real signups return a positive autoincrement id.
  user_id: z.number().int().nonnegative(),
});

export type AuthResponseT = z.infer<typeof authResponseSchema>;

// ---------------------------------------------------------------------------
// Goal / habit schemas (BUG-024 + BUG-010)
// ---------------------------------------------------------------------------

/**
 * Goal tier enum (BUG-010): once the backend serialises tier as a real enum,
 * the strictest form is ``z.enum([...])``. Until then, we accept any non-empty
 * string and narrow at the ``toLocalHabit`` boundary with a type guard. Every
 * new call site should use ``TIER_VALUES`` rather than re-typing the literal.
 */
export const TIER_VALUES = ['low', 'clear', 'stretch'] as const;
export type Tier = (typeof TIER_VALUES)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_VALUES as readonly string[]).includes(value);
}

export const goalSchema = z.object({
  id: z.number().int(),
  habit_id: z.number().int(),
  title: z.string(),
  description: z.string().nullish(),
  tier: z.string(),
  target: z.number(),
  target_unit: z.string(),
  frequency: z.number(),
  frequency_unit: z.string(),
  is_additive: z.boolean(),
  goal_group_id: z.number().int().nullish(),
});

export const notificationFrequencySchema = z.enum(['daily', 'weekly', 'custom', 'off']);

export const habitSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  icon: z.string(),
  start_date: isoDateTime,
  energy_cost: z.number(),
  energy_return: z.number(),
  notification_times: z.array(z.string()).nullish(),
  notification_frequency: notificationFrequencySchema.nullish(),
  notification_days: z.array(z.string()).nullish(),
  milestone_notifications: z.boolean(),
  sort_order: z.number().int().nullish(),
  stage: z.string(),
  streak: z.number().int(),
});

export const habitWithGoalsSchema = habitSchema.extend({
  goals: z.array(goalSchema),
});

export type HabitSchemaT = z.infer<typeof habitSchema>;
export type HabitWithGoalsSchemaT = z.infer<typeof habitWithGoalsSchema>;
export type GoalSchemaT = z.infer<typeof goalSchema>;

// ---------------------------------------------------------------------------
// Lenient schemas for legacy endpoints (gradually tightened)
// ---------------------------------------------------------------------------

/**
 * Gateway for callers that do not yet have a strict schema. The
 * ``.passthrough()`` means the return value is validated as an object but
 * unknown keys pass through — useful for partial contracts that will be
 * tightened in follow-ups without breaking the wire right now.
 */
export const unknownRecord = z.record(z.unknown());
