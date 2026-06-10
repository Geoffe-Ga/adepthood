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
 * Mirrors Sentry's ``contexts`` argument shape, but as a **closed union**
 * of exactly the fields the error boundaries pass today (issue #272).
 * The previous ``Record<string, Record<string, unknown>>`` type-checked
 * any payload — including a future ``{ auth: { token } }`` that would
 * ship a credential to Sentry the moment the real DSN lands.  Adding a
 * field here is an explicit, reviewed decision: extend the interface
 * (with a sensitivity check) before a call site can pass it.
 */
export interface ReportContexts {
  react?: { componentStack: string };
  errorBoundary?: { boundary: string; name?: string };
}

/**
 * Forward an unhandled exception to the observability backend.
 *
 * Today logs to ``console.error`` with the supplied contexts so a
 * developer running the app via Expo + remote debugger can still see
 * caught render errors.  Once the ``@sentry/react-native`` SDK is
 * installed and the DSN env var is provisioned, replace the body with
 * ``Sentry.captureException(error, { contexts })`` — the function
 * signature already matches the SDK's public surface, so call sites
 * do not need to change.
 */
export function reportException(error: unknown, contexts?: ReportContexts): void {
  console.error('[reportException]', error, contexts ?? {});
}
