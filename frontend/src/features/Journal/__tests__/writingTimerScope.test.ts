/* eslint-env jest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from '@jest/globals';

/**
 * The writing timer persists nothing — no request, no store write, no device
 * storage. It hands a finished session to whatever consumes it and forgets it.
 *
 * Asserted by reading the modules rather than by spying a client, because a spy
 * on a module nothing imports can never fail: it would report "zero calls"
 * against code that never had a chance to make one, and go on reporting it
 * after someone wired persistence in through a different door. Reading the
 * imports fails the moment any of those doors opens.
 */
const FEATURE_DIR = join(__dirname, '..');

const MODULES = [
  'writingSession.ts',
  'writingTimerView.ts',
  'writingTimerCopy.ts',
  'WritingTimer.tsx',
  'WritingSessionBanner.tsx',
  'WritingSessionSurface.tsx',
];

/** Every module specifier the file imports, static or dynamic. */
function importedModules(source: string): string[] {
  return [...source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  );
}

describe('the writing timer keeps to its scope floor', () => {
  it.each(MODULES)('%s reaches no server, no store and no device storage', (moduleName) => {
    const source = readFileSync(join(FEATURE_DIR, moduleName), 'utf8');

    for (const specifier of importedModules(source)) {
      expect(specifier).not.toMatch(/^@\/api/);
      expect(specifier).not.toMatch(/^@\/store/);
      expect(specifier).not.toMatch(/async-storage/i);
      expect(specifier).not.toMatch(/^zustand/);
    }
  });

  it('reads every module it claims to check', () => {
    for (const moduleName of MODULES) {
      expect(
        importedModules(readFileSync(join(FEATURE_DIR, moduleName), 'utf8')).length,
      ).toBeGreaterThan(0);
    }
  });
});
