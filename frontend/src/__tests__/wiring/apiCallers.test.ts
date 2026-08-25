import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(SRC, 'api');
const API_INDEX = path.join(API_DIR, 'index.ts');

const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);
const MODULE_SUFFIXES = ['.tsx', '.ts', '/index.tsx', '/index.ts'];
const MIN_JUSTIFICATION_LENGTH = 20;

/**
 * Endpoint wrappers knowingly without a production reference, keyed by
 * ``symbol`` or ``namespace.method``. The justification is DATA, not a comment:
 * an inert code comment cannot fail a test, so the excuse is a required
 * non-empty string that the self-lint below asserts on, and stale entries fail
 * too -- the allowlist is a ratchet that can only shrink.
 */
const CALLER_ALLOWLIST: Record<string, string> = {
  classifyUnauthorizedDetail:
    'Called inside the API layer by the 401 handler; exported only so its detail-string parsing can be unit tested directly.',
  fetchAllPages:
    'Called inside the API layer by listAll and the other Page-envelope readers; exported only for direct unit coverage of the pagination loop.',
  'habits.list':
    'Deliberately retained beside listAll as the request-machinery test vehicle and bare-array wire-contract guard, per its own docstring in src/api/index.ts.',
  idempotencyKey:
    'Called inside the API layer to key suggestion-accept, invitation-dismiss and return-start; exported for unit coverage, and its caller-supplied seam on the habit check-in wrapper is still unadopted by any screen.',
  'practiceTags.remove':
    'Wraps the live DELETE /practice-tags/{tag_id} route; the tag library UI can list and create tags but not delete one, so this is tracked for adoption or removal.',
  'practiceTags.update':
    'Wraps the live PATCH /practice-tags/{tag_id} route; the tag library UI can list and create tags but not rename one, so this is tracked for adoption or removal.',
  'prompts.history':
    'Wraps the live GET /prompts/history route, for which no prompt screen offers an affordance yet; tracked for adoption or removal.',
};

const sourceCache = new Map<string, ts.SourceFile>();

function parseFile(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  sourceCache.set(file, parsed);
  return parsed;
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full));
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

// --- Side one: the endpoint wrappers the API module exposes -----------------

function isFunctionValued(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isExported(node: ts.Statement): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

/** Every function-valued member of an exported namespace object, as ``X.method``. */
function objectMembers(namespace: string, object: ts.ObjectLiteralExpression): string[] {
  const members: string[] = [];
  for (const property of object.properties) {
    if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) {
      members.push(`${namespace}.${property.name.text}`);
    } else if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      isFunctionValued(property.initializer)
    ) {
      members.push(`${namespace}.${property.name.text}`);
    }
  }
  return members;
}

function declarationSymbols(declaration: ts.VariableDeclaration): string[] {
  if (!ts.isIdentifier(declaration.name)) {
    return [];
  }
  const name = declaration.name.text;
  const initializer = declaration.initializer;
  if (isFunctionValued(initializer)) {
    return [name];
  }
  if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
    return objectMembers(name, initializer);
  }
  return [];
}

/**
 * Endpoint wrappers, selected by SHAPE rather than by name so the list cannot
 * drift: exported function declarations, exported function-valued consts, and
 * every function-valued member of an exported object-literal const.
 *
 * Enumerating namespace objects member by member is the point. Treating
 * ``habits`` as one symbol would pass all eight of its methods the moment any
 * one of them is referenced, which is nearly no guard at all.
 *
 * Falling out by shape, deliberately: ``export class`` (ApiError and friends
 * are error types, not wrappers), ``interface`` / ``type`` aliases, re-exports,
 * and consts whose initializer is a primitive (the timeout and header
 * constants). No name list is maintained anywhere.
 */
function exportedWrappers(): string[] {
  const symbols: string[] = [];
  for (const statement of parseFile(API_INDEX).statements) {
    if (!isExported(statement)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      symbols.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        symbols.push(...declarationSymbols(declaration));
      }
    }
  }
  return symbols.sort();
}

// --- Side two: what production code actually references ---------------------

interface ApiBindings {
  /** local name -> exported name, so ``import { auth as authApi }`` resolves. */
  named: Map<string, string>;
  /** locals bound by ``import * as api from '@/api'``. */
  namespaces: Set<string>;
}

function resolveSpecifier(specifier: string, importerDir: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('@/')) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = path.resolve(importerDir, specifier);
  }
  if (base === null) {
    return null;
  }
  for (const suffix of MODULE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function reExportsFromApiIndex(statement: ts.Statement, file: string): ts.NamedExports | null {
  if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
    return null;
  }
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) {
    return null;
  }
  if (resolveSpecifier(specifier.text, path.dirname(file)) !== API_INDEX) {
    return null;
  }
  const clause = statement.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) ? clause : null;
}

/**
 * Names a module under ``src/api`` forwards out of ``index.ts``, mapped back to
 * their ``index.ts`` name. ``@/api/practiceShare`` is exactly such a barrel and
 * is the only path its consumers use, so binding solely on ``@/api`` would
 * report all five share wrappers as dead.
 */
function forwardedNames(file: string): Map<string, string> {
  const forwarded = new Map<string, string>();
  if (file === API_INDEX || !file.startsWith(API_DIR + path.sep)) {
    return forwarded;
  }
  for (const statement of parseFile(file).statements) {
    const clause = reExportsFromApiIndex(statement, file);
    for (const element of clause?.elements ?? []) {
      if (!element.isTypeOnly) {
        forwarded.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }
  return forwarded;
}

interface ApiImportLink {
  clause: ts.ImportClause;
  /** null for a direct ``src/api`` import; otherwise a barrel's name mapping. */
  translation: Map<string, string> | null;
}

/** Resolve, never string-match: ``@/api``, ``../api`` and ``@/api/practiceShare``
 * all reach the same surface, and only resolution can tell. */
function apiImportLink(statement: ts.Statement, file: string): ApiImportLink | null {
  if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) {
    return null;
  }
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) {
    return null;
  }
  const resolved = resolveSpecifier(specifier.text, path.dirname(file));
  if (resolved === null) {
    return null;
  }
  const clause = statement.importClause;
  if (resolved === API_INDEX) {
    return { clause, translation: null };
  }
  const forwarded = forwardedNames(resolved);
  return forwarded.size > 0 ? { clause, translation: forwarded } : null;
}

function boundExportName(
  element: ts.ImportSpecifier,
  translation: Map<string, string> | null,
): string | undefined {
  if (element.isTypeOnly) {
    return undefined;
  }
  const exported = (element.propertyName ?? element.name).text;
  return translation === null ? exported : translation.get(exported);
}

function addClauseBindings(link: ApiImportLink, bindings: ApiBindings): void {
  const { clause, translation } = link;
  if (clause.isTypeOnly) {
    return;
  }
  const named = clause.namedBindings;
  if (named === undefined) {
    return;
  }
  if (ts.isNamespaceImport(named)) {
    if (translation === null) {
      bindings.namespaces.add(named.name.text);
    }
    return;
  }
  for (const element of named.elements) {
    const exported = boundExportName(element, translation);
    if (exported !== undefined) {
      bindings.named.set(element.name.text, exported);
    }
  }
}

/** Local bindings a consumer holds on the API surface. */
function apiBindings(source: ts.SourceFile, file: string): ApiBindings {
  const bindings: ApiBindings = { named: new Map(), namespaces: new Set() };
  for (const statement of source.statements) {
    const link = apiImportLink(statement, file);
    if (link !== null) {
      addClauseBindings(link, bindings);
    }
  }
  return bindings;
}

function recordPropertyAccess(
  node: ts.PropertyAccessExpression,
  bindings: ApiBindings,
  reached: Set<string>,
): void {
  const object = node.expression;
  if (ts.isIdentifier(object)) {
    const exported = bindings.named.get(object.text);
    if (exported !== undefined) {
      reached.add(`${exported}.${node.name.text}`);
    } else if (bindings.namespaces.has(object.text)) {
      reached.add(node.name.text);
    }
    return;
  }
  if (
    ts.isPropertyAccessExpression(object) &&
    ts.isIdentifier(object.expression) &&
    bindings.namespaces.has(object.expression.text)
  ) {
    reached.add(`${object.name.text}.${node.name.text}`);
  }
}

function recordReference(node: ts.Node, bindings: ApiBindings, reached: Set<string>): void {
  if (ts.isPropertyAccessExpression(node)) {
    recordPropertyAccess(node, bindings, reached);
    return;
  }
  if (ts.isIdentifier(node)) {
    const exported = bindings.named.get(node.text);
    if (exported !== undefined) {
      reached.add(exported);
    }
  }
}

/**
 * Reference-based, not call-based. Wrappers are injected as values here (a
 * screen passes ``practiceRecipes.list`` down as a prop default), so demanding
 * a following ``(`` would report those as dead.
 *
 * ``import`` declarations are not walked -- importing a symbol is not using it
 * -- and ``ts.TypeQueryNode`` subtrees are skipped, so ``typeof
 * practiceRecipes.list`` in a prop type does not count as a value reference.
 */
function collectReferences(file: string, reached: Set<string>): void {
  const source = parseFile(file);
  const bindings = apiBindings(source, file);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) {
    return;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isTypeQueryNode(node)) {
      return;
    }
    recordReference(node, bindings, reached);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/** Production consumers: all of ``src`` except the API module and test scaffolding. */
function consumerFiles(): string[] {
  return walk(SRC).filter((file) => !file.startsWith(API_DIR + path.sep));
}

function referencedSymbols(): Set<string> {
  const reached = new Set<string>();
  for (const file of consumerFiles()) {
    collectReferences(file, reached);
  }
  return reached;
}

function unreferencedWrappers(): string[] {
  const reached = referencedSymbols();
  return exportedWrappers().filter((symbol) => !reached.has(symbol));
}

function allowlistProblems(key: string, justification: string, violations: Set<string>): string[] {
  const problems: string[] = [];
  if (justification.trim().length < MIN_JUSTIFICATION_LENGTH) {
    problems.push(
      `allowlist entry '${key}' needs a justification of at least ${MIN_JUSTIFICATION_LENGTH} characters`,
    );
  }
  if (!violations.has(key)) {
    problems.push(`stale allowlist entry '${key}' -- remove it`);
  }
  return problems;
}

describe('wiring: every API endpoint wrapper has a production reference', () => {
  it('has no endpoint wrapper unreachable from production code', () => {
    // Non-emptiness first: an enumeration that finds nothing would report zero
    // violations forever, and the guard would pass by doing nothing.
    expect(exportedWrappers().length).toBeGreaterThan(0);
    const violations = unreferencedWrappers().filter((symbol) => !(symbol in CALLER_ALLOWLIST));
    expect(violations).toEqual([]);
  });

  it('keeps allowlist entries justified and current', () => {
    const unreferenced = new Set(unreferencedWrappers());
    const problems = Object.entries(CALLER_ALLOWLIST).flatMap(([symbol, justification]) =>
      allowlistProblems(symbol, justification, unreferenced),
    );
    expect(problems).toEqual([]);
  });
});
