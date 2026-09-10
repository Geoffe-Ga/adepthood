import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { REPO_ROOT, backendPath } from '@/testing/backendSource';

/**
 * Tripwires for the real-wire e2e lane, modelled on the backend's
 * `tests/test_integration_lane_guard.py`.
 *
 * The failure mode of an e2e lane is not a red test -- it is a green job that
 * never reached the server, or a spec that quietly mocked the very client it
 * claims to exercise. This file runs on the DEFAULT frontend suite (no server,
 * no database), reads the lane's files as plain text, and asserts both that the
 * wiring is present and that none of the known ways to disarm it are.
 *
 * Some of those files are Python: the launcher and the lane's arrange helpers
 * live in the backend tree, so a backend-only commit can add the stub this file
 * forbids. Every module under `backend/tests/e2e/` is read, not just the one
 * named `server.py` -- a check scoped to a single filename leaves the next file
 * on that path as the one place it does not look. The directory comes from
 * `@/testing/backendSource` for that reason -- it is what makes backend CI run
 * this file on such a commit rather than months later.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');
const PACKAGE_JSON = join(FRONTEND_ROOT, 'package.json');
const E2E_CONFIG = join(FRONTEND_ROOT, 'jest.e2e.config.js');
const BROWSER_E2E_CONFIG = join(FRONTEND_ROOT, 'playwright.config.ts');
const E2E_DIR = join(FRONTEND_ROOT, 'e2e');
const GLOBAL_SETUP = join(E2E_DIR, 'globalSetup.ts');
const FAKE_CREEK = join(E2E_DIR, 'fakeCreekServer.mjs');
const FAKE_VAULT = join(E2E_DIR, 'fakeCreekVault.mjs');
const SERVER_LAUNCHER = backendPath('tests', 'e2e', 'server.py');
const LANE_PYTHON_DIR = backendPath('tests', 'e2e');

const E2E_SCRIPT = 'test:e2e';
const BROWSER_E2E_SCRIPT = 'test:e2e:web';
const BROWSER_JOURNEY = 'course-passage.browser.e2e.test.ts';
const HABITS_VIEWPORT_JOURNEY = 'habits-viewport.browser.e2e.test.ts';
const SHARED_BROWSER_SUPPORT = 'journalHabitsBrowserSupport.ts';
/**
 * Sorted, because `e2eFiles` is a bare `readdirSync` filter and directory order
 * is not guaranteed: an unsorted two-element comparison is an order-dependent
 * flake waiting for the first checkout that reads them the other way round.
 */
const EXPECTED_BROWSER_JOURNEYS = [
  BROWSER_JOURNEY,
  HABITS_VIEWPORT_JOURNEY,
  'course-reflect-return.browser.e2e.test.ts',
  'habit-reorder.browser.e2e.test.ts',
  'journal-failed-checkoff.browser.e2e.test.ts',
  'journal-promote-quote.browser.e2e.test.ts',
  'journal-promoted-quote-reflection.browser.e2e.test.ts',
  'journal-return-offer.browser.e2e.test.ts',
  'journal-short-habit-offer.browser.e2e.test.ts',
  'journal-writing-timer.browser.e2e.test.ts',
  'practice-stats.browser.e2e.test.ts',
  'practice-unconfirmed-stage.browser.e2e.test.ts',
  'practice-weekly-count.browser.e2e.test.ts',
  'resonance-credit-exhausted.browser.e2e.test.ts',
  'resonance-explainer.browser.e2e.test.ts',
  'return-recover-habit.browser.e2e.test.ts',
].sort();
const LICENSE_STUB = 'verify_aptitude_license';
const EXPECTED_JOURNEYS = [
  'account-deletion.e2e.test.ts',
  'auth.e2e.test.ts',
  'corpus-consent.e2e.test.ts',
  'corpus-import.e2e.test.ts',
  'corpus-invitation.e2e.test.ts',
  'course.e2e.test.ts',
  'data-export.e2e.test.ts',
  'depth.e2e.test.ts',
  'habit-auto-reveal.e2e.test.ts',
  'habit-delete.e2e.test.ts',
  'habits-empty.e2e.test.ts',
  'habits.e2e.test.ts',
  'journal-delete.e2e.test.ts',
  'journal-habit-offer.e2e.test.ts',
  'journal-practice-offer.e2e.test.ts',
  'journal.e2e.test.ts',
  'map.e2e.test.ts',
  'password-recovery.e2e.test.ts',
  'practice-catalog.e2e.test.ts',
  'practice-log-past.e2e.test.ts',
  'practice-tags.e2e.test.ts',
  'practice.e2e.test.ts',
  'prompt-history.e2e.test.ts',
  'prompt-set-aside.e2e.test.ts',
  'resonance.e2e.test.ts',
  'seed-upload.e2e.test.ts',
  'stage-copy.e2e.test.ts',
  'vault-activation.e2e.test.ts',
  'vault-connection.e2e.test.ts',
  'voice-readiness.e2e.test.ts',
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

/** Mocking machinery that has no business anywhere in the lane's python. */
const FORBIDDEN_IN_LANE_PYTHON = [
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

/** API-client journeys run in Jest; browser journeys have their own Playwright contract. */
function apiJourneyFiles(): string[] {
  return e2eFiles('.e2e.test.ts').filter((name) => !name.endsWith('.browser.e2e.test.ts'));
}

function launcherText(): string {
  return read(
    SERVER_LAUNCHER,
    'The lane needs a launcher that boots the real FastAPI app on ephemeral Postgres.',
  );
}

/**
 * Every python module the lane ships, as `[path, text]` pairs.
 *
 * The launcher is not the only one any more: the helper that arranges a program
 * anchor for the Map journey lives beside it, and both sit on the lane's path.
 */
function lanePythonModules(): Array<[string, string]> {
  if (!existsSync(LANE_PYTHON_DIR)) {
    throw new Error(`${LANE_PYTHON_DIR} does not exist; the e2e lane has no python at all.`);
  }
  const modules = readdirSync(LANE_PYTHON_DIR)
    .filter((name) => name.endsWith('.py'))
    .map((name): [string, string] => {
      const path = join(LANE_PYTHON_DIR, name);
      return [path, readFileSync(path, 'utf8')];
    });
  if (modules.length === 0) {
    throw new Error(`${LANE_PYTHON_DIR} holds no python module, so the lane cannot boot.`);
  }
  return modules;
}

/**
 * Attribute assignments in the lane's python whose value is a callable, as
 * `[path, target]` pairs.
 *
 * Rebinding a module attribute to a function (or a lambda, or a Mock) is what
 * "stubbing" means here, and it is the only thing worth forbidding: the launcher
 * legitimately assigns scalars to configure alembic and uvicorn, so a blanket
 * ban on attribute assignment would flag ordinary setup as a fake. The defined
 * names are collected per module rather than across all of them, so a function
 * declared in one file cannot excuse an assignment in another.
 */
function laneStubTargets(): Array<[string, string]> {
  const targets: Array<[string, string]> = [];
  for (const [path, text] of lanePythonModules()) {
    const defined = new Set([...text.matchAll(PYTHON_DEF)].map((match) => match[1] ?? ''));
    for (const assignment of text.matchAll(PYTHON_ATTRIBUTE_ASSIGNMENT)) {
      const value = (assignment[2] ?? '').replace(/\(.*$/, '');
      if (defined.has(value) || value === 'lambda' || value.endsWith('Mock')) {
        targets.push([path, assignment[1] ?? '']);
      }
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

describe('the real-browser journey is wired as a separate mandatory lane', () => {
  it(`declares ${BROWSER_E2E_SCRIPT} against the Playwright config`, () => {
    expect(packageScripts()[BROWSER_E2E_SCRIPT]).toContain('playwright.config.ts');
  });

  it('runs the browser script in the e2e workflow', () => {
    const workflow = workflowText();
    expect(workflow).toMatch(/^ {2}browser-journey:/m);
    expect(workflow).toContain(BROWSER_E2E_SCRIPT);
    expect(workflow).toContain('playwright install --with-deps chromium');
  });

  it('drives every Playwright journey through the real browser UI', () => {
    const config = read(BROWSER_E2E_CONFIG, 'The browser journey needs a Playwright config.');

    expect(config).toContain("testMatch: '**/*.browser.e2e.test.ts'");
    for (const name of EXPECTED_BROWSER_JOURNEYS) {
      const spec = read(join(E2E_DIR, name), `The browser journey spec ${name} is missing.`);
      const signupDriver = spec.includes(`'./journalHabitsBrowserSupport'`)
        ? `${spec}\n${read(
            join(E2E_DIR, SHARED_BROWSER_SUPPORT),
            'The shared browser signup driver is missing.',
          )}`
        : spec;

      expect(spec).toContain("from '@playwright/test'");
      expect(signupDriver).toContain("getByRole('button', { name: 'Create account' })");
    }
  });

  it('keeps the passage journey driving the journal editor it exists for', () => {
    const spec = read(join(E2E_DIR, BROWSER_JOURNEY), 'The browser journey spec is missing.');

    expect(spec).toContain("getByRole('textbox', { name: 'Entry body' })");
  });

  it('keeps the habits journey measuring the grid against its own footer controls', () => {
    const spec = read(
      join(E2E_DIR, HABITS_VIEWPORT_JOURNEY),
      'The habits viewport journey spec is missing.',
    );

    // Geometry, not text: a spec that stopped reading these boxes would still
    // sign up and still pass, and would prove nothing about the layout.
    expect(spec).toContain("getByTestId('habits-list')");
    expect(spec).toContain("getByTestId('habits-pagination')");
    expect(spec).toContain('boundingBox()');
  });

  it('keeps Playwright specs out of the Jest API journey lane', () => {
    const config = read(E2E_CONFIG, 'The API journey needs a Jest config.');

    expect(config).toContain(
      "testPathIgnorePatterns: ['<rootDir>/e2e/.*[.]browser[.]e2e[.]test[.]ts$']",
    );
  });
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
    expect(apiJourneyFiles().sort()).toEqual(EXPECTED_JOURNEYS);
    expect(e2eFiles('.browser.e2e.test.ts').sort()).toEqual(EXPECTED_BROWSER_JOURNEYS);
  });

  it('imports the real API client in every journey', () => {
    for (const name of apiJourneyFiles()) {
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

describe('the external Creek boundary stays protocol-shaped and secret hostile', () => {
  it('launches the fake as a separate process and wires only production provisioning settings', () => {
    const setup = read(GLOBAL_SETUP, 'The activation journey needs its external Creek boundary.');

    expect(setup).toContain("spawn(process.execPath, [join(__dirname, 'fakeCreekServer.mjs')]");
    expect(setup).toContain('CREEK_PROVISIONING_URL:');
    expect(setup).toContain('CREEK_PROVISIONING_AUTH_FILE:');
    expect(setup).toContain('CREEK_PROVISIONING_HANDOFF_AUTH_FILE:');
    expect(setup).not.toContain('dependency_overrides');
  });

  it('requires the version header and rejects raw recovery or passphrase fields', () => {
    const fake = read(FAKE_CREEK, 'The activation journey needs a protocol-shaped Creek fake.');

    expect(fake).toContain("const CONTRACT_HEADER = 'Creek-Provisioning-Version'");
    expect(fake).toContain("const CONTRACT_VERSION = '1.0.0'");
    expect(fake).toContain("['passphrase', 'recovery_code', 'recoveryCode']");
    expect(fake).toContain('/internal/vault-provisioning/completions');
  });
});

describe('the external Creek Vault boundary stays protocol-shaped and narrowly advertised', () => {
  it('launches the vault fake as a separate process and wires only production settings', () => {
    const setup = read(GLOBAL_SETUP, 'The seed journey needs a vault to seed a document into.');

    expect(setup).toContain("spawn(process.execPath, [join(__dirname, 'fakeCreekVault.mjs')]");
    expect(setup).toContain('CREEK_VAULT_URL:');
    expect(setup).toContain('CREEK_VAULT_API_KEY:');
    expect(setup).toContain('CREEK_VAULT_OWNER_USER_ID:');
    expect(setup).not.toContain('dependency_overrides');
  });

  it('advertises only the two capabilities the seed journey needs', () => {
    // The sharpest constraint on this boundary, and the reason it changes no
    // other journey: adepthood consults the advertised list before every
    // capability call, so a vault claiming the journal replication capability
    // would put every journal write in the lane on the wire toward this process.
    // Asserted as the absence of its wire name anywhere in the file, which is
    // why that string does not appear there even in prose.
    const fake = read(FAKE_VAULT, 'The seed journey needs a contract-shaped vault to reach.');

    expect(fake).toContain("const ADVERTISED_CAPABILITIES = ['capabilities', 'upload']");
    expect(fake).not.toContain('journal-upsert');
  });

  it('requires the contract version on the upload route and admits no third tier', () => {
    const fake = read(FAKE_VAULT, 'The seed journey needs a contract-shaped vault to reach.');

    expect(fake).toContain("const CONTRACT_HEADER = 'x-creek-contract-version'");
    expect(fake).toContain("const CONTRACT_VERSION = '0.15.0'");
    expect(fake).toContain('incompatible_version');
    expect(fake).toContain("const ADMITTED_TIERS = ['open', 'personal']");
    // Declared *and* enforced: a constant nothing consults would leave the
    // privacy assertion resting on adepthood's refusal alone.
    expect(fake).toContain('ADMITTED_TIERS.includes(body.tier)');
  });
});

describe('the lane python stubs exactly one third-party call', () => {
  it('ships a launcher', () => {
    expect(launcherText().length).toBeGreaterThan(0);
  });

  it('reads every module on the lane path, the launcher among them', () => {
    // A reader that resolved the directory wrongly would match nothing and
    // report every rule below as satisfied.
    expect(lanePythonModules().map(([path]) => path)).toContain(SERVER_LAUNCHER);
  });

  it(`stubs ${LICENSE_STUB} exactly once`, () => {
    const stubs = laneStubTargets().filter(([, target]) => target.endsWith(LICENSE_STUB));

    expect(stubs).toHaveLength(1);
  });

  it('stubs nothing else on the request path', () => {
    const others = laneStubTargets().filter(([, target]) => !target.endsWith(LICENSE_STUB));

    if (others.length > 0) {
      const named = others.map(([path, target]) => `${path} rebinds ${target}`).join('; ');
      throw new Error(
        `${named} to a callable; the Gumroad license check is the only stub the lane ` +
          `permits on the request path.`,
      );
    }
    expect(others).toEqual([]);
  });

  it.each(FORBIDDEN_IN_LANE_PYTHON)('uses no "%s" mocking machinery', (fragment) => {
    const offenders = lanePythonModules()
      .filter(([, text]) => text.includes(fragment))
      .map(([path]) => path);

    if (offenders.length > 0) {
      throw new Error(`${offenders.join()} contains "${fragment}", which fakes the request path.`);
    }
    expect(offenders).toEqual([]);
  });
});
