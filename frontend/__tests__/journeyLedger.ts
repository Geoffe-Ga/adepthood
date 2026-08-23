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
 * A route clears two different checks, because they answer different questions.
 * The exported schema says the server would answer it; the API module's own call
 * sites say the app can ask. A route that passes the first and fails the second
 * is served and unreachable, and a journey naming one describes a seam that does
 * not exist — a spec written to it would have to hand-roll the request itself,
 * and would prove only that the server works.
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
 * Every `describe`/`it`/`test` registration, with the `x` prefix and the
 * `.skip`/`.only`/`.each` chain that decides whether it runs.
 *
 * Matching registrations rather than searching for marker substrings is what
 * keeps a comment or a test name that merely mentions `it.skip(` from reading
 * as a skipped test.
 */
const REGISTRATION = /(?<![.\w])(x?)(describe|it|test)((?:\.\w+)*)\s*\(/g;

/**
 * Comments and quoted text: they can name a marker without registering one.
 *
 * Quoted strings are held to a single line, as JavaScript holds them, so an
 * apostrophe the lexer cannot pair -- inside a regex literal, say, which this
 * does not model -- blanks at most the rest of its own line.
 */
const INERT_SPANS =
  /\/\*[\S\s]*?\*\/|\/\/[^\n]*|`(?:\\[\S\s]|[^\\`])*`|'(?:\\[^\n]|[^\n'\\])*'|"(?:\\[^\n]|[^\n"\\])*"/g;

/** Modifiers that leave the registration in the file but out of the run. */
const DISABLING = new Set(['skip', 'todo']);

/**
 * Modifiers that keep one registration and silently drop its siblings.
 *
 * `.only` is a problem even beside a live test -- in fact especially then,
 * because the tests it silences are the ones the ledger is claiming.
 */
const NARROWING = new Set(['only']);

/**
 * Where the API module spells a call: `request<T>(` and the argument list that
 * follows it. The declaration of `request` itself matches too, and is dropped
 * downstream by the same rule that drops any dynamically built path -- its first
 * argument is a parameter name, not a literal.
 *
 * Assumes every call site writes the generic explicitly. A bare `request(...)`
 * would be invisible here, and the route it reaches would read as uncalled --
 * so a journey declaring that route would fail for a reason that is not true.
 * No such call site exists today; widen this if one appears.
 */
const REQUEST_CALL = /request<[^(]*?>\(/g;

/** A path segment filled in at call time, on either side of the comparison. */
const PARAMETER = '*';

/** `{entry_id}` and friends, as the OpenAPI document spells a path parameter. */
const ROUTE_PARAMETER = /\{[^}]*\}/g;

/** The method one call declares. Absent means GET, as `request` itself defaults. */
const METHOD_OPTION = /method:\s*['"]([A-Z]+)['"]/;

const DEFAULT_METHOD = 'GET';

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
  /**
   * `"GET /habits/*"`-shaped keys drawn from the API module's own call sites:
   * the requests the production client can actually issue, with each
   * interpolated path segment written as `*`.
   */
  readonly clientRoutes: ReadonlySet<string>;
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

/**
 * What an `uncovered` journey owes: a linked issue, and no claim on a spec.
 *
 * Both are reported together rather than the first one found, so an entry that
 * gets both wrong does not have half its story hidden until the other half is
 * fixed.
 */
function uncoveredProblems(record: Record<string, unknown>, where: string): string[] {
  const issue = record['issue'];
  const linked = typeof issue === 'number' && Number.isInteger(issue) && issue > 0;
  return compact([
    linked ? null : `${where}: an "${UNCOVERED}" journey must link an "issue" number.`,
    nonEmptyString(record['coveredBy'])
      ? `${where}: an "${UNCOVERED}" journey must not name a "coveredBy" spec; claiming a spec ` +
        `while counting as a gap hides the spec from both tallies.`
      : null,
  ]);
}

function statusProblems(record: Record<string, unknown>, where: string): string[] {
  const status = record['status'];
  if (status === COVERED) {
    return compact([stringField(record, 'coveredBy', where)]);
  }
  if (status === UNCOVERED) {
    return uncoveredProblems(record, where);
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

type RunState = 'enabled' | 'disabled' | 'narrowed';

interface Registration {
  /** How the call is spelled, e.g. `it.skip` or `xdescribe`. */
  readonly marker: string;
  readonly isSuite: boolean;
  readonly state: RunState;
  /** Offset just past the opening `(`, where the registration's body starts. */
  readonly bodyAt: number;
}

/** Blank out comments and string literals, preserving every offset. */
function blankInertSpans(source: string): string {
  return source.replace(INERT_SPANS, (span) => span.replace(/[^\n]/g, ' '));
}

function runState(prefix: string, suffix: string): RunState {
  const modifiers = suffix.split('.').filter((part) => part !== '');
  if (modifiers.some((modifier) => NARROWING.has(modifier))) {
    return 'narrowed';
  }
  if (prefix === 'x' || modifiers.some((modifier) => DISABLING.has(modifier))) {
    return 'disabled';
  }
  return 'enabled';
}

function registrations(code: string): Registration[] {
  return [...code.matchAll(REGISTRATION)].map((match) => {
    const [whole = '', prefix = '', name = '', suffix = ''] = match;
    return {
      marker: `${prefix}${name}${suffix}`,
      isSuite: name === 'describe',
      state: runState(prefix, suffix),
      bodyAt: (match.index ?? 0) + whole.length,
    };
  });
}

/**
 * Offset of the `}` closing the callback a suite was registered with.
 *
 * Brace counting, not parsing: comments and strings are already blanked, so
 * the only braces left are real ones. A suite registered through a table --
 * `describe.skip.each([{ ... }])` -- would have its span cut short at the
 * table's first brace; that costs precision on a spelling no spec here uses.
 */
function suiteBodyEnd(code: string, bodyAt: number): number {
  const open = code.indexOf('{', bodyAt);
  if (open < 0) {
    return code.length;
  }
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return code.length;
}

/**
 * Whether at least one test in the file would actually run.
 *
 * Deliberately independent of whether some *other* test is skipped: a spec
 * that parks one pending edge case beside a live journey still covers the
 * journey. Only a test nested inside a skipped suite fails to count.
 */
function runsAnEnabledTest(code: string, found: readonly Registration[]): boolean {
  const skipped = found
    .filter((registration) => registration.isSuite && registration.state === 'disabled')
    .map((registration) => ({
      start: registration.bodyAt,
      end: suiteBodyEnd(code, registration.bodyAt),
    }));
  return found.some(
    (registration) =>
      !registration.isSuite &&
      registration.state === 'enabled' &&
      !skipped.some((span) => registration.bodyAt > span.start && registration.bodyAt < span.end),
  );
}

function coveringSpecProblem(entry: JourneyEntry, environment: LedgerEnvironment): string | null {
  const path = entry.coveredBy;
  if (path === null) {
    return null;
  }
  if (!environment.fileExists(path)) {
    return `${entry.id} -> ${path} (not found).`;
  }
  const code = blankInertSpans(environment.readFile(path));
  const found = registrations(code);
  const narrowed = found.find((registration) => registration.state === 'narrowed');
  if (narrowed !== undefined) {
    return `${entry.id} -> ${path} is narrowed to "${narrowed.marker}": its other tests do not run.`;
  }
  if (runsAnEnabledTest(code, found)) {
    return null;
  }
  const disabled = found.find((registration) => registration.state === 'disabled');
  const because = disabled === undefined ? '' : `: it uses "${disabled.marker}"`;
  return `${entry.id} -> ${path} has no enabled test${because}.`;
}

/** Offset just past the `}` closing the `${` substitution opening at `brace`. */
function substitutionEnd(text: string, brace: number): number {
  let depth = 0;
  for (let index = brace; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
}

/** Offset of the `)` closing the argument list opening at `paren`. */
function argumentListEnd(text: string, paren: number): number {
  let depth = 0;
  for (let index = paren; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return text.length;
}

/** One step through a path literal: the text it contributes, and where reading resumes. */
interface PathStep {
  readonly text: string;
  readonly next: number;
}

/**
 * Read one character of a path literal, or one whole `${...}` substitution.
 *
 * A substitution is a segment the caller fills in, so it contributes a
 * parameter rather than its own source text, and reading resumes past the brace
 * that closes it -- which is what carries the reader over a nested template.
 */
function pathStep(args: string, index: number, quote: string): PathStep {
  const char = args[index];
  if (char === '\\') {
    return { text: args[index + 1] ?? '', next: index + 2 };
  }
  if (quote === '`' && char === '$' && args[index + 1] === '{') {
    return { text: PARAMETER, next: substitutionEnd(args, index + 1) };
  }
  return { text: char ?? '', next: index + 1 };
}

/**
 * The route a call's first argument addresses, or `null` when it is not written
 * as a literal path.
 *
 * Read character by character rather than by regex because the paths are
 * template literals whose substitutions nest -- `journal.list` interpolates a
 * template inside its own -- and a pattern that stopped at the first inner
 * backtick would report the whole journal collection unreachable. Everything
 * from a literal `?` on is the query string, which is not part of the route the
 * server matched on.
 */
function pathLiteral(argumentList: string): string | null {
  const args = argumentList.trimStart();
  const quote = args[0];
  if (quote !== "'" && quote !== '`') {
    return null;
  }
  let path = '';
  let index = 1;
  while (index < args.length) {
    const char = args[index];
    // The closing delimiter ends the literal, and a `?` ends the route: what
    // follows it is the query string, which the server did not match on.
    if (char === quote || char === '?') {
      return path.startsWith('/') ? path : null;
    }
    const step = pathStep(args, index, quote);
    path += step.text;
    index = step.next;
  }
  return null;
}

/**
 * Every request the API module can issue, as `"GET /habits/*"`-shaped keys.
 *
 * Exported so it can be read against source text directly. A reader that
 * matched nothing and a reader that matched everything both leave the committed
 * ledger green, and only a fixture can tell them apart.
 */
export function clientRoutesFromSource(source: string): ReadonlySet<string> {
  const issued = new Set<string>();
  for (const call of source.matchAll(REQUEST_CALL)) {
    const paren = (call.index ?? 0) + call[0].length - 1;
    const args = source.slice(paren + 1, argumentListEnd(source, paren));
    const path = pathLiteral(args);
    if (path !== null) {
      issued.add(`${METHOD_OPTION.exec(args)?.[1] ?? DEFAULT_METHOD} ${path}`);
    }
  }
  return issued;
}

/** Whether two paths of the same shape address each other, `*` matching any segment. */
function addressesSamePath(declared: readonly string[], issued: readonly string[]): boolean {
  return (
    declared.length === issued.length &&
    declared.every(
      (segment, index) =>
        segment === issued[index] || segment === PARAMETER || issued[index] === PARAMETER,
    )
  );
}

/** Split `"GET /habits/{habit_id}"` into its method and its `*`-normalized segments. */
function methodAndSegments(route: string): [string, string[]] {
  const space = route.indexOf(' ');
  const path = route.slice(space + 1).replace(ROUTE_PARAMETER, PARAMETER);
  return [route.slice(0, space), path.split('/')];
}

/**
 * Whether some call site in the API module can produce this request.
 *
 * The question the schema check cannot ask. `backend/openapi.json` says what the
 * server would answer; it says nothing about whether the app would ever call it,
 * so a journey could name a live route no screen can reach and stay green while
 * the seam it claims to protect does not exist.
 */
function clientCanIssue(route: string, environment: LedgerEnvironment): boolean {
  const [method, declared] = methodAndSegments(route);
  return [...environment.clientRoutes].some((issued) => {
    const [issuedMethod, segments] = methodAndSegments(issued);
    return issuedMethod === method && addressesSamePath(declared, segments);
  });
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
    ...routes
      .filter((route) => !clientCanIssue(route, environment))
      .map(
        (route) =>
          `${entry.id} names route "${route}", which no call site in ${API_MODULE} can issue; ` +
          `a journey crosses a route the app reaches, not one the server merely serves.`,
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
    clientRoutes: clientRoutesFromSource(readFileSync(absolute(API_MODULE), 'utf8')),
    tables: declaredTables(absolute(MODELS_DIR)),
  };
}
