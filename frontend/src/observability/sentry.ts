/**
 * Error monitoring for the React Native client.
 *
 * The two error boundaries already call {@link reportException} on every crash
 * they catch; until now that call only reached `console.error`, which nobody
 * reads on a stranger's phone. This module gives it a destination when one is
 * configured, and leaves everything else exactly as it was when one is not.
 *
 * **Optional, on the backend's terms.** With `EXPO_PUBLIC_SENTRY_DSN` unset the
 * app runs normally and says so once at startup. A DSN that cannot be parsed
 * degrades the same way, with one warning. Degrading is never swallowing: the
 * `console.error` record is written first, on every path, configured or not.
 *
 * **Privacy.** The payload is built by allow-list in `sentryEnvelope.ts` —
 * see that module for why it is hand-built rather than delegated to
 * `@sentry/react-native`, and for what the two remaining free-text fields do
 * about it. There are no breadcrumbs anywhere in this design, so no keystroke
 * buffer exists to leak.
 */

import { v4 as uuidv4 } from 'uuid';

import { resolveEnv } from '../config';

import type { ReportContexts, SentryTarget } from './sentryEnvelope';
import { buildEvent, parseDsn, serializeEnvelope } from './sentryEnvelope';

export type { ReportContexts };

const DSN_ENV_VAR = 'EXPO_PUBLIC_SENTRY_DSN';
const ENVIRONMENT_ENV_VAR = 'EXPO_PUBLIC_SENTRY_ENVIRONMENT';
const RELEASE_ENV_VAR = 'EXPO_PUBLIC_SENTRY_RELEASE';

/** Reported when no release was configured, so events still group somewhere. */
const UNKNOWN_RELEASE = 'unknown';

const ENVELOPE_CONTENT_TYPE = 'application/x-sentry-envelope';

interface MonitoringState {
  dsn: string;
  target: SentryTarget | null;
  environment: string;
  release: string;
}

const INERT: MonitoringState = { dsn: '', target: null, environment: '', release: '' };

let state: MonitoringState = INERT;

/** Strip the dashes from a UUID: Sentry event ids are 32 hex characters. */
function newEventId(): string {
  return uuidv4().replace(/-/g, '');
}

/**
 * Read the monitoring configuration and report whether a vendor is wired up.
 *
 * Call once, at app startup. Emits exactly one line either way — an operator
 * reading a boot log should be able to tell, in one glance, whether crashes
 * from this build reach anybody.
 */
export function initErrorMonitoring(): boolean {
  state = INERT;
  const dsn = resolveEnv(process.env.EXPO_PUBLIC_SENTRY_DSN, DSN_ENV_VAR, '').trim();
  if (!dsn) {
    console.info(
      `error_monitoring_disabled: ${DSN_ENV_VAR} is unset, so crashes are logged to the ` +
        'console and reported to no monitoring vendor.',
    );
    return false;
  }
  const target = parseDsn(dsn);
  if (!target) {
    // Name the variable, never echo the value: a DSN embeds a project key.
    console.warn(
      `error_monitoring_dsn_unusable: ${DSN_ENV_VAR} is set to a value that is not a Sentry ` +
        'DSN, so crashes are reported to no monitoring vendor. Correct it or unset it.',
    );
    return false;
  }
  const environment = resolveEnv(
    process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
    ENVIRONMENT_ENV_VAR,
    __DEV__ ? 'development' : 'production',
  );
  const release = resolveEnv(
    process.env.EXPO_PUBLIC_SENTRY_RELEASE,
    RELEASE_ENV_VAR,
    UNKNOWN_RELEASE,
  );
  state = { dsn, target, environment, release };
  console.info(`error_monitoring_enabled environment=${environment} release=${release}`);
  return true;
}

/** Post one built envelope, treating a delivery failure as a non-event. */
function deliver(target: SentryTarget, body: string): void {
  // Called through ``globalThis`` rather than a detached reference: on the web
  // build ``fetch`` is the browser's, which rejects an unbound invocation.
  if (typeof globalThis.fetch !== 'function') {
    return;
  }
  globalThis
    .fetch(target.envelopeUrl, {
      method: 'POST',
      headers: { 'Content-Type': ENVELOPE_CONTENT_TYPE, 'X-Sentry-Auth': target.authHeader },
      body,
    })
    .catch(() => {
      // A monitoring outage must cost the user nothing. The crash itself is
      // already on the console; the failed delivery carries no detail anybody
      // holding the phone could act on, so it gets one static line and no retry.
      console.warn('error_monitoring_delivery_failed');
    });
}

/**
 * Forward a crash caught by an error boundary.
 *
 * Always writes the console record first — that is the floor, and it is why an
 * unconfigured build loses the operator inbox rather than the diagnosis.
 */
export function reportException(error: unknown, contexts?: ReportContexts): void {
  console.error('[reportException]', error, contexts ?? {});
  const { target } = state;
  if (!target) {
    return;
  }
  const timestamp = new Date().toISOString();
  const event = buildEvent(error, contexts, {
    eventId: newEventId(),
    timestamp,
    environment: state.environment,
    release: state.release,
  });
  deliver(target, serializeEnvelope(event, state.dsn, timestamp));
}
