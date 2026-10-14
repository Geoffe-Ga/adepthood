/**
 * The Sentry event payload, built by allow-list.
 *
 * Adepthood is a private journal, so a crash report that carried what the user
 * was writing would be a worse failure than the invisible crash it replaced.
 * The payload is therefore *constructed* from a fixed set of fields -- the
 * backend rebuilds its events from an allowlist the same way -- so there is no
 * channel for user content to arrive through in the first place. There are no
 * breadcrumbs (no buffer exists), no request data, no `extra`, and no user
 * identity.
 *
 * The exception message is not one of those fields. It is authored at the
 * throw site, so it can interpolate whatever the user was writing, and no cap
 * makes a short message safe: every report carries {@link MESSAGE_WITHHELD}
 * in its place (#3064). Error types, boundary identifiers and feature names
 * are closed runtime enums. Component stacks are dropped: component names
 * and display names can contain private text too (#3210).
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
 * Reported in place of every exception message. The same marker the backend
 * reports, so the operator inbox reads one vocabulary.
 */
export const MESSAGE_WITHHELD = 'message_withheld';

/** Reported as the type of a thrown value that is not an `Error`. */
export const UNKNOWN_ERROR_TYPE = 'UnknownError';

/** Reported as the type of an `Error` whose `name` is not an approved fixed type. */
const FALLBACK_ERROR_TYPE = 'Error';

// Assignable names are safe only when they match an explicitly approved
// identifier, never merely because they look like a class name.
const ERROR_TYPES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'AbortError',
  'DOMException',
  'ApiError',
  'ApiValidationError',
  'ApiTimeoutError',
  'TranscriptionError',
  'DocumentUploadError',
  'DirectVendorError',
  'EmptyApiKeyError',
  'EmptyAuthTokenError',
  'ClientMintedIdError',
  'SilentRenderError',
  'MarginSlotInputError',
]);
const BOUNDARIES = new Set(['ErrorBoundary', 'FeatureErrorBoundary']);
const FEATURES = new Set(['Auth', 'App', 'Habits', 'Practice', 'Course', 'Journal', 'Map']);

/** Sentry protocol version this payload is written to. */
const SENTRY_PROTOCOL_VERSION = 7;

/** Client identifier Sentry records against each event. */
const SENTRY_CLIENT = 'adepthood-frontend/1.0';

/**
 * Input shape retained for the existing error boundaries. Runtime filtering
 * sends only fixed boundary/feature identifiers and discards `react` entirely.
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

/**
 * One exception entry. `value` is typed as the marker itself, so a change that
 * tried to put `error.message` back on the wire would not compile.
 */
interface ExceptionEntry {
  type: string;
  value: typeof MESSAGE_WITHHELD;
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

/** Read only data properties. Never invoke a getter on a crash or context. */
function ownData(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    // A Proxy may reject reflection. Treat it as absent metadata.
    return undefined;
  }
}

/**
 * The type of a thrown value, without reading its message or stringifying it.
 *
 * A non-`Error` throw is reported as {@link UNKNOWN_ERROR_TYPE}: `String(x)` of
 * a thrown string *is* its text.
 */
function errorType(error: unknown): string {
  try {
    if (!(error instanceof Error)) return UNKNOWN_ERROR_TYPE;
    const ownName = Object.getOwnPropertyDescriptor(error, 'name');
    // A present accessor is not the same as an absent own property: never
    // fall through from a hostile accessor to a seemingly valid prototype.
    const name = ownName ? ownData(error, 'name') : ownData(Object.getPrototypeOf(error), 'name');
    return typeof name === 'string' && ERROR_TYPES.has(name) ? name : FALLBACK_ERROR_TYPE;
  } catch {
    return UNKNOWN_ERROR_TYPE;
  }
}

/** Copy fixed identifiers only; do not traverse or serialise input objects. */
function allowlistedContexts(contexts?: ReportContexts): Record<string, unknown> {
  const boundaryContext = ownData(contexts, 'errorBoundary');
  const boundary = ownData(boundaryContext, 'boundary');
  if (typeof boundary !== 'string' || !BOUNDARIES.has(boundary)) return {};
  const allowed: { boundary: string; name?: string } = { boundary };
  const name = ownData(boundaryContext, 'name');
  if (typeof name === 'string' && FEATURES.has(name)) allowed.name = name;
  return { errorBoundary: allowed };
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
  const entry: ExceptionEntry = { type: errorType(error), value: MESSAGE_WITHHELD };
  return {
    event_id: meta.eventId,
    timestamp: meta.timestamp,
    platform: 'javascript',
    level: 'error',
    environment: meta.environment,
    release: meta.release,
    exception: { values: [entry] },
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
