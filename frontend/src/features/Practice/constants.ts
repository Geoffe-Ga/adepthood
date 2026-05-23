/**
 * Stage-number constants shared by the practice catalog, detail, and wizard
 * screens (custom-practices-07).
 *
 * The 36-week APTITUDE program has exactly ten stages (Beige → Coral); the
 * backend ``schemas.practice.PracticeCreate`` mirrors the same range via
 * ``Field(ge=1, le=MAX_STAGE_NUMBER)``. Centralising the bounds here means
 * a future stage-count change is a one-line edit instead of a three-file
 * grep.
 *
 * ``FALLBACK_STAGE`` is the value sent for ``stage_number`` when the user
 * picks "Skip" in the create wizard. The backend's ``PracticeCreate`` schema
 * still requires a non-null stage_number on the practice row (catalog rows
 * are stage-scoped), so we mint the draft under stage 1; the caller skips
 * the follow-up ``POST /user-practices`` so the draft is *stored* but not
 * *active* anywhere. A future schema relaxation could let drafts carry a
 * null stage; until then this constant is the single, named place that
 * encodes the workaround.
 */

export const MIN_STAGE = 1;
export const MAX_STAGE = 10;
export const FALLBACK_STAGE = 1;
