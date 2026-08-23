import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  auditJourneyLedger,
  clientRoutesFromSource,
  readLedger,
  realLedgerEnvironment,
  summariseAudit,
} from './journeyLedger';
import type { LedgerEnvironment } from './journeyLedger';

/**
 * The journey coverage ledger and its gate.
 *
 * A markdown list of "journeys we test" is a belief, not a fact: nothing reads
 * it, so it drifts the first time a spec is renamed and then quietly lies. This
 * file is the reason the ledger cannot do that. It exercises every way the
 * mapping can break against small synthetic environments -- a covering spec
 * that no longer exists, one that exists but is entirely skipped, a spec that
 * accumulated outside the ledger, a screen path or client symbol or route or
 * table that was renamed out from under an entry -- and then runs the same
 * audit against the real repository.
 *
 * The synthetic half is what keeps the real half honest. A gate whose only
 * assertion is "the committed ledger passes" is green for two reasons that look
 * identical: because the mapping holds, or because the checker matches nothing.
 *
 * One failure mode per fixture is not enough on its own, either. A fixture set
 * where every file holds exactly one condition can enumerate every way the gate
 * should fire and still never ask whether it fires when it should not, so the
 * cases below deliberately combine conditions -- a skipped test beside a live
 * one, a marker named in a comment beside the test it would have silenced.
 */

const FRONTEND_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'e2e.yml');
const PACKAGE_JSON = join(FRONTEND_ROOT, 'package.json');

const LEDGER_JOB = 'journey-ledger';
const LEDGER_SCRIPT = 'check:journeys';

/**
 * Journeys the lane covers today. A floor, not an equality: it ratchets up as
 * each gap in the ledger is closed, so coverage that quietly went backwards
 * fails here rather than passing as "still at least three".
 */
const SHIPPED_JOURNEYS = 4;

const SPEC = 'frontend/e2e/habits.e2e.test.ts';
const OTHER_SPEC = 'frontend/e2e/course.e2e.test.ts';
const SCREEN = 'frontend/src/features/Habits/HabitsScreen.tsx';
const LIVE_SPEC = "it('creates a habit', async () => { expect(1).toBe(1); });";

/** A ledger entry that passes every check under `baseEnvironment()`. */
function coveredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'habits.create-and-check-in',
    description: 'A user creates a habit and checks it in.',
    crosses: {
      screen: SCREEN,
      client: ['habits'],
      routes: ['POST /habits/'],
      tables: ['habit'],
    },
    status: 'covered',
    coveredBy: SPEC,
    ...overrides,
  };
}

function uncoveredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'practice.submit-custom',
    description: 'A user submits a custom practice.',
    crosses: {
      screen: SCREEN,
      client: ['habits'],
      routes: ['POST /habits/'],
      tables: ['habit'],
    },
    status: 'uncovered',
    issue: 4242,
    ...overrides,
  };
}

/** An environment in which `coveredEntry()` resolves cleanly. */
function baseEnvironment(overrides: Partial<LedgerEnvironment> = {}): LedgerEnvironment {
  const files = new Map<string, string>([
    [SPEC, LIVE_SPEC],
    [SCREEN, 'export function HabitsScreen() {}'],
  ]);
  return {
    specFiles: [SPEC],
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    clientSymbols: new Set(['habits']),
    routes: new Set(['POST /habits/']),
    clientRoutes: new Set(['POST /habits/']),
    tables: new Set(['habit']),
    ...overrides,
  };
}

/** An environment whose covering spec holds exactly `text` and nothing else. */
function specSaying(text: string): LedgerEnvironment {
  return baseEnvironment({
    fileExists: (path) => path === SPEC || path === SCREEN,
    readFile: (path) => (path === SPEC ? text : 'screen'),
  });
}

function problems(ledger: unknown, environment: LedgerEnvironment = baseEnvironment()): string[] {
  return [...auditJourneyLedger(ledger, environment).problems];
}

/** Assert the audit found exactly one problem, and hand it back to be read. */
function onlyProblem(ledger: unknown, environment: LedgerEnvironment = baseEnvironment()): string {
  const found = problems(ledger, environment);

  expect(found).toHaveLength(1);

  return found[0] ?? '';
}

function workflowText(): string {
  return readFileSync(WORKFLOW, 'utf8');
}

function packageScripts(): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  return (raw as { scripts?: Record<string, string> }).scripts ?? {};
}

describe('the ledger gate accepts a well-formed mapping', () => {
  it('reports no problems for a covered journey whose spec is live', () => {
    expect(problems([coveredEntry()])).toEqual([]);
  });

  it('counts covered and uncovered journeys separately', () => {
    const environment = baseEnvironment();

    const audit = auditJourneyLedger([coveredEntry(), uncoveredEntry()], environment);

    expect(audit.covered).toBe(1);
    expect(audit.uncovered).toBe(1);
  });

  it('does not fail on an honestly declared gap', () => {
    expect(problems([coveredEntry(), uncoveredEntry()])).toEqual([]);
  });

  it('names the uncovered count and its issue in the summary', () => {
    const audit = auditJourneyLedger([coveredEntry(), uncoveredEntry()], baseEnvironment());

    const summary = summariseAudit(audit);

    expect(summary).toContain('1 covered');
    expect(summary).toContain('1 uncovered');
  });
});

/**
 * The cases that separate "this spec stopped running" from "this spec mentions
 * skipping". Every other disabled-marker fixture here is single-condition -- a
 * file holding one disabled test and nothing else -- and a gate whose fixtures
 * are all single-condition cannot express its own false-positive case.
 */
describe('the ledger gate passes a spec that still runs a test', () => {
  it('accepts a spec that skips one case beside a live one', () => {
    const mixed = [
      "it.skip('a pending edge case', () => {});",
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(problems([coveredEntry()], specSaying(mixed))).toEqual([]);
  });

  it('accepts a live test sitting outside a wholly skipped describe', () => {
    const mixed = [
      "describe.skip('pending redesign', () => { it('x', () => {}); });",
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(problems([coveredEntry()], specSaying(mixed))).toEqual([]);
  });

  it('accepts a spec whose comment merely mentions a disabled marker', () => {
    const commented = [
      '// The flaky case below used to be it.skip( until the retry landed.',
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(problems([coveredEntry()], specSaying(commented))).toEqual([]);
  });

  it('accepts a spec whose test name quotes a disabled marker', () => {
    const quoted = "it('rejects a ledger entry pointing at it.skip( specs', () => {});";

    expect(problems([coveredEntry()], specSaying(quoted))).toEqual([]);
  });

  /*
   * The two below are the cases that a substring search cannot get right and a
   * registration-scoped one can: here the mentioned marker, if believed, would
   * flip the verdict rather than merely sit beside it.
   */
  it('accepts a spec whose comment mentions a narrowing marker', () => {
    const commented = [
      '// Reach for it.only( while debugging, but never commit it.',
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(problems([coveredEntry()], specSaying(commented))).toEqual([]);
  });

  it('accepts a spec whose comment mentions a skipped suite above a live test', () => {
    const commented = [
      '// Superseded: this file used to open with describe.skip( around everything.',
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(problems([coveredEntry()], specSaying(commented))).toEqual([]);
  });

  it('accepts a spec whose test name quotes a narrowing marker', () => {
    const quoted = "it('warns when a spec uses it.only(', () => {});";

    expect(problems([coveredEntry()], specSaying(quoted))).toEqual([]);
  });

  it('accepts a live test below a line whose apostrophe never closes', () => {
    const apostrophe = ["const pattern = /it's fine/;", "it('creates a habit', () => {});"].join(
      '\n',
    );

    expect(problems([coveredEntry()], specSaying(apostrophe))).toEqual([]);
  });
});

describe('the ledger gate fails on a broken covering test', () => {
  it('fails when the covering spec does not exist', () => {
    const environment = baseEnvironment({ fileExists: (path) => path === SCREEN, specFiles: [] });

    expect(onlyProblem([coveredEntry()], environment)).toContain('not found');
  });

  it('names both the journey and the missing path', () => {
    const environment = baseEnvironment({ fileExists: (path) => path === SCREEN, specFiles: [] });

    const [first = ''] = problems([coveredEntry()], environment);

    expect(first).toContain('habits.create-and-check-in');
    expect(first).toContain(SPEC);
  });

  it('fails when every test in the covering spec is skipped', () => {
    const skipped = "describe.skip('habits', () => { it('x', () => {}); });";

    expect(onlyProblem([coveredEntry()], specSaying(skipped))).toContain('no enabled test');
  });

  it.each(['it.skip(', 'test.skip(', 'xit(', 'xdescribe(', 'test.todo('])(
    'treats a spec whose only case uses %s as disabled',
    (opener) => {
      expect(problems([coveredEntry()], specSaying(`${opener}'x', () => {});`))).toHaveLength(1);
    },
  );

  it('fails a spec narrowed by .only even when an enabled test sits beside it', () => {
    const narrowed = [
      "it.only('the one case under debug', () => {});",
      "it('creates a habit and checks in', () => {});",
    ].join('\n');

    expect(onlyProblem([coveredEntry()], specSaying(narrowed))).toContain('it.only');
  });

  it('fails when the covering spec exists but contains no test at all', () => {
    const environment = baseEnvironment({
      readFile: (path) => (path === SPEC ? 'export const nothing = 1;' : 'screen'),
    });

    expect(problems([coveredEntry()], environment)).toHaveLength(1);
  });
});

describe('the ledger gate fails on a spec that escaped the ledger', () => {
  it('fails when a seam-crossing spec is registered by nobody', () => {
    const environment = baseEnvironment({ specFiles: [SPEC, OTHER_SPEC] });

    expect(onlyProblem([coveredEntry()], environment)).toContain(OTHER_SPEC);
  });

  it('fails when two journeys claim the same spec', () => {
    const twin = coveredEntry({ id: 'habits.duplicate-claim' });

    expect(onlyProblem([coveredEntry(), twin])).toContain('claimed by 2 journeys');
  });
});

describe('the ledger gate fails when a crossed surface was renamed away', () => {
  it('fails when the screen no longer exists', () => {
    const environment = baseEnvironment({ fileExists: (path) => path === SPEC });

    expect(onlyProblem([coveredEntry()], environment)).toContain(SCREEN);
  });

  it('fails when the client symbol is not exported by the API module', () => {
    const environment = baseEnvironment({ clientSymbols: new Set(['journal']) });

    expect(onlyProblem([coveredEntry()], environment)).toContain('habits');
  });

  it('fails when the route is absent from the exported OpenAPI schema', () => {
    const environment = baseEnvironment({ routes: new Set(['GET /habits/']) });

    expect(onlyProblem([coveredEntry()], environment)).toContain('POST /habits/');
  });

  it('fails when the table is not declared by any model', () => {
    const environment = baseEnvironment({ tables: new Set(['journalentry']) });

    expect(onlyProblem([coveredEntry()], environment)).toContain('habit');
  });

  it('checks the crossed surfaces of uncovered journeys too', () => {
    const environment = baseEnvironment({ routes: new Set<string>(), specFiles: [] });

    expect(onlyProblem([uncoveredEntry()], environment)).toContain('POST /habits/');
  });
});

/**
 * The hole the schema check cannot see: a route the server genuinely serves and
 * the client cannot reach.
 *
 * Checking a declared route against `backend/openapi.json` asks whether the
 * server would answer it. It never asks whether anything in the app would call
 * it, so a journey could name a live route no screen can produce a request for
 * and stay green -- and a spec written to that entry would have to hand-roll the
 * call itself, proving the server works while the seam it claims to protect does
 * not exist. That is what `map.advance-stage` did with
 * `GET /stages/{stage_number}/progress`.
 */
describe('the ledger gate fails on a route the production client cannot issue', () => {
  it('fails when a served route has no call site in the API module', () => {
    const environment = baseEnvironment({
      routes: new Set(['POST /habits/']),
      clientRoutes: new Set(['GET /habits/']),
    });

    expect(onlyProblem([coveredEntry()], environment)).toContain('POST /habits/');
  });

  it('names the API module in the problem, so the fix is not guessed at', () => {
    const environment = baseEnvironment({ clientRoutes: new Set<string>() });

    expect(onlyProblem([coveredEntry()], environment)).toContain('frontend/src/api/index.ts');
  });

  it('accepts a route whose call site fills in a path parameter', () => {
    const entry = coveredEntry({
      crosses: {
        screen: SCREEN,
        client: ['habits'],
        routes: ['DELETE /habits/{habit_id}'],
        tables: ['habit'],
      },
    });
    const environment = baseEnvironment({
      routes: new Set(['DELETE /habits/{habit_id}']),
      clientRoutes: new Set(['DELETE /habits/*']),
    });

    expect(problems([entry], environment)).toEqual([]);
  });

  it('accepts a collection route whose call site appends an optional query', () => {
    const entry = coveredEntry({
      crosses: { screen: SCREEN, client: ['habits'], routes: ['GET /habits/'], tables: ['habit'] },
    });
    const environment = baseEnvironment({
      routes: new Set(['GET /habits/']),
      clientRoutes: new Set(['GET /habits/*']),
    });

    expect(problems([entry], environment)).toEqual([]);
  });

  it('does not let a call site on a sibling path stand in for the declared one', () => {
    const entry = coveredEntry({
      crosses: {
        screen: SCREEN,
        client: ['habits'],
        routes: ['GET /habits/{habit_id}/stats'],
        tables: ['habit'],
      },
    });
    const environment = baseEnvironment({
      routes: new Set(['GET /habits/{habit_id}/stats']),
      clientRoutes: new Set(['GET /habits/*/completions']),
    });

    expect(onlyProblem([entry], environment)).toContain('GET /habits/{habit_id}/stats');
  });
});

/**
 * Reading the client's own call sites.
 *
 * Exercised on source text rather than only through the real module, because a
 * reader that quietly matched nothing would make every route unreachable and a
 * reader that quietly matched everything would make every route reachable --
 * and the second failure is invisible from the committed ledger, which passes
 * either way.
 */
describe('the client route reader sees what the API module can actually call', () => {
  it('reads the method and path off a plain call', () => {
    const source = "return request<Habit>('/habits/', { method: 'POST', body: payload, token });";

    expect([...clientRoutesFromSource(source)]).toEqual(['POST /habits/']);
  });

  it('reads an interpolated path segment as a parameter', () => {
    const source = "return request<void>(`/habits/${habitId}`, { method: 'DELETE', token });";

    expect([...clientRoutesFromSource(source)]).toEqual(['DELETE /habits/*']);
  });

  it('defaults an unstated method to GET, as the client itself does', () => {
    const source = 'return request<Entry>(`/journal/${entryId}`, { token });';

    expect([...clientRoutesFromSource(source)]).toEqual(['GET /journal/*']);
  });

  it('drops a query string, which is not part of the route', () => {
    const source = 'return request<Page<Stage>>(`/stages?${pageQuery({}, params)}`, { token });';

    expect([...clientRoutesFromSource(source)]).toEqual(['GET /stages']);
  });

  it('reads a path whose interpolation holds a nested template literal', () => {
    // `journal.list` is spelled this way, and a reader that stopped at the
    // inner backtick would report the whole journal collection unreachable.
    const source = "request<List>(`/journal/${qs ? `?${qs}` : ''}`, { token });";

    expect([...clientRoutesFromSource(source)]).toEqual(['GET /journal/*']);
  });

  it('takes the method from the call it belongs to, not the next one', () => {
    const source = [
      'get(id) { return request<Entry>(`/journal/${id}`, { token }); },',
      "create(entry) { return request<Entry>('/journal/', { method: 'POST', body: entry }); },",
    ].join('\n');

    expect([...clientRoutesFromSource(source)].sort()).toEqual([
      'GET /journal/*',
      'POST /journal/',
    ]);
  });

  it('ignores the declaration of request itself, which issues nothing', () => {
    const source = "async function request<T>(path: string, { method = 'GET' }): Promise<T> {}";

    expect([...clientRoutesFromSource(source)]).toEqual([]);
  });
});

describe('the ledger gate rejects a malformed ledger', () => {
  it('fails when the ledger is not an array', () => {
    expect(problems({ journeys: [] })).toHaveLength(1);
  });

  it('fails when the ledger is empty', () => {
    expect(problems([])).toHaveLength(1);
  });

  it('fails when an entry has no description', () => {
    expect(onlyProblem([coveredEntry({ description: '' })])).toContain('description');
  });

  it('fails when a covered entry names no spec', () => {
    const entry = coveredEntry();
    delete entry['coveredBy'];

    expect(onlyProblem([entry], baseEnvironment({ specFiles: [] }))).toContain('coveredBy');
  });

  it('fails when an uncovered entry links no issue', () => {
    expect(onlyProblem([coveredEntry(), uncoveredEntry({ issue: 0 })])).toContain('issue');
  });

  it('fails when an uncovered entry also names a covering spec', () => {
    const contradiction = uncoveredEntry({ coveredBy: SPEC });

    expect(onlyProblem([contradiction])).toContain('coveredBy');
  });

  it('reports both faults of an uncovered entry that claims a spec and links no issue', () => {
    const doublyWrong = uncoveredEntry({ coveredBy: SPEC, issue: 0 });

    expect(problems([doublyWrong])).toHaveLength(2);
  });

  it('fails on a status that is neither covered nor uncovered', () => {
    expect(
      onlyProblem([coveredEntry({ status: 'partial' })], baseEnvironment({ specFiles: [] })),
    ).toContain('status');
  });

  it('fails when two entries share an id', () => {
    const clash = uncoveredEntry({ id: coveredEntry()['id'] });

    expect(onlyProblem([coveredEntry(), clash])).toContain('duplicate journey id');
  });

  it('fails when crosses is missing entirely', () => {
    const entry = coveredEntry();
    delete entry['crosses'];

    expect(onlyProblem([entry])).toContain('crosses');
  });

  it('fails when a crossing lists no routes', () => {
    const entry = coveredEntry({
      crosses: { screen: SCREEN, client: ['habits'], routes: [], tables: ['habit'] },
    });

    expect(onlyProblem([entry])).toContain('routes');
  });
});

describe('the committed ledger is true of this repository', () => {
  it('passes the same audit the CI gate runs', () => {
    const audit = auditJourneyLedger(readLedger(REPO_ROOT), realLedgerEnvironment(REPO_ROOT));

    if (audit.problems.length > 0) {
      throw new Error(
        `The journey ledger no longer describes this tree:\n${summariseAudit(audit)}`,
      );
    }
    expect(audit.problems).toEqual([]);
  });

  it('registers every journey spec the e2e lane ships', () => {
    const environment = realLedgerEnvironment(REPO_ROOT);

    expect(environment.specFiles.length).toBeGreaterThanOrEqual(SHIPPED_JOURNEYS);
  });

  it('claims coverage for at least the journeys already shipped', () => {
    const audit = auditJourneyLedger(readLedger(REPO_ROOT), realLedgerEnvironment(REPO_ROOT));

    expect(audit.covered).toBeGreaterThanOrEqual(SHIPPED_JOURNEYS);
  });

  it('reads a non-empty set of client symbols, routes and tables from the repo', () => {
    const environment = realLedgerEnvironment(REPO_ROOT);

    expect(environment.clientSymbols.size).toBeGreaterThan(0);
    expect(environment.routes.size).toBeGreaterThan(0);
    expect(environment.tables.size).toBeGreaterThan(0);
  });

  it('reads the calls the production client makes, spot-checked against known ones', () => {
    const { clientRoutes } = realLedgerEnvironment(REPO_ROOT);

    expect(clientRoutes.has('GET /stages/program-calendar')).toBe(true);
    expect(clientRoutes.has('GET /stages/wheel')).toBe(true);
    expect(clientRoutes.has('POST /journal/')).toBe(true);
  });

  it('reaches no stage-progress route, which is why the Map journey stopped naming one', () => {
    // The finding this check was built for, asserted rather than assumed: the
    // stages router serves `GET /{stage_number}/progress` and nothing in the app
    // calls it. The near-miss is `course.stageProgress`, which addresses the
    // course router's own route -- so match on the whole path, not the suffix.
    const { clientRoutes, routes } = realLedgerEnvironment(REPO_ROOT);

    expect(routes.has('GET /stages/{stage_number}/progress')).toBe(true);
    expect(clientRoutes.has('GET /stages/*/progress')).toBe(false);
    expect(clientRoutes.has('GET /course/stages/*/progress')).toBe(true);
  });
});

describe('the gate is wired into CI and cannot be silently disarmed', () => {
  it(`declares a ${LEDGER_JOB} job in the e2e workflow`, () => {
    expect(workflowText()).toMatch(new RegExp(`^ {2}${LEDGER_JOB}:`, 'm'));
  });

  it(`runs the ${LEDGER_SCRIPT} script from that job`, () => {
    expect(workflowText()).toContain(LEDGER_SCRIPT);
  });

  it(`exposes ${LEDGER_SCRIPT} as its own package script`, () => {
    expect(packageScripts()[LEDGER_SCRIPT]).toBeDefined();
  });

  it('runs the gate through jest rather than a bare echo', () => {
    expect(packageScripts()[LEDGER_SCRIPT] ?? '').toContain('jest');
  });
});
