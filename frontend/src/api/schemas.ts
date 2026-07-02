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
  // Responding to a weekly prompt creates a journal entry tagged
  // ``weekly_prompt`` (backend ``JournalTag.WEEKLY_PROMPT``). The shelf list
  // includes that row, so the enum must accept it — otherwise the whole page
  // fails Zod validation and the user sees "Load failed".
  'weekly_prompt',
]);

/** Lowest Aspect tag (stage 1); the curriculum's first stage. */
const MIN_ASPECT = 1;
/** Highest Aspect tag (stage 10); the curriculum has ten stages. */
const MAX_ASPECT = 10;

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
  // Editorial document fields (journal-resonance). Optional so fixtures /
  // responses predating the columns still validate.
  title: z.string().nullable().optional(),
  status: z.enum(['draft', 'finished']).optional(),
  updated_at: isoDateTime.optional(),
  // Privacy tier. Optional so responses predating the column still
  // validate; the enum rejects any value that drifts from the backend set.
  classification: z.enum(['public', 'personal', 'intimate']).optional(),
  // Chord Aspect tags (each a stage 1..MAX_ASPECT). Optional and nullable so
  // untagged / pre-column responses still validate.
  primary_aspect: z.number().int().min(MIN_ASPECT).max(MAX_ASPECT).nullable().optional(),
  secondary_aspect: z.number().int().min(MIN_ASPECT).max(MAX_ASPECT).nullable().optional(),
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

/** A user's stage-progress record (mirrors the backend ``StageProgressRecord``). */
export const stageProgressRecordSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  current_stage: z.number(),
  completed_stages: z.array(z.number()),
  cycle_number: z.number(),
});

export type StageProgressRecordT = z.infer<typeof stageProgressRecordSchema>;

/** The server's date-derived program calendar (mirrors ``ProgramCalendarResponse``). */
export const programCalendarSchema = z.object({
  program_started_at: z.string().nullable(),
  calendar_stage: z.number(),
  calendar_week: z.number(),
  current_stage: z.number(),
  cycle_number: z.number(),
});

export type ProgramCalendarT = z.infer<typeof programCalendarSchema>;

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
  // Backend omits user_id from user-scoped responses (OwnedResourcePublic /
  // BUG-T7); nullish so a well-formed payload without it still validates.
  user_id: z.number().int().nullish(),
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
  // Backend omits user_id from user-scoped responses (OwnedResourcePublic /
  // BUG-T7); nullish so a well-formed payload without it still validates.
  user_id: z.number().int().nullish(),
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

/**
 * Stage-introduction metadata from ``GET /course/stages/{n}/intro``. Validated
 * at the boundary so a backend field rename/retype raises ``ApiValidationError``.
 */
export const stageIntroSchema = z.object({
  stage: z.number().int(),
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
});

/**
 * Frequency-banner payload from ``GET /user-practices/current/frequency``.
 * Validated at the boundary so a backend field rename/retype raises
 * ``ApiValidationError`` (the "Something changed on the server" path) instead of
 * the previous hand-rolled ``typeof`` check that threw a context-free error.
 */
export const frequencyResponseSchema = z.object({
  stage_number: z.number(),
  color: z.string(),
  aspect: z.string(),
  practice_name: z.string(),
  practice_id: z.number(),
  user_practice_id: z.number().nullable(),
  banner_text: z.string(),
});

// ---------------------------------------------------------------------------
// Completion suggestions (habit-resonance #819) — mirror the backend
// CompletionSuggestionResponse (no user_id) + the accept result.
// ---------------------------------------------------------------------------

export const completionTargetTypeSchema = z.enum(['habit', 'practice']);
export const suggestionStatusSchema = z.enum(['pending', 'accepted', 'dismissed']);

/** Matches the backend's CheckInResult (streak + milestones + reason). */
export const checkInResultSchema = z.object({
  streak: z.number().int(),
  milestones: z.array(z.object({ threshold: z.number().int() })),
  reason_code: z.string(),
});

export const completionSuggestionSchema = z.object({
  id: z.number().int(),
  journal_entry_id: z.number().int(),
  target_type: completionTargetTypeSchema,
  goal_id: z.number().int().nullable(),
  user_practice_id: z.number().int().nullable(),
  label: z.string(),
  anchor_start: z.number().int(),
  anchor_end: z.number().int(),
  anchor_text: z.string(),
  status: suggestionStatusSchema,
  accepted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const completionSuggestionListResponseSchema = z.object({
  items: z.array(completionSuggestionSchema),
});

export const acceptSuggestionResultSchema = z.object({
  suggestion: completionSuggestionSchema,
  // null for practice targets — a journal-attested PracticeSession has no streak (#821).
  check_in: checkInResultSchema.nullable(),
});

export type CompletionTargetTypeT = z.infer<typeof completionTargetTypeSchema>;
export type SuggestionStatusT = z.infer<typeof suggestionStatusSchema>;
export type CompletionSuggestionT = z.infer<typeof completionSuggestionSchema>;
export type AcceptSuggestionResultT = z.infer<typeof acceptSuggestionResultSchema>;

// ---------------------------------------------------------------------------
// Invitations (subtle invitation surface, NORTH-STAR §6) — mirror the backend
// InvitationResponse (bare array, no user_id).
// ---------------------------------------------------------------------------

export const invitationTargetTypeSchema = z.enum([
  'habit',
  'practice',
  'course',
  'sangha',
  'embodied_community',
]);
export const invitationKindSchema = z.enum(['readiness', 'consistency', 'mastery']);

/** One declinable invitation (mirrors the backend ``InvitationResponse``). */
export const invitationSchema = z.object({
  id: z.number(),
  target_type: invitationTargetTypeSchema,
  target_id: z.number().nullable(),
  kind: invitationKindSchema,
  created_at: z.string(),
});

export type InvitationTargetTypeT = z.infer<typeof invitationTargetTypeSchema>;
export type InvitationKindT = z.infer<typeof invitationKindSchema>;
export type InvitationT = z.infer<typeof invitationSchema>;

// ---------------------------------------------------------------------------
// Metta Return — the declinable five-week soft-landing arc. Mirrors the backend
// MettaReturnStateResponse: an eligibility flag, the full week sequence, and the
// caller's active arc (or null). No user_id is ever exposed.
// ---------------------------------------------------------------------------

/** The five classic Metta foci, one per Return week, in progression order. */
export const mettaFocusSchema = z.enum([
  'self',
  'benefactor',
  'stranger',
  'antagonist',
  'all_beings',
]);

/**
 * The Return arc runs exactly five weeks, and the backend clamps every reported
 * ordinal into ``[1, RETURN_WEEK_COUNT]`` (``domain.metta_return``). Pinning the
 * bound here means an out-of-range week (``0``, ``-1``, ``999``) raises
 * ``ApiValidationError`` at the client edge rather than rendering an undefined
 * week card downstream.
 */
const RETURN_MIN_WEEK = 1;
const RETURN_MAX_WEEK = 5;
const returnWeekNumber = z.number().int().min(RETURN_MIN_WEEK).max(RETURN_MAX_WEEK);

/** One week of the Return sequence: its ordinal, focus, and warm framing copy. */
export const returnWeekSchema = z.object({
  week_number: returnWeekNumber,
  focus: mettaFocusSchema,
  title: z.string(),
  framing: z.string(),
});

/** The caller's active arc projected to its current (possibly frozen) week. */
export const returnArcSchema = z.object({
  started_at: z.string(),
  paused: z.boolean(),
  week: returnWeekNumber,
  focus: mettaFocusSchema,
});

/** Eligibility plus the full week sequence and the active arc, if any. */
export const mettaReturnStateSchema = z.object({
  eligible: z.boolean(),
  weeks: z.array(returnWeekSchema),
  arc: returnArcSchema.nullable(),
});

export type MettaFocusT = z.infer<typeof mettaFocusSchema>;
export type ReturnWeekT = z.infer<typeof returnWeekSchema>;
export type ReturnArcT = z.infer<typeof returnArcSchema>;
export type MettaReturnStateT = z.infer<typeof mettaReturnStateSchema>;

// ---------------------------------------------------------------------------
// Resonance + marginalia + care (journal-resonance #891)
// ---------------------------------------------------------------------------

export const marginaliaKindSchema = z.enum(['theme', 'connection', 'symbol']);
export const marginaliaStatusSchema = z.enum(['active', 'stale']);

/** One margin note (mirrors the backend ``MarginaliaResponse``). */
export const marginaliaSchema = z.object({
  id: z.number().int(),
  journal_entry_id: z.number().int(),
  kind: marginaliaKindSchema,
  anchor_start: z.number().int(),
  anchor_end: z.number().int(),
  anchor_text: z.string(),
  note: z.string(),
  essay: z.string().nullable(),
  essay_generated_at: z.string().nullable(),
  status: marginaliaStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * The four non-clinical care routings (mirrors ``domain.care.CareKind``):
 * crisis ``hotline`` / ``text_line``, a trusted ``human``, and clinical
 * ``professional`` support. Anything else is a contract drift and is rejected
 * at the boundary so an unknown routing can never render an unlabelled card.
 */
export const careKindSchema = z.enum(['hotline', 'text_line', 'human', 'professional']);

/** One support pointer (mirrors the backend ``CareResourceResponse``). */
export const careResourceSchema = z.object({
  kind: careKindSchema,
  name: z.string(),
  contact: z.string(),
  what_it_is: z.string(),
});

/**
 * The care surface returned only on an acute-distress signal (NORTH-STAR §10):
 * a warm, non-shaming message plus the ordered human + professional resources.
 * Mirrors the backend ``CareResponse``; ``null`` on every ordinary entry.
 */
export const careResponseSchema = z.object({
  message: z.string(),
  resources: z.array(careResourceSchema),
});

/**
 * The two contraction routings (mirrors the backend contraction variants): a
 * gentle ``simple_ease_off`` nudge to tend a slipping foundation, and a warmer
 * ``return_offer`` inviting a fresh Return. Anything else is contract drift and
 * is rejected at the boundary so an unknown variant can never render untitled.
 */
export const contractionVariantSchema = z.enum(['simple_ease_off', 'return_offer']);

/**
 * The contraction surface returned when a pass senses a foundation easing off:
 * a variant that keys warm, declinable "tend your foundation" copy plus the
 * backend's own message. Mirrors the backend contraction reflection; ``null``
 * on every healthy or new entry.
 */
export const contractionReflectionSchema = z.object({
  variant: contractionVariantSchema,
  message: z.string(),
});

/**
 * Result of a resonance pass (mirrors the backend ``ResonanceResponse``).
 *
 * ``care`` is additive: it is ``None`` on every ordinary entry — absent on the
 * wire — so ``.nullish()`` keeps existing (no-care) responses validating and
 * behaving exactly as before. It is set only on an elevated signal.
 */
export const resonanceResponseSchema = z.object({
  marginalia: z.array(marginaliaSchema),
  suggestions: z.array(completionSuggestionSchema),
  remaining_messages: z.number().int(),
  remaining_balance: z.number().int(),
  monthly_reset_date: z.string(),
  care: careResponseSchema.nullish(),
  // Contraction reflection: a warm, declinable "tend your foundation" surface.
  // Additive/nullish so it is ``None`` (absent on the wire) on healthy or new
  // entries and older responses still validate and behave exactly as before.
  contraction: contractionReflectionSchema.nullish(),
  // Privacy gate: ``private`` is true when the pass was withheld for an
  // intimate entry, with optional reason copy. Additive/nullish so older
  // responses (which omit both) still validate and behave as before.
  private: z.boolean().optional(),
  private_message: z.string().nullish(),
});

export type CareKindT = z.infer<typeof careKindSchema>;
export type CareResourceT = z.infer<typeof careResourceSchema>;
export type CareResponseT = z.infer<typeof careResponseSchema>;
export type ContractionVariantT = z.infer<typeof contractionVariantSchema>;
export type ContractionReflectionT = z.infer<typeof contractionReflectionSchema>;
export type ResonanceResponseT = z.infer<typeof resonanceResponseSchema>;

// ---------------------------------------------------------------------------
// Depth preferences (you-choose-your-depth ring toggles)
// ---------------------------------------------------------------------------

/**
 * The four optional-depth toggles (mirrors the backend ``DepthPreferences``).
 * Each ring is on by default; a user opts *out* of a depth by flipping its
 * flag false. Validated at the boundary so a mis-shaped payload (e.g. a
 * stringly-typed "yes") raises ``ApiValidationError`` instead of quietly
 * corrupting a boolean toggle. Unknown keys are stripped (plain object, not
 * ``.strict()``) so an additive backend field cannot fail a client build.
 */
export const depthPreferencesSchema = z.object({
  enable_habits: z.boolean(),
  enable_practices: z.boolean(),
  enable_course: z.boolean(),
  enable_sangha: z.boolean(),
});

export type DepthPreferencesT = z.infer<typeof depthPreferencesSchema>;

// ---------------------------------------------------------------------------
// Wheel-of-wholeness balance (Map balance reading)
// ---------------------------------------------------------------------------

/**
 * One Aspect's fullness on the wheel-of-wholeness reading (mirrors the backend
 * ``WheelAspect``). ``fullness`` is a 0..1 fraction the Map clamps at the
 * boundary; validated at the client edge so a drifted field raises
 * ``ApiValidationError`` instead of a raw ``TypeError`` in the overlay. Unknown
 * keys are stripped (plain object, not ``.strict()``) so an additive backend
 * field cannot fail a client build.
 */
export const wheelAspectSchema = z.object({
  stage_number: z.number().int(),
  aspect: z.string(),
  fullness: z.number(),
});

/** The full wheel reading: one fullness entry per Aspect (mirrors ``WheelBalance``). */
export const wheelBalanceSchema = z.object({
  aspects: z.array(wheelAspectSchema),
});

export type WheelAspectT = z.infer<typeof wheelAspectSchema>;
export type WheelBalanceT = z.infer<typeof wheelBalanceSchema>;
