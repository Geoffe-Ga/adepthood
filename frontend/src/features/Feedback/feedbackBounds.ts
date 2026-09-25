/**
 * The client's copy of the beta-feedback intake bounds (#2897).
 *
 * Each value mirrors a named constant in `backend/src/models/feedback.py` or a
 * pattern in `backend/src/schemas/feedback.py`, and `feedbackBoundsDrift.test.ts`
 * reads both files and fails the moment the two sides disagree. The composer
 * validates against these BEFORE the network call, and a little more strictly
 * than the server does: a summary is trimmed before its length is counted, so
 * whitespace-only text never leaves the device.
 */

/** A summary must say something once trimmed. */
export const FEEDBACK_SUMMARY_MIN_LENGTH = 1;
/** One sentence, not an essay (`FEEDBACK_SUMMARY_MAX_LENGTH`). */
export const FEEDBACK_SUMMARY_MAX_LENGTH = 280;
/** Each of intent / expected / actual (`FEEDBACK_ANSWER_MAX_LENGTH`). */
export const FEEDBACK_ANSWER_MAX_LENGTH = 2000;
export const FEEDBACK_SCREEN_MAX_LENGTH = 64;
export const FEEDBACK_CONTROL_MAX_LENGTH = 64;
export const FEEDBACK_BUILD_MAX_LENGTH = 32;
export const FEEDBACK_LOCALE_MAX_LENGTH = 16;

/**
 * The grammar a screen token is spelled in: `journal.shelf`. The server accepts
 * only its closed `FeedbackScreen` vocabulary, which is narrower; the client's
 * copy of that vocabulary is `SCREEN_TOKEN_BY_ROUTE` plus `UNKNOWN_SCREEN_TOKEN`.
 */
export const SCREEN_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
/** The originating control, or a stable error code, in the same token shape. */
export const CONTROL_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
/**
 * A build identifier: `1.4.2`, `1.4.2+318`, `2026.09.17-beta`. Numbers and dots,
 * then at most a numeric build or a named prerelease stage -- no free-form
 * suffix and no commit hash, either of which could carry a word.
 */
export const BUILD_PATTERN = /^[0-9]+(\.[0-9]+){1,3}(\+[0-9]+|-(alpha|beta|rc)(\.[0-9]+)?)?$/;
/** A BCP-47 tag narrowed to language plus an optional two-letter region. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
