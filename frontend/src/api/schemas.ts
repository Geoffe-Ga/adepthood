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

/**
 * A full ISO-8601 datetime string with a timezone designator -- e.g.
 * ``2026-05-09T22:31:22Z`` or ``2026-05-09T22:31:22+00:00``.
 *
 * The previous form (``z.string().min(1)``) only enforced non-emptiness,
 * so a backend response like ``timestamp: "not-a-date"`` passed Zod and
 * downstream ``new Date("not-a-date")`` produced a silent
 * ``Invalid Date``. Streak / progress comparisons against that value
 * silently returned ``false`` and surfaced no error to the user or to
 * Sentry -- exactly the kind of root-cause-hidden bug the runtime
 * validators exist to prevent. ``offset: true`` accepts both ``Z`` and
 * ``±HH:MM`` suffixes so the backend's stdlib ``datetime.isoformat()``
 * (which emits ``+00:00``) and any future explicit-``Z`` serializer
 * both pass.
 */
const isoDateTime = z.string().datetime({ offset: true });

/**
 * Calendar-date string in ``YYYY-MM-DD`` form (no time component).
 *
 * Distinct from :const:`isoDateTime` because backend fields like
 * ``Habit.start_date`` are typed as ``datetime.date`` and serialized
 * without a time / timezone -- ``z.string().datetime()`` would reject
 * the legitimate value. The regex pins the calendar shape so a malformed
 * date still fails fast at the validator boundary rather than turning
 * into ``Invalid Date`` further down the call stack.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'expected ISO-8601 calendar date (YYYY-MM-DD)',
});

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
  // IANA timezone the server has on record so the frontend can compute
  // "today" in the user's calendar without a follow-up ``GET /users/me``.
  // Optional for back-compat with older API builds that still omit the
  // field; consumers default to ``"UTC"``.
  timezone: z.string().optional(),
});

export type AuthResponseT = z.infer<typeof authResponseSchema>;

/**
 * Response for ``POST /auth/password-reset/request``.  Always 202 with
 * the same body shape regardless of whether the email is registered --
 * the message is the SPEC R4 anti-enumeration constant.
 */
export const passwordResetAcceptedSchema = z.object({
  message: z.string().min(1),
});

export type PasswordResetAcceptedT = z.infer<typeof passwordResetAcceptedSchema>;

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

/**
 * One row of a goal's completion history (BUG-FE-HABIT-301).  Embedded on
 * the goal so a fresh ``GET /habits`` rebuilds the progress bar without a
 * follow-up round-trip.  Optional in the goal schema for back-compat with
 * older API builds that have not yet rolled out the embedded list.
 *
 * ``completed_units`` is bounded ``>= 0`` to match the domain contract --
 * "I logged units of effort" cannot be negative; a backend bug or a
 * manual data-repair row that violates the invariant fails fast at the
 * validator boundary rather than skewing the summed habit progress
 * downstream.
 */
export const goalCompletionSchema = z.object({
  id: z.number().int(),
  timestamp: isoDateTime,
  completed_units: z.number().nonnegative(),
});

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
  completions: z.array(goalCompletionSchema).optional(),
});

export const notificationFrequencySchema = z.enum(['daily', 'weekly', 'custom', 'off']);

/**
 * Habit response schema. ``user_id`` is intentionally absent to mirror the
 * backend ``OwnedResourcePublic`` base (BUG-T7 / PR #265): the server stripped
 * surrogate user ids from owned-resource responses to harden against
 * enumeration. The frontend Zod schema previously still required ``user_id``,
 * so every ``GET /habits`` returned by the post-#265 backend failed validation
 * with ``ApiValidationError`` — surfaced to users as the
 * "We couldn't load your habits" banner. Keep this field absent unless the
 * backend re-introduces it.
 */
export const habitSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  icon: z.string(),
  start_date: isoDate,
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
