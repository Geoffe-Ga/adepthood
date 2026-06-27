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

/** ISO-8601 datetime with a Z or ±HH:MM offset; rejects free-form strings. */
const isoDateTime = z.string().datetime({ offset: true });

/** ``YYYY-MM-DD`` shape-only; backend's ``datetime.date`` enforces semantics. */
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

/**
 * JWT structural shape: three URL-safe-base64 segments joined by dots
 * (``header.payload.signature``).  Reject anything else at the client
 * boundary so a dummy token cannot pass the auth-response gate
 * (BUG-API-017).  This is a STRUCTURAL check, not a signature check --
 * cryptographic verification still belongs to the backend; the regex
 * exists so a payload like ``{"token": "x"}`` cannot persist as a
 * "valid" session and produce zombie auth state on the next request.
 */
const JWT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const jwtSchema = z.string().regex(JWT_REGEX, {
  message: 'token must be three base64url segments separated by dots',
});

export const authResponseSchema = z.object({
  token: jwtSchema,
  // ``user_id`` is ``0`` in the anti-enumeration signup response (BUG-AUTH-002):
  // when a caller signs up with an already-registered email the backend returns
  // a dummy token and ``user_id=0`` so the wire shape is indistinguishable from
  // a fresh signup. Real signups return a positive autoincrement id.  Login
  // and refresh paths use ``loginAuthResponseSchema`` below which rejects
  // ``user_id=0`` -- a refreshed session whose user id is zero would be a
  // zombie token, never the anti-enumeration sentinel.
  user_id: z.number().int().nonnegative(),
  // IANA timezone the server has on record so the frontend can compute
  // "today" in the user's calendar without a follow-up ``GET /users/me``.
  // Optional for back-compat with older API builds that still omit the
  // field; consumers default to ``"UTC"``.
  timezone: z.string().optional(),
});

/**
 * Strict variant for ``/auth/login`` and ``/auth/refresh`` (BUG-API-017):
 * ``user_id`` MUST be positive.  The signup endpoint deliberately echoes
 * ``user_id=0`` for already-registered emails so the wire shape stays
 * indistinguishable; no other auth path has that affordance, so a
 * zero-id login or refresh is by definition a server bug or a forged
 * payload and we reject it at the boundary instead of letting it
 * persist as a zombie session.
 */
export const loginAuthResponseSchema = authResponseSchema.extend({
  user_id: z.number().int().positive(),
});

export type AuthResponseT = z.infer<typeof authResponseSchema>;
export type LoginAuthResponseT = z.infer<typeof loginAuthResponseSchema>;

/**
 * Response for ``PUT /users/me/timezone`` (issue #261): the IANA zone the
 * server now has on record for the caller.  Validated at the boundary so a
 * malformed body can never corrupt ``userTimezone`` in the AuthContext.
 */
export const timezoneReadSchema = z.object({
  timezone: z.string(),
});

export type TimezoneReadT = z.infer<typeof timezoneReadSchema>;

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

/** One row of a goal's logged completions (BUG-FE-HABIT-301). */
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
  // Weekly cadence (e.g. ["Mon", "Wed"]). Zod strips unknown keys, so without
  // this the backend's days_of_week was deleted on every validated response,
  // silently dropping a goal's schedule on each refetch. `.nullish()` matches
  // the backend's `list[str] | None` and tolerates older API builds.
  days_of_week: z.array(z.string()).nullish(),
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

/** One weekly prompt + the user's response state (mirrors backend ``PromptDetail``). */
export const promptDetailSchema = z.object({
  week_number: z.number().int(),
  question: z.string(),
  has_responded: z.boolean(),
  response: z.string().nullable(),
  timestamp: z.string().nullable(),
});

/**
 * Paginated prompt history. ``total`` is ``int | None`` on the backend — it is
 * ``null`` when the count was not requested — so the schema (and the consumer
 * type) must accept ``null`` rather than coerce it to ``NaN`` in arithmetic.
 */
export const promptListResponseSchema = z.object({
  items: z.array(promptDetailSchema),
  total: z.number().int().nullable(),
  has_more: z.boolean(),
});

export type PromptListResponseSchemaT = z.infer<typeof promptListResponseSchema>;

export const journalTagSchema = z.enum([
  'freeform',
  'stage_reflection',
  'practice_note',
  'habit_note',
]);

/** One journal message (mirrors the backend ``JournalMessage`` response). */
export const journalMessageSchema = z.object({
  id: z.number().int(),
  message: z.string(),
  sender: z.enum(['user', 'bot']),
  // Same ISO-8601 contract as every other timestamp column (goal completions
  // etc.) — bare z.string() would silently accept "not-a-date".
  timestamp: isoDateTime,
  tag: journalTagSchema,
  practice_session_id: z.number().int().nullable(),
  user_practice_id: z.number().int().nullable(),
});

/** Journal list envelope: ``{ items, total, has_more }`` (bespoke, not ``Page``). */
export const journalListResponseSchema = z.object({
  items: z.array(journalMessageSchema),
  total: z.number().int(),
  has_more: z.boolean(),
});

export type JournalListResponseSchemaT = z.infer<typeof journalListResponseSchema>;

// ---------------------------------------------------------------------------
// Per-item schemas for paginated endpoints (replacing loosePageSchema casts).
// The deep ``mode_config`` / ``mode_metadata`` payloads are validated
// server-side as discriminated unions, so they are accepted here as opaque
// records — the goal is item-level field/type drift detection, not re-deriving
// the whole ModeConfig union on the client.
// ---------------------------------------------------------------------------

/** A course stage row (mirrors the backend ``Stage`` response). */
export const stageSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  subtitle: z.string(),
  stage_number: z.number().int(),
  overview_url: z.string(),
  category: z.string(),
  aspect: z.string(),
  spiral_dynamics_color: z.string(),
  growing_up_stage: z.string(),
  divine_gender_polarity: z.string(),
  relationship_to_free_will: z.string(),
  free_will_description: z.string(),
  is_unlocked: z.boolean(),
  progress: z.number(),
});

/** A catalog practice (mirrors ``PracticeItem``); exported for reuse (issue 06). */
export const practiceItemSchema = z.object({
  id: z.number().int(),
  stage_number: z.number().int(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  default_duration_minutes: z.number(),
  // The backend ``PracticeResponse`` intentionally OMITS this field
  // (BUG-PRACTICE-001 / BUG-SCHEMA-010): echoing the submitter's user id on
  // a catalog GET turns the endpoint into a user-id enumeration oracle. The
  // field is therefore ABSENT on the wire, not ``null``. ``.nullish()``
  // (``number | null | undefined``) tolerates the absence; a plain
  // ``.nullable()`` rejected the missing key and failed every practice fetch
  // with ``ApiValidationError`` — the "Something changed on the server"
  // banner on the Practice and Catalog screens. Keep this absent-tolerant
  // unless the backend re-introduces the field.
  submitted_by_user_id: z.number().int().nullish(),
  approved: z.boolean(),
  mode: z.string().optional(),
  mode_config: z.record(z.unknown()).optional(),
});

/** One step of a practice recipe (mirrors ``PracticeRecipeStep``). */
export const practiceRecipeStepSchema = z.object({
  position: z.number().int(),
  tag_slug: z.string(),
  tag_label: z.string(),
  prompt_label: z.string(),
  target_count: z.number(),
});

/** A practice recipe (mirrors ``PracticeRecipe``). */
export const practiceRecipeSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  owner_user_id: z.number().int().nullable(),
  mode: z.enum(['sense_grounding', 'tallied_grounding']),
  rounds: z.number(),
  created_at: z.string(),
  steps: z.array(practiceRecipeStepSchema),
});

/** A user's selected practice (mirrors ``UserPractice``). */
export const userPracticeSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  practice_id: z.number().int(),
  stage_number: z.number().int(),
  start_date: isoDate,
  end_date: isoDate.nullable(),
  custom_name: z.string().nullish(),
  mode_config_override: z.record(z.unknown()).nullish(),
  effective_name: z.string().nullish(),
  effective_config: z.record(z.unknown()).nullish(),
});

/** A logged practice session (mirrors ``PracticeSessionResponse``). */
export const practiceSessionResponseSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  user_practice_id: z.number().int(),
  duration_minutes: z.number(),
  timestamp: isoDateTime,
  reflection: z.string().nullable(),
  mode: z.string().optional(),
  mode_metadata: z.record(z.unknown()).nullish(),
  completed: z.boolean().optional(),
  insight: z.string().nullish(),
});

/** A practice tag (mirrors ``PracticeTag``; audit-contracts-09). */
export const practiceTagSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  label: z.string(),
  owner_user_id: z.number().int().nullable(),
  created_at: z.string(),
});

/** A goal group with its embedded goals (mirrors ``ApiGoalGroup``; audit-contracts-08). */
export const apiGoalGroupSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  icon: z.string().nullish(),
  description: z.string().nullish(),
  user_id: z.number().int().nullish(),
  shared_template: z.boolean(),
  source: z.string().nullish(),
  goals: z.array(goalSchema),
});

/** A course-content item (mirrors ``ContentItem``; audit-contracts-08). */
export const contentItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  content_type: z.string(),
  release_day: z.number().int(),
  url: z.string().nullable(),
  is_locked: z.boolean(),
  is_read: z.boolean(),
});

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
