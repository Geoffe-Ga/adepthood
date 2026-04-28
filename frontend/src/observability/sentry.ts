/**
 * Sentry integration shim for the React Native client (BUG-FE-UI-101 / -102).
 *
 * The real ``@sentry/react-native`` package is intentionally NOT installed
 * yet — once ops provisions a DSN, swap the body of {@link reportException}
 * for ``Sentry.captureException(error, { contexts })``.  The call sites
 * elsewhere in the app do not need to change because the function
 * signature matches the SDK's public surface 1:1.
 *
 * Unlike the backend stub (which is a silent no-op because every call
 * site logs through Python's ``logging`` first), the frontend stub
 * logs via ``console.error`` because ``ErrorBoundary.componentDidCatch``
 * has no other logging path — without this a caught render error would
 * vanish from the dev console entirely.
 *
 * A ``reportMessage`` companion is intentionally NOT defined here —
 * no current code path needs it, and CLAUDE.md forbids speculative
 * scaffolding.  Add it alongside the first call site that warrants
 * a soft warning being shipped to Sentry.
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
