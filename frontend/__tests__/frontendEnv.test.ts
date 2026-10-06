import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

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
 * cannot be turned into a demo build by a shell that happens to export the
 * flag, and that both lane ports are origins the backend's development CORS
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

    expect(env).not.toHaveProperty(HABIT_DEMO_FLAG);
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
