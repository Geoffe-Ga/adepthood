import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

/**
 * Guards the worker memory bound in `jest.config.js`.
 *
 * Without it the suite's footprint scales with how long it runs rather than
 * with the machine: nine unbounded workers held 6.36 GB of summed RSS here,
 * enough to push a box running parallel agent lanes into swap. Nothing else
 * fails when the bound is dropped — the suite stays green and simply gets
 * hungrier — so this is the only thing standing between a deleted line and a
 * silent return of the original problem.
 *
 * It asserts the *resolved* configuration rather than the text of the config
 * file, because what matters is the value Jest actually runs with. Every bare
 * `jest` invocation — `npm test`, `scripts/frontend/test.sh`, the pre-commit
 * and pre-push hooks, and frontend CI — inherits it from there.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');
const JEST_BIN = join(FRONTEND_ROOT, 'node_modules', '.bin', 'jest');
const BUDGET_MS = 120_000;

interface ResolvedConfig {
  globalConfig: { workerIdleMemoryLimit?: number };
  configs: { testPathIgnorePatterns?: string[] }[];
}

function resolvedConfig(): ResolvedConfig {
  const raw = execFileSync(JEST_BIN, ['--showConfig'], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
    timeout: BUDGET_MS,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(raw) as ResolvedConfig;
}

describe('jest worker memory bound', () => {
  it(
    'resolves a positive workerIdleMemoryLimit and hides the failing fixtures',
    () => {
      const config = resolvedConfig();

      // Non-emptiness first: an empty or shape-changed payload would let the
      // assertions below pass against a config that was never read.
      expect(config.configs.length).toBeGreaterThan(0);

      const limit = config.globalConfig.workerIdleMemoryLimit;
      expect(typeof limit).toBe('number');
      expect(limit).toBeGreaterThan(0);

      // The deliberately failing suites behind `__tests__/timeoutCascade.test.ts`
      // must never be collected by an ordinary run.
      const ignored = config.configs[0]?.testPathIgnorePatterns ?? [];
      expect(ignored.some((pattern) => pattern.includes('__tests__/fixtures'))).toBe(true);
    },
    BUDGET_MS,
  );
});
