import { existsSync, readFileSync } from 'node:fs';

// The path comes from the module that writes it, so a rename cannot silently
// turn this cross-check into a no-op: a missing file reads as "setup has not
// run", which is exactly what a drifted path would look like.
import { STATE_FILE } from './laneState';

/**
 * Fail-fast preflight for the e2e lane. There is no skip path anywhere here:
 * an absent or misaddressed backend must turn the lane red, because a lane
 * that quietly reports success without touching the server is the exact
 * failure this suite exists to prevent.
 */

const BASE_URL_ENV = 'EXPO_PUBLIC_API_BASE_URL';
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

const REMEDY =
  `Run the lane through "npm run test:e2e", which boots a FastAPI server on an ` +
  `ephemeral port, records it in ${STATE_FILE}, and exports ${BASE_URL_ENV}. ` +
  `Never skip on an absent backend -- fix the backend.`;

/** The base URL globalSetup recorded, or null when it has not run yet. */
function recordedBaseUrl(): string | null {
  if (!existsSync(STATE_FILE)) return null;
  const raw: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('baseUrl' in raw)) {
    throw new Error(
      `${STATE_FILE} has no "baseUrl" key; the server launcher wrote a bad state file.`,
    );
  }
  const { baseUrl } = raw as { baseUrl: unknown };
  if (typeof baseUrl !== 'string') {
    throw new Error(`${STATE_FILE} "baseUrl" is ${typeof baseUrl}, expected a string.`);
  }
  return baseUrl;
}

const configured = process.env[BASE_URL_ENV];

if (configured === undefined || configured.trim() === '') {
  throw new Error(
    `${BASE_URL_ENV} is unset or blank, so the e2e lane has no server to talk to. ${REMEDY}`,
  );
}

if (!LOOPBACK_BASE_URL.test(configured)) {
  throw new Error(
    `${BASE_URL_ENV} is "${configured}", which is not a loopback server of the form ` +
      `http://127.0.0.1:<port>. The e2e lane must never address a shared or remote ` +
      `environment. ${REMEDY}`,
  );
}

const recorded = recordedBaseUrl();

if (recorded !== null && recorded !== configured) {
  throw new Error(
    `${BASE_URL_ENV} is "${configured}" but the launcher recorded "${recorded}" in ` +
      `${STATE_FILE}. The tests would drive a different server than the one under ` +
      `test (a stale transform cache or a leaked env var). ${REMEDY}`,
  );
}
