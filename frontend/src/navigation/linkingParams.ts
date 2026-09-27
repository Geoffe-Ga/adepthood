// frontend/src/navigation/linkingParams.ts

/**
 * Deep-link param codecs for the ``linking`` config (#2958).
 *
 * React Navigation hands every path segment and query value to a screen as a
 * **string**. ``RootTabParamList`` promises numbers, and the screens compare
 * with strict equality (``up.stage_number === stageNumber``), so an unparsed
 * ``/practice/1`` rendered the empty state and ``/course/1`` highlighted no
 * stage. Each parser below is total: it returns a real number or
 * ``undefined``, never ``NaN`` and never the raw string. ``undefined`` falls
 * into the screens' existing "nothing asked for" branches, so an invalid link
 * derives the current stage (and keeps the unconfirmed-stage notice) rather
 * than rendering "Stage NaN" or inventing a stage.
 *
 * Sweep of every param reachable through ``linking``:
 *
 * | Screen.param              | Arrives as | Outcome                          |
 * | ------------------------- | ---------- | -------------------------------- |
 * | Practice.stageNumber      | string     | parsed ({@link parseStageNumberParam}) |
 * | Course.stageNumber        | string     | parsed ({@link parseStageNumberParam}) |
 * | Course.contentId          | string     | parsed ({@link parseContentIdParam})   |
 * | Course.scrollOffset       | string     | parsed ({@link parseScrollOffsetParam}) |
 * | SharePreview.token        | string     | string by design                 |
 * | ResetPassword.token       | string     | string by design                 |
 * | CancelReset.token         | string     | string by design                 |
 * | Signup.licenseKey         | string     | string by design                 |
 * | Catalog.stageNumber       | n/a        | not in the config; reached only by in-app numeric navigate |
 */
import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';

const DIGITS_ONLY = /^\d+$/;
const NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Parse a stage-number segment into an integer in ``MIN_STAGE..MAX_STAGE``.
 *
 * Anything else ('abc', '0', '11', '1.5', '') is ``undefined`` so the screen
 * derives the user's real current stage instead of a fabricated one.
 */
export function parseStageNumberParam(raw: string): number | undefined {
  if (!DIGITS_ONLY.test(raw)) return undefined;
  const stage = Number(raw);
  return stage >= MIN_STAGE && stage <= MAX_STAGE ? stage : undefined;
}

/**
 * Parse a course ``contentId`` query value into a positive safe integer.
 *
 * ``undefined`` means "no reading to restore", which the reader already
 * handles; a non-integer id could never match a content row anyway.
 */
export function parseContentIdParam(raw: string): number | undefined {
  if (!DIGITS_ONLY.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Parse a course ``scrollOffset`` query value into a finite, non-negative
 * number of pixels.
 *
 * ``undefined`` means "open at the top", the reader's default.
 */
export function parseScrollOffsetParam(raw: string): number | undefined {
  if (!NON_NEGATIVE_DECIMAL.test(raw)) return undefined;
  const offset = Number(raw);
  return Number.isFinite(offset) ? offset : undefined;
}
