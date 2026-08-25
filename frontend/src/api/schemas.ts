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
 * Response for ``DELETE /users/me``: the receipt the server issues once an
 * account and its data are gone. ``erased`` / ``anonymised`` / ``retained``
 * are table names from the server's own deletion policy, so the confirmation
 * screen can report what actually happened rather than prose that drifts.
 */
export const accountDeletionReceiptSchema = z.object({
  recoverable: z.boolean(),
  rows_erased: z.number().int().nonnegative(),
  erased: z.array(z.string()),
  anonymised: z.array(z.string()),
  retained: z.array(z.string()),
  vault: z.object({
    configured: z.boolean(),
    purged: z.boolean(),
    guidance: z.string(),
  }),
});

export type AccountDeletionReceiptT = z.infer<typeof accountDeletionReceiptSchema>;

/**
 * Response for ``GET /users/me/export``: the whole archive.
 *
 * Validated at the envelope only. The collections underneath are the user's
 * own rows across two dozen tables, and a schema that pinned their shapes
 * would be a second copy of the backend's models that goes stale the first
 * time a column is added — turning an ordinary migration into a client that
 * refuses to hand somebody their journal back. What the client actually
 * depends on is the envelope: that this is an Adepthood archive, of a version
 * it understands, with named collections in it.
 */
export const dataExportArchiveSchema = z.object({
  format: z.literal('adepthood-export'),
  format_version: z.number().int().positive(),
  exported_at: z.string().min(1),
  records: z.record(z.string(), z.array(z.unknown())),
  not_included: z.record(z.string(), z.string()),
});

export type DataExportArchiveT = z.infer<typeof dataExportArchiveSchema>;

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
  energy_cost: z.number().int(),
  energy_return: z.number().int(),
  notification_times: z.array(z.string()).nullish(),
  notification_frequency: notificationFrequencySchema.nullish(),
  notification_days: z.array(z.string()).nullish(),
  milestone_notifications: z.boolean(),
  sort_order: z.number().int().nullish(),
  stage: z.string(),
  streak: z.number().int(),
  // Persisted unlock flag (revealed === unlocked). Optional on the wire so
  // payloads captured before the column shipped still validate; the live
  // backend always sends it.
  revealed: z.boolean().optional(),
  // Carryover flag (habit predates the program, shown on negative laps).
  // Optional on the wire so payloads captured before the column shipped
  // still validate.
  is_carryover: z.boolean().optional(),
});

export const habitWithGoalsSchema = habitSchema.extend({
  goals: z.array(goalSchema),
});

/** One weekly prompt + the user's response state (mirrors backend ``PromptDetail``). */
export const promptDetailSchema = z.object({
  week_number: z.number().int(),
  question: z.string(),
  has_responded: z.boolean(),
  response: z.string().nullable(),
  timestamp: z.string().nullable(),
  // The prompt's own title and its position in the week's sequence. Both are
  // ``str | None`` / ``int | None`` on the wire; without them declared here Zod
  // deleted them from every validated prompt response, so nothing downstream
  // could tell that the server had been sending them at all.
  default_title: z.string().nullish(),
  prompt_ordinal: z.number().int().nullish(),
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
  // A hierarchical reflection (week/stage/component/tier/program) is a journal
  // row like any other and appears in the same shelf list, so the enum must
  // accept it for the same reason it accepts ``weekly_prompt``.
  'hierarchical_reflection',
]);

/** Lowest Aspect tag (stage 1); the curriculum's first stage. */
const MIN_ASPECT = 1;
/** Highest Aspect tag (stage 10); the curriculum has ten stages. */
const MAX_ASPECT = 10;

/**
 * The two senders the client renders differently. The backend types ``sender``
 * as a bare ``str`` (``schemas/journal.py:128``), so a third value is one server
 * change away -- and a ``z.enum`` at a *list* boundary fails the whole response
 * over a single unrecognised row. Same reasoning as ``TIER_VALUES`` above:
 * accept the string at the boundary, narrow at the point of use.
 */
export const SENDER_VALUES = ['user', 'bot'] as const;
export type Sender = (typeof SENDER_VALUES)[number];

/**
 * Narrow a server-supplied sender, falling back to ``bot`` for anything else.
 *
 * ``bot`` rather than ``user`` on purpose: an unrecognised speaker is not the
 * person who was writing, and rendering someone else's words as theirs is the
 * worse of the two wrong answers.
 */
export function narrowSender(value: unknown): Sender {
  return typeof value === 'string' && (SENDER_VALUES as readonly string[]).includes(value)
    ? (value as Sender)
    : 'bot';
}

/** One journal message (mirrors the backend ``JournalMessage`` response). */
export const journalMessageSchema = z.object({
  id: z.number().int(),
  message: z.string(),
  sender: z.string(),
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
  // Hierarchical-journaling fields (``schemas/journal.py:137-138``). Zod strips
  // what it does not declare, so omitting these did not fail validation -- it
  // silently deleted them from every validated list response. Optional *and*
  // nullable to match the backend's ``str | None = None`` exactly.
  reflection_level: z.string().nullable().optional(),
  reflection_scope_key: z.string().nullable().optional(),
});

/** Journal list envelope: ``{ items, total, has_more }`` (bespoke, not ``Page``). */
export const journalListResponseSchema = z.object({
  items: z.array(journalMessageSchema),
  total: z.number().int(),
  has_more: z.boolean(),
});

/** Handwriting-transcription result: the OCR'd text of one journal page. */
export const transcribePageSchema = z.object({ text: z.string() });
export type TranscribePageT = z.infer<typeof transcribePageSchema>;

/**
 * What the vault did with one uploaded document — the wire strings of the
 * backend's ``VaultUploadStatus``. All four are distinct outcomes with distinct
 * remedies, so the enum is pinned rather than left as a bare string: a fifth
 * value the client has no honest sentence for must surface as
 * ``ApiValidationError`` rather than render as a blank row.
 */
export const vaultUploadStatusSchema = z.enum([
  'accepted',
  'vault_unavailable',
  'capability_unsupported',
  'degraded',
]);
export type VaultUploadStatusT = z.infer<typeof vaultUploadStatusSchema>;

/**
 * Where an imported document actually went — the backend's
 * ``ImportDestination``. Resolved per account by the server: an account that
 * has connected a vault reaches it, an account that has not reaches its own
 * ontologized corpus. The client never computes this; it reads it.
 */
export const importDestinationSchema = z.enum(['vault', 'corpus']);
export type ImportDestinationT = z.infer<typeof importDestinationSchema>;

/**
 * What the local corpus did with one imported document — the wire strings of
 * the backend's ``CorpusImportStatus``. Eight outcomes, one of which stores
 * anything, each with a different next step for the person holding the
 * document. Pinned rather than left as a bare string for the same reason
 * {@link vaultUploadStatusSchema} is: a ninth value this release has no honest
 * sentence for must surface as ``ApiValidationError`` rather than render blank.
 */
export const corpusImportStatusSchema = z.enum([
  'stored',
  'consent_required',
  'tier_refused',
  'format_unreadable',
  'not_text',
  'empty_document',
  'document_too_long',
  'unclassified',
]);
export type CorpusImportStatusT = z.infer<typeof corpusImportStatusSchema>;

/**
 * One document's import outcome, in whichever destination's vocabulary applies.
 *
 * ``destination`` is the discriminator, and exactly one side of the answer is
 * populated: a ``vault`` answer carries ``vault_status`` (and possibly
 * ``vault_ref`` and ``tags``), a ``corpus`` answer carries ``corpus_status``
 * (and possibly ``fragment_id``). ``stored`` is the one boolean both share, and
 * ``message`` is the backend's own self-serve sentence.
 */
export const documentImportSchema = z.object({
  destination: importDestinationSchema,
  stored: z.boolean(),
  vault_status: vaultUploadStatusSchema.nullable().optional(),
  vault_ref: z.string().nullable().optional(),
  tags: z.array(z.string()),
  corpus_status: corpusImportStatusSchema.nullable().optional(),
  fragment_id: z.number().int().nullable().optional(),
  message: z.string(),
});
export type DocumentImportT = z.infer<typeof documentImportSchema>;

// ---------------------------------------------------------------------------
// Per-item schemas for paginated endpoints (replacing loosePageSchema casts).
// The deep ``mode_config`` / ``mode_metadata`` payloads are validated
// server-side as discriminated unions, so they are accepted here as opaque
// records — the goal is item-level field/type drift detection, not re-deriving
// the whole ModeConfig union on the client.
// ---------------------------------------------------------------------------

/** One integrated or shadow expression of a stage (mirrors the backend ``StageExpression``). */
const stageExpressionSchema = z.object({
  name: z.string(),
  description: z.string(),
});

/**
 * The six canonical Wavelength phases, in order. Pinned as an enum so a drifted
 * or misspelled phase raises ``ApiValidationError`` at the boundary rather than
 * rendering an unlabelled block downstream.
 */
export const stageManifestationSchema = z.object({
  phase: z.enum(['Rising', 'Peaking', 'Withdrawal', 'Diminishing', 'Bottoming Out', 'Restoration']),
  integrated: stageExpressionSchema,
  shadow: stageExpressionSchema,
});

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
  // Per-phase integrated/shadow expressions. Optional so responses predating
  // the field still validate; the live backend always sends it.
  manifestations: z.array(stageManifestationSchema).optional(),
});

/** A user's stage-progress record (mirrors the backend ``StageProgressRecord``). */
export const stageProgressRecordSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  current_stage: z.number().int(),
  completed_stages: z.array(z.number().int()),
  cycle_number: z.number().int(),
});

export type StageProgressRecordT = z.infer<typeof stageProgressRecordSchema>;

/** The server's date-derived program calendar (mirrors ``ProgramCalendarResponse``). */
export const programCalendarSchema = z.object({
  program_started_at: z.string().nullable(),
  calendar_stage: z.number().int(),
  calendar_week: z.number().int(),
  current_stage: z.number().int(),
  cycle_number: z.number().int(),
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
  // No ``submitted_by_user_id``: ``PracticeResponse`` omits it so a catalog
  // GET can't become a user-id enumeration oracle (BUG-PRACTICE-001 /
  // BUG-SCHEMA-010).
  approved: z.boolean(),
  mode: z.string().optional(),
  mode_config: z.record(z.string(), z.unknown()).optional(),
});

/** One step of a practice recipe (mirrors ``PracticeRecipeStep``). */
export const practiceRecipeStepSchema = z.object({
  position: z.number().int(),
  tag_slug: z.string(),
  tag_label: z.string(),
  prompt_label: z.string(),
  target_count: z.number().int(),
});

/** A practice recipe (mirrors ``PracticeRecipe``). */
export const practiceRecipeSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  owner_user_id: z.number().int().nullable(),
  mode: z.enum(['sense_grounding', 'tallied_grounding']),
  rounds: z.number().int(),
  created_at: z.string(),
  steps: z.array(practiceRecipeStepSchema),
});

/** A user's selected practice (mirrors ``UserPractice``). */
export const userPracticeSchema = z.object({
  id: z.number().int(),
  // No ``user_id``: user-scoped responses omit it (OwnedResourcePublic / BUG-T7).
  practice_id: z.number().int(),
  stage_number: z.number().int(),
  start_date: isoDate,
  end_date: isoDate.nullable(),
  custom_name: z.string().nullish(),
  mode_config_override: z.record(z.string(), z.unknown()).nullish(),
  effective_name: z.string().nullish(),
  effective_config: z.record(z.string(), z.unknown()).nullish(),
});

/** A logged practice session (mirrors ``PracticeSessionResponse``). */
export const practiceSessionResponseSchema = z.object({
  id: z.number().int(),
  // No ``user_id``: user-scoped responses omit it (OwnedResourcePublic / BUG-T7).
  user_practice_id: z.number().int(),
  duration_minutes: z.number(),
  timestamp: isoDateTime,
  reflection: z.string().nullable(),
  mode: z.string().optional(),
  mode_metadata: z.record(z.string(), z.unknown()).nullish(),
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
  // No ``user_id``: ``GoalGroupResponse`` omits it (OwnedResourcePublic / BUG-T7).
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
  stage_number: z.number().int(),
  color: z.string(),
  aspect: z.string(),
  practice_name: z.string(),
  practice_id: z.number().int(),
  user_practice_id: z.number().int().nullable(),
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
  id: z.number().int(),
  target_type: invitationTargetTypeSchema,
  target_id: z.number().int().nullable(),
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
  // The backend always sends it; completion is the arc's reflective close.
  complete: z.boolean(),
});

/** A habit set to rest during a Return arc, with whether it has been taken up again. */
export const releasedHabitSchema = z.object({
  habit_id: z.number().int(),
  name: z.string(),
  icon: z.string(),
  recommitted: z.boolean(),
});

/** Eligibility, the week sequence, the active arc, the offer-dismissal flag, and any rested habits. */
export const mettaReturnStateSchema = z.object({
  eligible: z.boolean(),
  weeks: z.array(returnWeekSchema),
  arc: returnArcSchema.nullable(),
  offer_dismissed: z.boolean(),
  released_habits: z.array(releasedHabitSchema),
});

export type ReturnWeekT = z.infer<typeof returnWeekSchema>;
export type ReturnArcT = z.infer<typeof returnArcSchema>;
export type ReleasedHabitT = z.infer<typeof releasedHabitSchema>;
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
// ---------------------------------------------------------------------------
// Promoted quotes (select-a-span -> promote-quote)
// ---------------------------------------------------------------------------

/** A promoted quote (mirrors the backend ``PromotedQuoteResponse``). */
export const promotedQuoteSchema = z.object({
  id: z.number().int(),
  source_entry_id: z.number().int(),
  anchor_start: z.number().int(),
  anchor_end: z.number().int(),
  anchor_text: z.string(),
  pending: z.boolean(),
  // Whether the anchor no longer lines up with the entry's current text. The
  // server has always sent it; Zod dropped it on the floor, so the owner view
  // had no way to know a quote had come adrift from what it quotes.
  stale: z.boolean(),
});

/**
 * A promoted quote as it appears in the cross-entry sources feed (mirrors the
 * backend ``PromotedQuoteSummary``): the same shape minus ``source_entry_id``,
 * which the feed groups by rather than repeating on every row, and minus
 * ``stale``, which the feed does not compute for quotes drawn from other
 * entries.
 */
export const promotedQuoteSummarySchema = promotedQuoteSchema.omit({
  source_entry_id: true,
  stale: true,
});

export type PromotedQuoteT = z.infer<typeof promotedQuoteSchema>;
export type PromotedQuoteSummaryT = z.infer<typeof promotedQuoteSummarySchema>;

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
  // The server's own sentence for a pass that produced no margin notes. It is
  // prose rather than a code because only the server knows which of several
  // routes to zero notes was taken; a client picking copy from a flag would be
  // guessing at a cause it cannot see. Additive/nullish: a pass that kept notes
  // omits it, and older responses still validate and behave as before.
  no_notes_message: z.string().nullish(),
});

export type CareKindT = z.infer<typeof careKindSchema>;
export type CareResourceT = z.infer<typeof careResourceSchema>;
export type CareResponseT = z.infer<typeof careResponseSchema>;
export type ContractionVariantT = z.infer<typeof contractionVariantSchema>;
export type ContractionReflectionT = z.infer<typeof contractionReflectionSchema>;

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
// UI flags (per-account, server-owned one-time UI state)
// ---------------------------------------------------------------------------

// Per-account UI flags (mirrors the backend ``UiFlags``). Plain object, not
// ``.strict()``, so unknown keys are stripped and an additive backend field
// cannot fail a client build; a non-boolean field raises ApiValidationError.
export const uiFlagsSchema = z.object({
  has_seen_welcome: z.boolean(),
  energy_scaffolding_archived: z.boolean(),
});

export type UiFlagsT = z.infer<typeof uiFlagsSchema>;

// ---------------------------------------------------------------------------
// Corpus consent (what an account has agreed to have sorted into its corpus)
// ---------------------------------------------------------------------------

/**
 * One account's current decision about one source (mirrors the backend
 * ``CorpusConsentResponse``).
 *
 * ``source`` is a plain string rather than an enum of the three the API serves
 * today: the backend reports every source it knows, in its own order, so that a
 * kind of material added later reaches the consent surface without a client
 * release. A client that validated against a frozen list would reject the whole
 * response the day that happened — turning an added row into a broken screen.
 *
 * ``decided_at`` is nullable because "never asked" is a state, not a missing
 * field. Requiring a datetime here would make a brand-new account's honest
 * answer look like a malformed response.
 */
export const corpusConsentSchema = z.object({
  source: z.string().min(1),
  granted: z.boolean(),
  decided_at: isoDateTime.nullable(),
});

/** Every source, decided or not, in the order the backend declares them. */
export const corpusConsentListSchema = z.object({
  sources: z.array(corpusConsentSchema),
});

export type CorpusConsentT = z.infer<typeof corpusConsentSchema>;
export type CorpusConsentListT = z.infer<typeof corpusConsentListSchema>;

// ---------------------------------------------------------------------------
// Private vault (whether an account has connected a space of its own)
// ---------------------------------------------------------------------------

/**
 * One account's vault connection (mirrors the backend ``VaultConnectionResponse``).
 *
 * ``vault_url`` is nullable because an account that has connected nothing is a
 * state, not a malformed response: the route answers every account, never a
 * 404, so a schema that refused the null would turn "you have no vault yet"
 * into an error screen on a perfectly good reply.
 *
 * There is deliberately no request-side counterpart. Requests are not
 * Zod-validated in this client, and a ``*Schema`` export carrying the vault
 * credential would put that field in every table this module's schemas feed --
 * conformance reports, generated docs, error dumps. The credential travels on
 * one body and is described by an interface in ``index.ts`` instead.
 */
export const vaultConnectionResponseSchema = z.object({
  connected: z.boolean(),
  vault_url: z.string().nullable(),
});

export type VaultConnectionT = z.infer<typeof vaultConnectionResponseSchema>;

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

// ---------------------------------------------------------------------------
// Hierarchical reflections (the 7th-day reflection invitation + sources feed)
// ---------------------------------------------------------------------------

/**
 * The reflection scope a due window covers, in ascending breadth: a single
 * ``week``, a Wavelength ``stage``, a curriculum ``component``, a ``tier`` of
 * stages, or the whole ``program``. Mirrors the backend ``ReflectionLevel``;
 * an unknown value is rejected at the boundary so it can never key untitled copy.
 */
export const reflectionLevelSchema = z.enum(['week', 'stage', 'component', 'tier', 'program']);

/** Whether a source row is a plain journal entry or an earlier reflection. */
export const reflectionSourceKindSchema = z.enum(['entry', 'reflection']);

/**
 * A currently-due reflection window (mirrors the backend ``ReflectionDue``).
 * ``existing_entry_id`` is set when an in-progress reflection already exists for
 * this scope, so the invitation can resume it rather than open a fresh page.
 */
export const reflectionDueSchema = z.object({
  level: reflectionLevelSchema,
  scope_key: z.string(),
  window_start: isoDateTime,
  window_end: isoDateTime,
  existing_entry_id: z.number().int().nullable(),
});

/**
 * One rereadable source in the reflection's sources feed (mirrors the backend
 * ``ReflectionSourceItem``): an entry or an earlier reflection, with any promoted
 * quotes the reader can fold into the new reflection. ``reflection_level`` is a
 * free string label (present only on ``reflection`` rows) so a future backend
 * level cannot fail the whole feed at the client edge.
 */
export const reflectionSourceItemSchema = z.object({
  kind: reflectionSourceKindSchema,
  id: z.number().int(),
  title: z.string().nullable(),
  timestamp: isoDateTime,
  body: z.string(),
  reflection_level: z.string().nullable(),
  promoted_quotes: z.array(promotedQuoteSummarySchema),
});

/** ``GET /reflections/due`` envelope: the due window, or ``null`` when nothing is due. */
export const reflectionDueResponseSchema = z.object({ due: reflectionDueSchema.nullable() });

/** ``GET /reflections/sources`` envelope: the chronological source feed. */
export const reflectionSourcesResponseSchema = z.object({
  items: z.array(reflectionSourceItemSchema),
});

export type ReflectionLevelT = z.infer<typeof reflectionLevelSchema>;
export type ReflectionDueT = z.infer<typeof reflectionDueSchema>;
export type ReflectionSourceItemT = z.infer<typeof reflectionSourceItemSchema>;
