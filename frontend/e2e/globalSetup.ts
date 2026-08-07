import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import globalTeardown from './globalTeardown';
import {
  BACKEND_DIR,
  clearLaneState,
  pythonExecutable,
  writeLaneState,
  type LaneState,
} from './laneState';

/**
 * Bring up the server the journeys drive: an ephemeral Postgres database built
 * by `alembic upgrade head`, and the real FastAPI app serving it on a loopback
 * port. Nothing here degrades gracefully. A missing Postgres, a server that
 * fails to boot, or a health probe that answers wrong all throw, because the
 * only thing worse than a red e2e lane is a green one that never made a
 * request.
 */

const POSTGRES_URL_ENV = 'TEST_POSTGRES_URL';
const READY_PREFIX = 'E2E_READY port=';
const BOOT_TIMEOUT_MS = 180_000;
const SECRET_KEY_BYTES = 32;
const DATABASE_SUFFIX_BYTES = 6;

const POSTGRES_HELP =
  `${POSTGRES_URL_ENV} is unset, so there is no database to build the schema in. ` +
  'Start one with: docker run -d --name adepthood-e2e-pg -e POSTGRES_USER=aptitude ' +
  '-e POSTGRES_PASSWORD=aptitude -e POSTGRES_DB=aptitude -p 5432:5432 postgres:16 ' +
  `then point ${POSTGRES_URL_ENV} at it (see frontend/e2e/README.md for the full recipe). ` +
  'The lane never skips on an absent server: that is the gap it exists to close.';

/** Replace the database component of a connection URL, preserving any query. */
function withDatabase(url: string, name: string): string {
  // Split on the FIRST '?' only, keeping the whole query: split(url, 2) would
  // silently drop everything after a second '?'.
  const queryStart = url.indexOf('?');
  const base = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? undefined : url.slice(queryStart + 1);
  if (!base.includes('://')) {
    throw new Error(`${POSTGRES_URL_ENV} is not a connection URL: "${url}"`);
  }
  const authorityEnd = base.indexOf('/', base.indexOf('://') + '://'.length);
  const authority = authorityEnd === -1 ? base : base.slice(0, authorityEnd);
  return `${authority}/${name}${query === undefined ? '' : `?${query}`}`;
}

/** Confirm the app is actually answering, not merely listening. */
async function assertHealthy(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  const body: unknown = await response.json();
  const { status, database } = body as { status?: unknown; database?: unknown };
  if (response.status !== 200 || status !== 'healthy' || database !== 'connected') {
    throw new Error(
      `the e2e server answered GET /health with ${response.status} ${JSON.stringify(body)}; ` +
        'the lane needs a server that is up and connected to its database',
    );
  }
}

interface Launch {
  pid: number;
  port: number;
}

/** Spawn the server and resolve once it announces the port it bound. */
function launchServer(databaseUrl: string, adminUrl: string): Promise<Launch> {
  const child = spawn(pythonExecutable(), ['-m', 'tests.e2e.server'], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: 'src',
      DATABASE_URL: databaseUrl,
      E2E_ADMIN_DATABASE_URL: adminUrl,
      SECRET_KEY: randomBytes(SECRET_KEY_BYTES).toString('base64url'),
    },
  });

  return new Promise<Launch>((resolvePort, reject) => {
    let log = '';
    const fail = (reason: string): void => {
      reject(new Error(`${reason}\n--- server output ---\n${log}`));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`the e2e server did not report readiness within ${BOOT_TIMEOUT_MS}ms`);
    }, BOOT_TIMEOUT_MS);

    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString();
      const match = /E2E_READY port=(\d+)/.exec(log);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePort({ pid: child.pid ?? 0, port: Number(match[1]) });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fail(
        `the e2e server exited (code ${String(code)}, signal ${String(signal)}) before ${READY_PREFIX}`,
      );
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      fail(`could not start the e2e server: ${error.message}`);
    });
  });
}

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env[POSTGRES_URL_ENV]?.trim();
  if (!adminUrl) throw new Error(POSTGRES_HELP);

  clearLaneState();
  const databaseUrl = withDatabase(
    adminUrl,
    `adepthood_e2e_${randomBytes(DATABASE_SUFFIX_BYTES).toString('hex')}`,
  );

  const { pid, port } = await launchServer(databaseUrl, adminUrl);
  const baseUrl = `http://127.0.0.1:${port}`;
  const state: LaneState = { pid, baseUrl, databaseUrl, adminUrl };
  writeLaneState(state);

  try {
    await assertHealthy(baseUrl);
  } catch (error: unknown) {
    // Jest runs globalTeardown only after a globalSetup that returned, so a
    // server that booted but answers wrong would otherwise outlive the run.
    await globalTeardown();
    throw error;
  }

  // Read by `src/config.ts` at import time, and inlined into the compiled module
  // by babel-preset-expo -- which is why the lane disables Jest's transform
  // cache. Workers are forked after this runs, so they inherit the value.
  process.env.EXPO_PUBLIC_API_BASE_URL = baseUrl;
}
