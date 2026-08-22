import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

/**
 * Tripwires for the real-wire e2e lane, modelled on the backend's
 * `tests/test_integration_lane_guard.py`.
 *
 * The failure mode of an e2e lane is not a red test -- it is a green job that
 * never reached the server, or a spec that quietly mocked the very client it
 * claims to exercise. This file runs on the DEFAULT frontend suite (no server,
 * no database), reads the lane's files as plain text, and asserts both that the
 * wiring is present and that none of the known ways to disarm it are.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');
const PACKAGE_JSON = join(FRONTEND_ROOT, 'package.json');
const E2E_CONFIG = join(FRONTEND_ROOT, 'jest.e2e.config.js');
const E2E_DIR = join(FRONTEND_ROOT, 'e2e');
const SERVER_LAUNCHER = join(REPO_ROOT, 'backend', 'tests', 'e2e', 'server.py');

const E2E_SCRIPT = 'test:e2e';
const LICENSE_STUB = 'verify_aptitude_license';
const EXPECTED_JOURNEYS = [
  'account-deletion.e2e.test.ts',
  'auth.e2e.test.ts',
  'course.e2e.test.ts',
  'data-export.e2e.test.ts',
  'depth.e2e.test.ts',
  'habits.e2e.test.ts',
  'journal.e2e.test.ts',
  'practice-catalog.e2e.test.ts',
  'practice.e2e.test.ts',
];
const ONLY_MODULE_ALIAS = ['^@/(.*)$'];

/**
 * Text fragments that would leave the job structurally present but toothless:
 * a red lane reported as success, a shell that swallows the exit code, a run
 * that passes because it found no tests, or a disabled job.
 */
const DISARMING_FRAGMENTS = [
  'continue-on-error',
  '|| true',
  '|| exit 0',
  'set +e',
  'if: false',
  '--passWithNoTests',
  '--onlyFailures',
  '.skip',
];

/** Ways a spec could stop driving the real client while still looking like a test. */
const FORBIDDEN_IN_SPECS: Array<[string, RegExp]> = [
  ['jest.mock(', /\bjest\.mock\s*\(/],
  ['jest.spyOn(...fetch...)', /\bjest\.spyOn\s*\([^)]*fetch/i],
  ['global.fetch =', /\bglobal\.fetch\s*=/],
  ['globalThis.fetch =', /\bglobalThis\.fetch\s*=/],
];

/** Ways any file in the lane could turn an absent backend into a silent pass. */
const FORBIDDEN_SKIP_PATHS: Array<[string, RegExp]> = [
  ['describe.skip', /\bdescribe\.skip\b/],
  ['it.skip', /\bit\.skip\b/],
  ['test.skip', /\btest\.skip\b/],
  ['describe.only', /\bdescribe\.only\b/],
  ['it.only', /\bit\.only\b/],
  ['test.only', /\btest\.only\b/],
  ['xit(', /\bxit\s*\(/],
  ['xdescribe(', /\bxdescribe\s*\(/],
  ['bare early return', /^[ \t]*return;[ \t]*$/m],
];

/** Mocking machinery that has no business on the e2e request path. */
const FORBIDDEN_IN_LAUNCHER = [
  'monkeypatch',
  'unittest.mock',
  'mock.patch',
  'MagicMock',
  'AsyncMock',
  'dependency_overrides',
  '@patch',
];

const JOBS_HEADER = /^jobs:[ \t]*$/m;
const PYTHON_ATTRIBUTE_ASSIGNMENT = /^[ \t]*([A-Za-z_]\w*(?:\.\w+)+)[ \t]*=(?!=)[ \t]*(\S+)/gm;
const PYTHON_DEF = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm;
// Anchored on the key itself: `indexOf('moduleNameMapper')` also finds the word
// inside this config's own header comment and slices the wrong block.
const MAPPER_BLOCK = /moduleNameMapper\s*:\s*\{([^}]*)\}/;
const MAPPER_KEY = /'([^']+)'\s*:/g;

function read(path: string, why: string): string {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist. ${why}`);
  }
  return readFileSync(path, 'utf8');
}

/** Split the workflow into its trigger preamble and its `jobs:` body. */
function splitWorkflow(): [string, string] {
  const text = read(WORKFLOW, 'The e2e lane only runs once a workflow invokes it.');
  const header = JOBS_HEADER.exec(text);
  if (header === null) {
    throw new Error(`${WORKFLOW} has no top-level "jobs:" key.`);
  }
  return [text.slice(0, header.index), text.slice(header.index)];
}

function workflowText(): string {
  return read(WORKFLOW, 'The e2e lane only runs once a workflow invokes it.');
}

function packageScripts(): Record<string, string> {
  const raw: unknown = JSON.parse(read(PACKAGE_JSON, 'The frontend package manifest is missing.'));
  const scripts = (raw as { scripts?: Record<string, string> }).scripts;
  if (scripts === undefined) {
    throw new Error(`${PACKAGE_JSON} declares no "scripts" block.`);
  }
  return scripts;
}

function e2eScript(): string {
  const script = packageScripts()[E2E_SCRIPT];
  if (script === undefined) {
    throw new Error(
      `${PACKAGE_JSON} has no "${E2E_SCRIPT}" script, so nothing runs jest.e2e.config.js.`,
    );
  }
  return script;
}

/** The literal keys declared in jest.e2e.config.js's `moduleNameMapper`. */
function mapperKeys(): string[] {
  const text = read(E2E_CONFIG, 'The e2e jest project config is missing.');
  const block = MAPPER_BLOCK.exec(text);
  if (block === null) {
    throw new Error(`${E2E_CONFIG} declares no moduleNameMapper block.`);
  }
  return [...(block[1] ?? '').matchAll(MAPPER_KEY)].map((match) => match[1] ?? '');
}

function e2eFiles(suffix: string): string[] {
  if (!existsSync(E2E_DIR)) {
    throw new Error(`${E2E_DIR} does not exist; the e2e lane has no specs.`);
  }
  return readdirSync(E2E_DIR).filter((name) => name.endsWith(suffix));
}

function launcherText(): string {
  return read(
    SERVER_LAUNCHER,
    'The lane needs a launcher that boots the real FastAPI app on ephemeral Postgres.',
  );
}

/**
 * Attribute assignments in the launcher whose value is a callable.
 *
 * Rebinding a module attribute to a function (or a lambda, or a Mock) is what
 * "stubbing" means here, and it is the only thing worth forbidding: the launcher
 * legitimately assigns scalars to configure alembic and uvicorn, so a blanket
 * ban on attribute assignment would flag ordinary setup as a fake.
 */
function launcherStubTargets(): string[] {
  const text = launcherText();
  const defined = new Set([...text.matchAll(PYTHON_DEF)].map((match) => match[1] ?? ''));
  const targets: string[] = [];
  for (const assignment of text.matchAll(PYTHON_ATTRIBUTE_ASSIGNMENT)) {
    const value = (assignment[2] ?? '').replace(/\(.*$/, '');
    if (defined.has(value) || value === 'lambda' || value.endsWith('Mock')) {
      targets.push(assignment[1] ?? '');
    }
  }
  return targets;
}

describe('e2e workflow is wired and cannot be silently disarmed', () => {
  it('exists and triggers on pull_request', () => {
    const [triggers] = splitWorkflow();

    expect(triggers).toMatch(/^\s{2}pull_request:/m);
  });

  it('provisions a postgres:16 service container', () => {
    expect(workflowText()).toMatch(/image:[ \t]*["']?postgres:16\b/);
  });

  it('points the lane at that database via TEST_POSTGRES_URL', () => {
    expect(workflowText()).toMatch(/^[ \t]*TEST_POSTGRES_URL:[ \t]+\S/m);
  });

  it(`runs the ${E2E_SCRIPT} script`, () => {
    expect(workflowText()).toContain(E2E_SCRIPT);
  });

  it.each(DISARMING_FRAGMENTS)('carries no "%s" escape hatch', (fragment) => {
    const text = workflowText();

    if (text.includes(fragment)) {
      throw new Error(`${WORKFLOW} contains the disarming fragment "${fragment}".`);
    }
    expect(text).not.toContain(fragment);
  });
});

describe('package.json exposes the lane as its own script', () => {
  it(`declares ${E2E_SCRIPT} against jest.e2e.config.js`, () => {
    expect(e2eScript()).toContain('jest.e2e.config.js');
  });

  it.each(['--passWithNoTests', '--coverage', '.skip'])(
    `keeps "%s" out of the ${E2E_SCRIPT} script`,
    (fragment) => {
      expect(e2eScript()).not.toContain(fragment);
    },
  );
});

describe('jest.e2e.config.js isolates the lane without weakening anything', () => {
  it('declares no coverage gate of its own', () => {
    const text = read(E2E_CONFIG, 'The e2e jest project config is missing.');

    expect(text).not.toContain('coverageThreshold');
    expect(text).not.toContain('collectCoverage');
  });

  it('maps the @/ alias and nothing else', () => {
    expect(mapperKeys()).toEqual(ONLY_MODULE_ALIAS);
  });

  it.each(['api', 'fetch', 'expo'])('maps no module matching "%s"', (needle) => {
    const offenders = mapperKeys().filter((key) => key.toLowerCase().includes(needle));

    expect(offenders).toEqual([]);
  });
});

describe('e2e specs drive the unmocked production client', () => {
  it('ships exactly the journeys the lane is built around', () => {
    expect(e2eFiles('.e2e.test.ts').sort()).toEqual(EXPECTED_JOURNEYS);
  });

  it('imports the real API client in every journey', () => {
    for (const name of e2eFiles('.e2e.test.ts')) {
      const text = readFileSync(join(E2E_DIR, name), 'utf8');
      if (!/from '@\/api'/.test(text)) {
        throw new Error(`e2e/${name} never imports from "@/api"; it exercises nothing real.`);
      }
    }
  });

  it.each(FORBIDDEN_IN_SPECS)('contains no %s in any journey', (label, pattern) => {
    const offenders = e2eFiles('.e2e.test.ts').filter((name) =>
      pattern.test(readFileSync(join(E2E_DIR, name), 'utf8')),
    );

    if (offenders.length > 0) {
      throw new Error(`${offenders.join()} use "${label}", which fakes the request path.`);
    }
    expect(offenders).toEqual([]);
  });

  it.each(FORBIDDEN_SKIP_PATHS)('offers no %s skip path anywhere in e2e/', (label, pattern) => {
    const offenders = e2eFiles('.ts').filter((name) =>
      pattern.test(readFileSync(join(E2E_DIR, name), 'utf8')),
    );

    if (offenders.length > 0) {
      throw new Error(
        `e2e/${offenders.join()} contains "${label}". An absent backend must fail the ` +
          `lane, never skip it -- throw instead.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe('the server launcher stubs exactly one third-party call', () => {
  it('exists', () => {
    expect(launcherText().length).toBeGreaterThan(0);
  });

  it(`stubs ${LICENSE_STUB} exactly once`, () => {
    const stubs = launcherStubTargets().filter((lhs) => lhs.endsWith(LICENSE_STUB));

    expect(stubs).toHaveLength(1);
  });

  it('stubs nothing else on the request path', () => {
    const others = launcherStubTargets().filter((lhs) => !lhs.endsWith(LICENSE_STUB));

    if (others.length > 0) {
      throw new Error(
        `${SERVER_LAUNCHER} rebinds ${others.join()} to a callable; the Gumroad license ` +
          `check is the only stub the lane permits on the request path.`,
      );
    }
    expect(others).toEqual([]);
  });

  it.each(FORBIDDEN_IN_LAUNCHER)('uses no "%s" mocking machinery', (fragment) => {
    expect(launcherText()).not.toContain(fragment);
  });
});
