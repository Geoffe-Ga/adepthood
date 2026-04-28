/**
 * Centralised translation of backend error codes and network failures to
 * **user-facing** messages.
 *
 * Philosophy: an error message is not a debug log. It's the last thing the
 * user reads before deciding whether to self-serve, retry, or give up. Every
 * message in this file should:
 *
 *  1. Name what happened in plain language (no snake_case, no jargon).
 *  2. Tell the user exactly what they can do next.
 *  3. Avoid shame ("oops", "sorry") — people just want to get unstuck.
 *
 * The backend returns stable snake_case ``detail`` strings (see
 * ``backend/src/errors.py``) as an API contract. This module is the single
 * place that turns those contract strings into copy that a real person can
 * act on. If you add a new backend error code, add its translation here too.
 */
import { ApiError, ApiTimeoutError, ApiValidationError } from './index';

// Shared copy fragments — duplicated strings trip sonarjs/no-duplicate-string
// and, more importantly, drift when we eventually tweak the tone.
const PULL_TO_REFRESH = 'Pull down to refresh and try again.';
const CHECK_CONNECTION = 'Check your connection and try again.';
const PROVIDER_TROUBLE =
  "BotMason's AI provider is having trouble connecting. Give it a moment and tap retry.";
const SESSION_EXPIRED = 'Your session has expired. Sign back in to continue.';
const NO_ACCESS = "You don't have access to this.";

/**
 * Map of backend ``detail`` strings (see ``backend/src/errors.py`` and each
 * router) to the copy we show the user. Keep keys in sync with the backend
 * and grouped by domain for easy scanning.
 */
export const USER_FACING_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // --- Authentication --------------------------------------------------
  invalid_credentials:
    "That email and password don't match an account we have. Double-check both fields, or tap Sign Up if you're new.",
  password_too_short: 'Pick a password that is at least 8 characters long.', // pragma: allowlist secret
  unauthorized: SESSION_EXPIRED,
  // BUG-API-018: distinct copy when the request was anonymous in the
  // first place -- "your session expired" implies a session that was
  // never there.  Surfaced via the ``not_authenticated`` reason from
  // the API client's 401 classifier.
  not_authenticated: 'Sign in to use this part of the app.',
  // ``invalid_token`` is what the API client surfaces when the server
  // rejects a stored token outright (forged / revoked).  Treat as a
  // hard sign-back-in rather than a transient session lapse.
  invalid_token: 'You have been signed out for security. Sign in again to continue.',

  // --- Admin -----------------------------------------------------------
  admin_required: 'Admin privileges are required for this action.',

  // --- Resource not found ----------------------------------------------
  stage_not_found: `We couldn't find that stage. ${PULL_TO_REFRESH}`,
  content_not_found: `We couldn't find that lesson. Try opening it again from the stage overview.`,
  practice_not_found: `We couldn't find that practice. ${PULL_TO_REFRESH}`,
  habit_not_found: `We couldn't find that habit — it may have been deleted. ${PULL_TO_REFRESH}`,
  journal_entry_not_found:
    "We couldn't find that journal entry. It may have been deleted from another device.",
  goal_not_found: `We couldn't find that goal. ${PULL_TO_REFRESH}`,
  goal_group_not_found: `We couldn't find that goal group. ${PULL_TO_REFRESH}`,
  prompt_not_found:
    "This week's prompt isn't ready yet. Check back in a few minutes, or pull down to refresh.",
  user_practice_not_found:
    "We couldn't find your practice selection. Pick a practice again to continue.",
  user_not_found: "We couldn't find your account. Sign out and sign back in to reconnect.",

  // --- Permission / ownership ------------------------------------------
  forbidden: `${NO_ACCESS} If you think this is a mistake, sign out and back in.`,
  not_owner: "That item belongs to another account, so you can't change it from here.",

  // --- State / validation ----------------------------------------------
  cannot_go_backwards:
    "You can't move to an earlier stage — APTITUDE is designed to progress forward only.",
  already_responded: "You've already answered this week's prompt. A new one unlocks each week.",
  practice_not_approved:
    "That practice isn't available for selection yet. Pick one of the approved options for this stage.",
  habits_must_not_be_empty:
    'Add at least one habit before generating an energy plan. You can add habits from the Habits tab.',

  // --- Wallet / BotMason quota -----------------------------------------
  payment_required:
    "You've reached this month's free allotment. Add your own API key in Settings, or wait until the next monthly reset.",
  insufficient_offerings:
    "You've used all your free BotMason messages for the month. Add your own API key in Settings, or wait until your next monthly reset.",
  llm_key_required:
    'BotMason needs a key to reply. Add your API key in Settings to start chatting.',
  invalid_llm_api_key_format:
    "That API key doesn't look right. Copy the full key from your OpenAI or Anthropic dashboard and paste it into Settings.",

  // --- Streaming / rate limits / network -------------------------------
  rate_limit_exceeded:
    "You're sending messages faster than BotMason can keep up. Slow down to 10 messages per minute.",
  llm_provider_error: PROVIDER_TROUBLE,
  malformed_stream_frame: PROVIDER_TROUBLE,
  incomplete_stream:
    'The connection dropped before BotMason finished its reply. Tap retry to send the same message again.',
  network_error: `You appear to be offline. ${CHECK_CONNECTION}`,

  // --- Database / infra ------------------------------------------------
  'Database unavailable':
    "We can't reach the database right now. Give it a moment, then pull down to refresh.",
});

/**
 * Fallback copy when the server returns an unrecognised ``detail`` string.
 * Keyed by HTTP status so a generic 404 still feels different from a
 * generic 500 — each code leads the user to a different remedy.
 */
const STATUS_FALLBACKS: Readonly<Record<number, string>> = Object.freeze({
  400: "That didn't go through. Double-check what you entered and try again.",
  401: SESSION_EXPIRED,
  402: "You've reached this month's free allotment. Add your own API key in Settings, or wait until the next monthly reset.",
  403: NO_ACCESS,
  404: `We couldn't find what you were looking for. ${PULL_TO_REFRESH}`,
  409: 'That conflicts with something we already have. Refresh and try again.',
  422: "Some of what you entered doesn't look right. Review the highlighted fields and try again.",
  429: "You're going a bit fast for us. Slow down and try again in a moment.",
  500: 'Something went wrong on our end. Give it a moment and try again — if it keeps happening, let us know.',
  502: PROVIDER_TROUBLE,
  503: 'The service is temporarily unavailable. Give it a moment, then try again.',
  504: 'The server took too long to respond. Check your connection, then try again.',
});

/** Last-resort copy when we have nothing else to go on (e.g. no status). */
export const GENERIC_FALLBACK =
  "Something didn't work as expected. Give it a moment and try again.";

/**
 * Translate a known backend error code, or return ``undefined`` if we don't
 * recognise it. Lets callers fall back to their own context-aware copy
 * ("Failed to save session") instead of the generic status-code fallback.
 */
export function messageForCode(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return USER_FACING_ERROR_MESSAGES[code];
}

/**
 * Options for ``formatApiError``. ``fallback`` is preferred over the
 * status-code map when supplied — screens often know what the user was
 * trying to do and can phrase the failure more concretely than a generic
 * 500 message.
 */
export interface FormatErrorOptions {
  /** Copy shown when the error code is unknown AND no status fallback fits. */
  fallback?: string;
  /**
   * Per-status override. Useful when, e.g., a 404 on the practice screen
   * should read "We couldn't find that practice — pull to refresh" rather
   * than the default 404 copy.
   */
  statusOverrides?: Partial<Record<number, string>>;
}

type ErrorLike = {
  detail?: unknown;
  status?: unknown;
  message?: unknown;
};

function extractDetail(err: ErrorLike): string | undefined {
  return typeof err.detail === 'string' && err.detail.length > 0 ? err.detail : undefined;
}

function extractStatus(err: ErrorLike): number | undefined {
  return typeof err.status === 'number' ? err.status : undefined;
}

function pickByStatus(status: number | undefined, options: FormatErrorOptions): string | undefined {
  if (status === undefined) return undefined;
  return options.statusOverrides?.[status];
}

function statusFallback(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  return STATUS_FALLBACKS[status];
}

function readableMessage(errish: ErrorLike): string | undefined {
  const message = typeof errish.message === 'string' ? errish.message : '';
  if (!message) return undefined;
  // The synthetic ``ApiError`` message ``Request failed with status N: detail``
  // is debug text — never surface it to users.
  if (message.startsWith('Request failed with status')) return undefined;
  return message;
}

/**
 * BUG-FRONTEND-INFRA-016 — timeouts deserve their own, more actionable copy
 * than the generic ``fallback``. These are used both by
 * ``formatApiError`` and by screens that want to branch on the distinction.
 */
export const TIMEOUT_MESSAGE =
  'The request took too long. Check your connection and try again in a moment.';
export const VALIDATION_MESSAGE =
  "Something changed on the server and we couldn't read the response. Update the app if an update is available, or try again shortly.";

function isTimeout(err: unknown): boolean {
  // Guard against the class reference being undefined in test contexts that
  // mock the api module — ``instanceof undefined`` throws a TypeError.
  if (ApiTimeoutError && err instanceof ApiTimeoutError) return true;
  return err instanceof Error && err.name === 'ApiTimeoutError';
}

function isValidation(err: unknown): boolean {
  if (ApiValidationError && err instanceof ApiValidationError) return true;
  return err instanceof Error && err.name === 'ApiValidationError';
}

/**
 * Universal ``unknown`` → user-facing-string converter. Handles:
 *
 *  - ``ApiTimeoutError`` — timeout-specific copy before status/detail mapping
 *  - ``ApiValidationError`` — "server response didn't match expectations"
 *  - ``ApiError`` / any object with ``.detail`` and ``.status`` fields
 *  - Plain ``Error`` instances (falls back to ``options.fallback``)
 *  - Objects with only a ``.message`` property
 *  - ``null`` / ``undefined`` / anything else
 *
 * Resolution order (most specific → least specific):
 *   1. Timeout / validation branches — the user-visible messaging changes
 *      materially for these network-level classes of failure
 *   2. Known backend code       — consistent copy cross-screen
 *   3. Caller status override   — explicit per-screen override for one status
 *   4. Caller fallback          — screen-specific copy ("Couldn't save session…")
 *   5. Generic status fallback  — per-HTTP-status default
 *   6. Raw ``.message``         — if it reads like human prose
 *   7. GENERIC_FALLBACK
 */
function classifyNetworkError(err: unknown): string | undefined {
  if (isTimeout(err)) return TIMEOUT_MESSAGE;
  if (isValidation(err)) return VALIDATION_MESSAGE;
  return undefined;
}

export function formatApiError(err: unknown, options: FormatErrorOptions = {}): string {
  if (err == null) return options.fallback ?? GENERIC_FALLBACK;

  const network = classifyNetworkError(err);
  if (network !== undefined) return network;

  const errish = err as ErrorLike;
  const status = extractStatus(errish);

  const resolved =
    messageForCode(extractDetail(errish)) ??
    pickByStatus(status, options) ??
    options.fallback ??
    statusFallback(status) ??
    readableMessage(errish);

  return resolved ?? GENERIC_FALLBACK;
}

/**
 * Narrower helper for BotMason chat where callers already have a raw
 * backend ``detail`` string (e.g. from an SSE ``error`` frame) and want
 * the mapped user copy. Preserves the old ``JournalScreen`` API.
 */
export function mapDetailToMessage(detail: string): string {
  return messageForCode(detail) ?? PROVIDER_TROUBLE;
}

// Re-export for use in contexts that can't import ``ApiError`` directly
// without creating a circular import.
export { ApiError };
