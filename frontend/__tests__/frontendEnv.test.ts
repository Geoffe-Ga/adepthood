import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectEnv } from '@expo/env';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  DEFAULT_FRONTEND_PORT,
  DEMO_FRONTEND_PORT,
  HABIT_DEMO_ENV,
  HABIT_DEMO_FLAG,
  frontendServerEnv,
  type LaneEnv,
} from '../e2e/frontendEnv';

import { backendPath } from '@/testing/backendSource';

/**
 * The browser lane's frontend env (#2491). The demo flag is inlined into the
 * bundle when Expo builds it, so whatever reaches the server's env decides
 * which app every spec on that server tests. These pin that the default lane
 * carries the flag as an explicit off, so neither a shell that exports it nor
 * a dotenv file Expo loads at start can turn it into a demo build, and that
 * both lane ports are origins the backend's development CORS
 * actually allows.
 */

const API_URL = 'http://127.0.0.1:9999';
const MAIN_PY = readFileSync(backendPath('src', 'main.py'), 'utf8');
/** The least a parent env carries; every case below adds to it. */
const PARENT_ENV: LaneEnv = { NODE_ENV: 'test' };

describe('frontendServerEnv', () => {
  it('never lets an inherited EXPO_PUBLIC_HABIT_DEMO_MODE turn the default lane into a demo build', () => {
    const env = frontendServerEnv(API_URL, {
      ...PARENT_ENV,
      [HABIT_DEMO_FLAG]: 'true',
      PATH: '/bin',
    });

    expect(env[HABIT_DEMO_FLAG]).toBe('false');
    expect(env.PATH).toBe('/bin');
    expect(env.CI).toBe('1');
    expect(env.EXPO_PUBLIC_API_BASE_URL).toBe(API_URL);
  });

  it('builds a demo bundle only when the caller asks for one, with exactly "true"', () => {
    expect(frontendServerEnv(API_URL, PARENT_ENV, HABIT_DEMO_ENV)[HABIT_DEMO_FLAG]).toBe('true');
  });

  it('does not mutate the env it was handed', () => {
    const inherited: LaneEnv = { ...PARENT_ENV, [HABIT_DEMO_FLAG]: 'true' };
    frontendServerEnv(API_URL, inherited);
    expect(inherited[HABIT_DEMO_FLAG]).toBe('true');
  });
});

/**
 * `expo start` loads the project's dotenv files into its own env before it
 * builds anything, and fills a key ONLY when it is undefined there. A flag that
 * is merely absent from the spawn env is therefore exactly what lets a
 * developer's gitignored `.env.local` turn the shared lane into a demo build;
 * the default env has to carry the flag as an explicit off. These run Expo's
 * own loader (the copy `@expo/cli` resolves) over a throwaway project dir.
 */
describe('frontendServerEnv against Expo dotenv loading', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'lane-dotenv-'));
    writeFileSync(join(projectRoot, '.env.local'), `${HABIT_DEMO_FLAG}=true\n`);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** What the Expo server process would see once its dotenv load has run. */
  function afterDotenv(env: LaneEnv): string | undefined {
    const systemEnv: Record<string, string | undefined> = { ...env };
    loadProjectEnv(projectRoot, { mode: 'development', silent: true, systemEnv });
    return systemEnv[HABIT_DEMO_FLAG];
  }

  it('loads the flag from .env.local into an env that lacks it (the hazard is real)', () => {
    expect(afterDotenv({ ...PARENT_ENV })).toBe('true');
  });

  it('keeps the default lane off even when a .env.local turns the flag on', () => {
    expect(afterDotenv(frontendServerEnv(API_URL, PARENT_ENV))).toBe('false');
  });

  it('keeps the demo server on whatever .env.local says', () => {
    expect(afterDotenv(frontendServerEnv(API_URL, PARENT_ENV, HABIT_DEMO_ENV))).toBe('true');
  });
});

describe('lane frontend ports', () => {
  it('keeps the demo server off the default lane port', () => {
    expect(DEMO_FRONTEND_PORT).not.toBe(DEFAULT_FRONTEND_PORT);
  });

  it.each([DEFAULT_FRONTEND_PORT, DEMO_FRONTEND_PORT])(
    'serves port %i from an origin the development CORS allowlist names both ways',
    (port) => {
      expect(MAIN_PY).toContain(`"http://localhost:${port}"`);
      expect(MAIN_PY).toContain(`"http://127.0.0.1:${port}"`);
    },
  );
});
