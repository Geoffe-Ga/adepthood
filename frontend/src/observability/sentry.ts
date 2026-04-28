/**
 * Sentry integration shim for the React Native client (BUG-FE-UI-101 / -102).
 *
 * The real ``@sentry/react-native`` package is intentionally NOT installed
 * yet — once ops provisions a DSN, swap the body of {@link reportException}
 * for ``Sentry.captureException(error, { contexts })`` and {@link
 * reportMessage} for ``Sentry.captureMessage(message, { extra })``.  The
 * call sites elsewhere in the app do not need to change because the
 * function signatures match the SDK's public surface 1:1.
 *
 * Until then we log to ``console.error`` / ``console.warn`` with the same
 * structured ``contexts`` payload so a developer running the app via
 * Expo + a remote-debugger can still see the traceback alongside the
 * scoping metadata (component name, current screen, etc.).
 */

/**
 * Structured context attached to a Sentry capture.
 *
 * Mirrors Sentry's ``contexts`` argument shape: a top-level dictionary
 * keyed by a context name (``"react"``, ``"app"``, …) whose value is a
 * key-value object specific to that context.  Keeping the type loose
 * means a caller can attach a ``componentStack``, the active route
 * name, or the user id without us prescribing every field.
 */
export type ReportContexts = Record<string, Record<string, unknown>>;

/**
 * Forward an unhandled exception to the observability backend.
 *
 * Today logs to ``console.error`` with the supplied contexts; once the
 * Sentry DSN lands the body is a single ``Sentry.captureException`` call.
 */
export function reportException(error: unknown, contexts?: ReportContexts): void {
  // TODO(ops): replace with ``Sentry.captureException(error, { contexts })``
  // — see prompts/2026-04-18-bug-remediation/remediation-plan/10-observability-e2e.md
  console.error('[reportException]', error, contexts ?? {});
}

/**
 * Forward a soft warning that did not produce an exception.
 *
 * Used by callers that detected an unexpected state (e.g. an API
 * response that parsed but had unexpected nullable fields) and want
 * a Sentry breadcrumb without raising.
 */
export function reportMessage(message: string, contexts?: ReportContexts): void {
  // TODO(ops): replace with ``Sentry.captureMessage(message, { contexts })``
  // — see prompts/2026-04-18-bug-remediation/remediation-plan/10-observability-e2e.md
  console.warn('[reportMessage]', message, contexts ?? {});
}
