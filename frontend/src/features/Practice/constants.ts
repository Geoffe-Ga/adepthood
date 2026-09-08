/**
 * Stage-number constants shared by the practice catalog, detail, and wizard
 * screens (custom-practices-07).
 *
 * The 36-week APTITUDE program has exactly ten stages (Beige → Clear Light);
 * the backend ``schemas.practice.PracticeCreate`` mirrors the same range via
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
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/features/Practice/engine/types';

export const MIN_STAGE = 1;
export const MAX_STAGE = 10;
export const FALLBACK_STAGE = 1;

/** Practice sessions that make up a full week's goal — the single source of truth for the weekly target. */
export const WEEKLY_TARGET = 4;

/** The inclusive integer stage range ``MIN_STAGE..MAX_STAGE`` as an array. */
export const stageRange = (): number[] =>
  Array.from({ length: MAX_STAGE - MIN_STAGE + 1 }, (_, i) => MIN_STAGE + i);

/**
 * Client mirror of the server's practice-session window.
 *
 * The source of truth is ``backend/src/schemas/practice.py`` —
 * ``MAX_FUTURE_SKEW``, ``MAX_BACKDATE_WINDOW`` and ``MAX_SESSION_DURATION``
 * (BUG-PRACTICE-006, BUG-SCHEMA-008). The manual-log form mirrors them so a
 * person is told their chosen time is outside the window instead of spending
 * a doomed request on it; `__tests__/sessionWindowDrift.test.ts` reads those
 * literals out of the Python and fails when either side moves.
 *
 * All three bounds are **inclusive** on the server (`<=` on every rule), so
 * the client's guards are inclusive too — see `utils/sessionWindow.ts`.
 */
export const MAX_FUTURE_SKEW_SECONDS = 60;
export const MAX_BACKDATE_HOURS = 24;
export const MAX_SESSION_HOURS = 8;

/** Minutes in one hour — the multiplier the millisecond bounds are built from. */
export const MINUTES_PER_HOUR = 60;
/** Milliseconds in one hour, derived from the engine's minute constant. */
export const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;

/** How far ahead of "now" a session may end (clock-skew tolerance). */
export const MAX_FUTURE_SKEW_MS = MAX_FUTURE_SKEW_SECONDS * MS_PER_SECOND;
/** How far in the past a session may have started. */
export const MAX_BACKDATE_WINDOW_MS = MAX_BACKDATE_HOURS * MS_PER_HOUR;
/** The longest single sitting the server will record. */
export const MAX_SESSION_DURATION_MS = MAX_SESSION_HOURS * MS_PER_HOUR;
