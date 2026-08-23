/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

import { CROSS_BOUNDARY_MARKER, undeclaredCrossBoundaryRead } from '../crossBoundaryReport';

// By the marker, not by '../backendSource': the alias is the specifier the
// runner greps for, and a relative import of the same module leaves this file
// undiscoverable. (The suite guard catches that too -- it is how this line
// came to be written this way.)
import {
  BACKEND_DIR,
  backendPath,
  backendPythonFiles,
  readBackendSource,
} from '@/testing/backendSource';

/**
 * The rule that keeps a drift guard discoverable, and the helper it names.
 *
 * `jest.setup.crossBoundary.js` watches every suite's filesystem reads and
 * fails one that reached into `backend/` without the marker, because a guard
 * `scripts/frontend/cross-boundary-drift.sh` cannot discover is a guard that
 * never runs on the backend change it exists to catch. This exercises that
 * rule directly rather than waiting for someone to trip it.
 *
 * It is itself a cross-boundary test -- it reads backend source below -- so it
 * carries the marker it is about, and backend CI runs it for free.
 */

const FRONTEND_SRC = path.resolve(__dirname, '..', '..');
const A_BACKEND_READ = ['backend/src/domain/constants.py'];
const A_GUARDED_MODULE = ['src', 'errors.py'];

describe('the rule that keeps a drift guard discoverable', () => {
  it('says nothing about a suite that stayed inside the frontend', () => {
    expect(undeclaredCrossBoundaryRead('frontend/src/a.test.ts', 'const a = 1;', [])).toBeNull();
  });

  it('says nothing about a suite that read the backend and declared it', () => {
    const source = `import { backendPath } from '${CROSS_BOUNDARY_MARKER}';`;

    expect(
      undeclaredCrossBoundaryRead('frontend/src/a.test.ts', source, A_BACKEND_READ),
    ).toBeNull();
  });

  it('names the file, the read, and the fix when the marker is missing', () => {
    const failure = undeclaredCrossBoundaryRead(
      'frontend/src/a.test.ts',
      'const constants = readFileSync(somewhere);',
      A_BACKEND_READ,
    );

    expect(failure).toContain('frontend/src/a.test.ts');
    expect(failure).toContain('backend/src/domain/constants.py');
    expect(failure).toContain(CROSS_BOUNDARY_MARKER);
  });

  it('points at a module that exists, so a rename cannot leave it dangling', () => {
    // The marker is a module specifier three things search for -- this rule,
    // the runner, and the tests that import it. Moving the helper without
    // moving the marker would make every guard undiscoverable while nothing
    // else complained.
    const implied = path.join(FRONTEND_SRC, `${CROSS_BOUNDARY_MARKER.replace('@/', '')}.ts`);

    expect(fs.existsSync(implied)).toBe(true);
  });
});

describe('the helper every cross-boundary test reads through', () => {
  it('resolves paths inside the backend tree', () => {
    expect(backendPath(...A_GUARDED_MODULE)).toBe(path.join(BACKEND_DIR, ...A_GUARDED_MODULE));
  });

  it('reads a real backend file', () => {
    expect(readBackendSource(...A_GUARDED_MODULE).length).toBeGreaterThan(0);
  });

  it('fails loudly when the file it mirrors has moved', () => {
    expect(() => readBackendSource('src', 'renamed_away.py')).toThrow(/does not exist/);
  });

  it('sweeps a directory for every Python file under it', () => {
    const swept = backendPythonFiles('src', 'domain');

    expect(swept.length).toBeGreaterThan(1);
    expect(swept.every((file) => file.endsWith('.py'))).toBe(true);
    expect(swept).toContain(backendPath('src', 'domain', 'constants.py'));
  });
});
