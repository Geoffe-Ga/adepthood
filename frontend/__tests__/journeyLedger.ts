import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The checker behind `e2e/journeys.json` — the repository's journey coverage
 * ledger.
 *
 * A prose list of "the journeys we test end to end" is a belief. Nothing reads
 * it, so it survives a rename, a deletion, or a quietly skipped spec without
 * changing a character, and then it lies. This module turns the same list into
 * a checked claim: every declared journey must name a spec that exists and
 * still runs, every spec in the lane must be declared, and every surface a
 * journey says it crosses — screen, client wrapper, route, table — must still
 * be there under that name.
 *
 * Honest gaps are first-class. A journey may declare `status: "uncovered"` with
 * a linked issue; the audit counts it and reports it, and does not fail on it.
 * A gate that goes red for accurate bookkeeping is a gate that gets deleted.
 *
 * Everything the audit needs about the repository arrives through
 * `LedgerEnvironment`, so each failure mode can be reproduced against a
 * three-line fixture rather than a doctored checkout. `realLedgerEnvironment`
 * builds the one that describes this repository.
 */

const COVERED = 'covered';
const UNCOVERED = 'uncovered';

const LEDGER_PATH = 'frontend/e2e/journeys.json';
const JOURNEY_DIR = 'frontend/e2e';
const SPEC_SUFFIX = '.e2e.test.ts';
const API_MODULE = 'frontend/src/api/index.ts';
const OPENAPI_SCHEMA = 'backend/openapi.json';
const MODELS_DIR = 'backend/src/models';

/**
 * Spellings that leave a spec present in the tree but absent from the run.
 *
 * `.only` sits beside `.skip` here on purpose: a spec narrowed to one case
 * still exists, still passes, and still covers almost nothing.
 */
const DISABLED_MARKERS: readonly string[] = [
  'describe.skip',
  'describe.only',
  'xdescribe(',
  'it.skip',
  'it.only',
  'xit(',
  'test.skip',
  'test.only',
  'xtest(',
];

/** An `it(` or `test(` that is neither prefixed (`xit`) nor suffixed (`.skip`). */
const ENABLED_TEST = /(?<![.\w])(?:it|test)\s*\(/;

const EXPORTED_SYMBOL = /^export\s+(?:const|function|async function|class)\s+(\w+)/gm;
const TABLE_CLASS = /^class\s+(\w+)\([^)]*table\s*=\s*True/gm;
const EXPLICIT_TABLE_NAME = /^\s*__tablename__\s*=\s*"(\w+)"/gm;

/** The four surfaces a journey has to cross to be worth calling one. */
export interface JourneyCrossing {
  readonly screen: string;
  readonly client: readonly string[];
  readonly routes: readonly string[];
  readonly tables: readonly string[];
}

export interface JourneyEntry {
  readonly id: string;
  readonly description: string;
  readonly status: string;
  readonly crosses: JourneyCrossing;
  readonly coveredBy: string | null;
  readonly issue: number | null;
}

/** Everything the audit is allowed to know about the repository. */
export interface LedgerEnvironment {
  /** Repo-relative paths of the seam-crossing specs the e2e lane ships. */
  readonly specFiles: readonly string[];
  readonly fileExists: (repoRelativePath: string) => boolean;
  readonly readFile: (repoRelativePath: string) => string;
  readonly clientSymbols: ReadonlySet<string>;
  /** `"POST /habits/"`-shaped keys drawn from the exported OpenAPI schema. */
  readonly routes: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
}

export interface LedgerAudit {
  readonly problems: readonly string[];
  readonly covered: number;
  readonly uncovered: number;
}

interface ParsedLedger {
  readonly entries: readonly JourneyEntry[];
  /** Every `coveredBy` any entry named, valid or not, so the reverse check
   *  cannot double-report an entry the shape check already rejected. */
  readonly claims: readonly string[];
  readonly problems: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function compact(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stringField(record: Record<string, unknown>, key: string, where: string): string | null {
  if (nonEmptyString(record[key])) {
    return null;
  }
  return `${where}: "${key}" must be a non-empty string.`;
}

function stringListField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = record[key];
  if (Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)) {
    return null;
  }
  return `${where}: "${key}" must be a non-empty list of strings.`;
}

function crossingProblems(record: Record<string, unknown>, where: string): string[] {
  const crosses = asRecord(record['crosses']);
  if (crosses === null) {
    return [`${where}: "crosses" must name the screen, client, routes and tables it touches.`];
  }
  return compact([
    stringField(crosses, 'screen', where),
    stringListField(crosses, 'client', where),
    stringListField(crosses, 'routes', where),
    stringListField(crosses, 'tables', where),
  ]);
}

function statusProblems(record: Record<string, unknown>, where: string): string[] {
  const status = record['status'];
  if (status === COVERED) {
    return compact([stringField(record, 'coveredBy', where)]);
  }
  if (status === UNCOVERED) {
    const issue = record['issue'];
    if (typeof issue === 'number' && Number.isInteger(issue) && issue > 0) {
      return [];
    }
    return [`${where}: an "${UNCOVERED}" journey must link an "issue" number.`];
  }
  return [`${where}: "status" must be "${COVERED}" or "${UNCOVERED}".`];
}

function toEntry(record: Record<string, unknown>): JourneyEntry {
  const crosses = asRecord(record['crosses']) ?? {};
  return {
    id: String(record['id']),
    description: String(record['description']),
    status: String(record['status']),
    crosses: {
      screen: String(crosses['screen']),
      client: crosses['client'] as readonly string[],
      routes: crosses['routes'] as readonly string[],
      tables: crosses['tables'] as readonly string[],
    },
    coveredBy: nonEmptyString(record['coveredBy']) ? record['coveredBy'] : null,
    issue: typeof record['issue'] === 'number' ? record['issue'] : null,
  };
}

function parseEntries(raw: readonly unknown[]): ParsedLedger {
  const entries: JourneyEntry[] = [];
  const claims: string[] = [];
  const problems: string[] = [];

  for (const [index, value] of raw.entries()) {
    const where = `journeys[${index}]`;
    const record = asRecord(value);
    if (record === null) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    if (nonEmptyString(record['coveredBy'])) {
      claims.push(record['coveredBy']);
    }
    const found = [
      ...compact([stringField(record, 'id', where), stringField(record, 'description', where)]),
      ...crossingProblems(record, where),
      ...statusProblems(record, where),
    ];
    if (found.length > 0) {
      problems.push(...found);
      continue;
    }
    entries.push(toEntry(record));
  }

  return { entries, claims, problems };
}

function duplicateIdProblems(entries: readonly JourneyEntry[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      problems.push(`duplicate journey id "${entry.id}"; ids address one journey each.`);
    }
    seen.add(entry.id);
  }
  return problems;
}

function doubleClaimProblems(claims: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    counts.set(claim, (counts.get(claim) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(
      ([spec, count]) =>
        `${spec} is claimed by ${count} journeys; one spec covers one journey, or the ` +
        `ledger inflates its own coverage.`,
    );
}

function unregisteredSpecProblems(
  claims: readonly string[],
  environment: LedgerEnvironment,
): string[] {
  const claimed = new Set(claims);
  return environment.specFiles
    .filter((spec) => !claimed.has(spec))
    .map((spec) => `${spec} crosses the seam but no journey registers it.`);
}

function coveringSpecProblem(entry: JourneyEntry, environment: LedgerEnvironment): string | null {
  const path = entry.coveredBy;
  if (path === null) {
    return null;
  }
  if (!environment.fileExists(path)) {
    return `${entry.id} -> ${path} (not found).`;
  }
  const text = environment.readFile(path);
  const disabled = DISABLED_MARKERS.find((marker) => text.includes(marker));
  if (disabled !== undefined) {
    return `${entry.id} -> ${path} has no enabled test: it uses "${disabled}".`;
  }
  if (!ENABLED_TEST.test(text)) {
    return `${entry.id} -> ${path} has no enabled test.`;
  }
  return null;
}

function membershipProblems(
  values: readonly string[],
  known: ReadonlySet<string>,
  describe: (value: string) => string,
): string[] {
  return values.filter((value) => !known.has(value)).map(describe);
}

function crossingSurfaceProblems(entry: JourneyEntry, environment: LedgerEnvironment): string[] {
  const { screen, client, routes, tables } = entry.crosses;
  const screenProblems = environment.fileExists(screen)
    ? []
    : [`${entry.id} crosses ${screen}, which no longer exists.`];
  return [
    ...screenProblems,
    ...membershipProblems(
      client,
      environment.clientSymbols,
      (name) => `${entry.id} names client "${name}", which ${API_MODULE} does not export.`,
    ),
    ...membershipProblems(
      routes,
      environment.routes,
      (route) => `${entry.id} names route "${route}", which the exported schema does not serve.`,
    ),
    ...membershipProblems(
      tables,
      environment.tables,
      (table) => `${entry.id} names table "${table}", which no model declares.`,
    ),
  ];
}

function refuse(problem: string): LedgerAudit {
  return { problems: [problem], covered: 0, uncovered: 0 };
}

/** Audit a parsed ledger against a description of the repository. */
export function auditJourneyLedger(raw: unknown, environment: LedgerEnvironment): LedgerAudit {
  if (!Array.isArray(raw)) {
    return refuse('The journey ledger must be a JSON array of journey objects.');
  }
  if (raw.length === 0) {
    return refuse('The journey ledger is empty; a ledger that declares nothing checks nothing.');
  }

  const parsed = parseEntries(raw);
  const problems = [
    ...parsed.problems,
    ...duplicateIdProblems(parsed.entries),
    ...doubleClaimProblems(parsed.claims),
    ...unregisteredSpecProblems(parsed.claims, environment),
    ...parsed.entries.flatMap((entry) => compact([coveringSpecProblem(entry, environment)])),
    ...parsed.entries.flatMap((entry) => crossingSurfaceProblems(entry, environment)),
  ];

  return {
    problems,
    covered: parsed.entries.filter((entry) => entry.status === COVERED).length,
    uncovered: parsed.entries.filter((entry) => entry.status === UNCOVERED).length,
  };
}

/** Human-readable audit output, in the shape the gate prints on failure. */
export function summariseAudit(audit: LedgerAudit): string {
  const lines = audit.problems.map((problem) => `  x ${problem}`);
  lines.push(`  ${audit.covered} covered, ${audit.uncovered} uncovered (see the linked issues).`);
  return lines.join('\n');
}

export function readLedger(repoRoot: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, LEDGER_PATH), 'utf8'));
}

function exportedSymbols(path: string): ReadonlySet<string> {
  const text = readFileSync(path, 'utf8');
  return new Set([...text.matchAll(EXPORTED_SYMBOL)].map((match) => match[1] ?? ''));
}

function openApiRoutes(path: string): ReadonlySet<string> {
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const paths = asRecord(asRecord(document)?.['paths']) ?? {};
  const routes = new Set<string>();
  for (const [route, operations] of Object.entries(paths)) {
    for (const method of Object.keys(asRecord(operations) ?? {})) {
      routes.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return routes;
}

function declaredTables(directory: string): ReadonlySet<string> {
  const tables = new Set<string>();
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.py'))) {
    const text = readFileSync(join(directory, name), 'utf8');
    for (const match of text.matchAll(TABLE_CLASS)) {
      tables.add((match[1] ?? '').toLowerCase());
    }
    for (const match of text.matchAll(EXPLICIT_TABLE_NAME)) {
      tables.add(match[1] ?? '');
    }
  }
  return tables;
}

/** The environment describing this repository, as the CI gate sees it. */
export function realLedgerEnvironment(repoRoot: string): LedgerEnvironment {
  const absolute = (path: string): string => join(repoRoot, path);
  return {
    specFiles: readdirSync(absolute(JOURNEY_DIR))
      .filter((name) => name.endsWith(SPEC_SUFFIX))
      .map((name) => `${JOURNEY_DIR}/${name}`)
      .sort(),
    fileExists: (path) => existsSync(absolute(path)),
    readFile: (path) => readFileSync(absolute(path), 'utf8'),
    clientSymbols: exportedSymbols(absolute(API_MODULE)),
    routes: openApiRoutes(absolute(OPENAPI_SCHEMA)),
    tables: declaredTables(absolute(MODELS_DIR)),
  };
}
