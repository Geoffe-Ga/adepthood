/**
 * The Sentry event payload, built by allow-list.
 *
 * Adepthood is a private journal, so a crash report that carried what the user
 * was writing would be a worse failure than the invisible crash it replaced.
 * The backend closes that off subtractively — it configures the vendor SDK to
 * capture nothing automatic and then scrubs what is left. This module closes it
 * off the other way, which is stronger: the payload is *constructed* from a
 * fixed set of fields, so there is no channel for user content to arrive
 * through in the first place. There are no breadcrumbs (no buffer exists), no
 * request data, no `extra`, and no user identity.
 *
 * Two fields could still carry something a user typed, and both are handled:
 * the exception message (redacted for credential shapes, then length-capped)
 * and the React component stack (component names only, by React's own
 * construction).
 *
 * Why hand-built rather than `@sentry/react-native`: that SDK is a native
 * module, and this is an Expo-managed app whose test suite could only ever
 * mock it — which would leave every privacy guarantee here asserted against a
 * mock instead of a payload. The envelope format below is version-pinned in
 * the auth header (`sentry_version=7`) and is exercised byte for byte by
 * `__tests__/sentryEnvelope.test.ts`.
 */

/** Marker substituted for anything credential-shaped. */
export const REDACTED = '[redacted]';

/**
 * Longest exception message a report may carry.
 *
 * A message is authored at the throw site, so it is the one field this module
 * cannot structurally guarantee. The cap bounds what a message that
 * interpolated something it should not have can carry away.
 */
export const MAX_MESSAGE_CHARS = 512;

/** Appended to a message the cap shortened, so a reader knows it is partial. */
export const TRUNCATION_MARKER = '…[truncated]';

/** Sentry protocol version this payload is written to. */
const SENTRY_PROTOCOL_VERSION = 7;

/** Client identifier Sentry records against each event. */
const SENTRY_CLIENT = 'adepthood-frontend/1.0';

/**
 * Structured context attached to a report — a **closed** union of exactly the
 * fields the error boundaries pass.
 *
 * Adding a field here is an explicit, reviewed decision: extend the interface
 * (with a sensitivity check) before a call site can pass it. A permissive
 * `Record<string, unknown>` once type-checked a future `{ auth: { token } }`.
 */
export interface ReportContexts {
  react?: { componentStack: string };
  errorBoundary?: { boundary: string; name?: string };
}

/** Where a report is posted, and the credential that authenticates it. */
export interface SentryTarget {
  envelopeUrl: string;
  authHeader: string;
}

/** Per-report values the caller supplies rather than this module inventing. */
export interface EventMeta {
  eventId: string;
  timestamp: string;
  environment: string;
  release: string;
}

/** A Sentry event, as the JSON object that goes on the wire. */
export type SentryEvent = Record<string, unknown>;

// `<scheme>://<publicKey>[:<deprecatedSecret>]@<host>/<optional prefix>/<projectId>`.
const DSN_PATTERN = /^(https?):\/\/([^:@/]+)(?::[^@/]*)?@([^/]+)(\/.*)$/;

// Credential shapes that can turn up in a message the app did not author: a
// bearer token echoed by a failed refresh, a JWT, a provider API key.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bbearer\s+[\w.~+/=-]{8,}/gi,
  /\bey[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g,
  /\bsk-[\w-]{8,}/g,
];

/**
 * Resolve a DSN into the endpoint and auth header a report is posted with.
 *
 * Returns `null` for anything it cannot parse rather than guessing: a
 * half-understood DSN would post reports into the void, which is the exact
 * silent failure this whole seam exists to remove.
 */
export function parseDsn(dsn: string): SentryTarget | null {
  const match = DSN_PATTERN.exec(dsn.trim());
  if (!match) {
    return null;
  }
  // Defaults keep the destructure total under ``noUncheckedIndexedAccess``;
  // a matched pattern always fills all four groups.
  const [, scheme = '', publicKey = '', host = '', path = ''] = match;
  const segments = path.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId) {
    return null;
  }
  const prefix = segments.length > 0 ? `/${segments.join('/')}` : '';
  return {
    envelopeUrl: `${scheme}://${host}${prefix}/api/${projectId}/envelope/`,
    authHeader:
      `Sentry sentry_version=${SENTRY_PROTOCOL_VERSION}, ` +
      `sentry_client=${SENTRY_CLIENT}, sentry_key=${publicKey}`,
  };
}

/** Replace credential-shaped substrings with {@link REDACTED}. */
export function redactCredentials(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED), text);
}

/** Redact then length-cap a string that is about to leave the device. */
function safeText(text: string): string {
  const redacted = redactCredentials(text);
  if (redacted.length <= MAX_MESSAGE_CHARS) {
    return redacted;
  }
  return redacted.slice(0, MAX_MESSAGE_CHARS) + TRUNCATION_MARKER;
}

/** Name and message of a thrown value, without assuming it is an `Error`. */
function describeError(error: unknown): { type: string; value: string } {
  if (error instanceof Error) {
    return { type: error.name, value: error.message };
  }
  return { type: 'UnknownError', value: String(error) };
}

/** Copy across only the contexts the interface declares. */
function allowlistedContexts(contexts?: ReportContexts): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  if (contexts?.react) {
    allowed.react = { componentStack: contexts.react.componentStack };
  }
  if (contexts?.errorBoundary) {
    allowed.errorBoundary = {
      boundary: contexts.errorBoundary.boundary,
      name: contexts.errorBoundary.name,
    };
  }
  return allowed;
}

/**
 * Build the event for one crash.
 *
 * Every key of the returned object is written here, by hand. That is the
 * privacy guarantee: nothing can be attached that this function does not name.
 */
export function buildEvent(
  error: unknown,
  contexts: ReportContexts | undefined,
  meta: EventMeta,
): SentryEvent {
  const { type, value } = describeError(error);
  return {
    event_id: meta.eventId,
    timestamp: meta.timestamp,
    platform: 'javascript',
    level: 'error',
    environment: meta.environment,
    release: meta.release,
    exception: { values: [{ type, value: safeText(value) }] },
    contexts: allowlistedContexts(contexts),
  };
}

/**
 * Serialise one event into a Sentry envelope.
 *
 * Three newline-separated lines: envelope header, item header, payload. The
 * item header deliberately omits `length` — Sentry then reads the payload to
 * the next newline, which sidesteps the classic bug of writing a *character*
 * count where a UTF-8 *byte* count is required. `JSON.stringify` escapes every
 * newline in the payload, so there is no newline to run into early.
 */
export function serializeEnvelope(event: SentryEvent, dsn: string, sentAt: string): string {
  const envelopeHeader = JSON.stringify({ event_id: event.event_id, sent_at: sentAt, dsn });
  const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json' });
  return `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}`;
}
