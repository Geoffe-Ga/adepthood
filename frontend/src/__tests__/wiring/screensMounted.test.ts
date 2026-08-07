import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '..', '..');
const FEATURES_DIR = path.join(SRC, 'features');
const NAVIGATION_DIR = path.join(SRC, 'navigation');
// App.tsx is a navigator root, not just the entry point: the six Auth screens
// and WelcomeScreen are mounted by ``AuthNavigator`` / ``WelcomeGate`` there and
// are never imported from ``navigation/``. Omitting it would blind the guard to
// seven screens.
const APP_ENTRY = path.join(SRC, 'App.tsx');

const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);
const MODULE_SUFFIXES = ['.tsx', '.ts', '/index.tsx', '/index.ts'];
const MIN_JUSTIFICATION_LENGTH = 20;

/**
 * Screens knowingly absent from every navigator, keyed by their path relative
 * to ``src``. The justification is DATA, not a comment: an inert code comment
 * cannot fail a test, so the excuse is a required non-empty string that the
 * self-lint below asserts on, and stale entries fail too -- the allowlist is a
 * ratchet that can only shrink.
 */
const SCREEN_ALLOWLIST: Record<string, string> = {};

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

function walk(dir: string, matches: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full, matches));
    } else if (entry.isFile() && matches(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const isScreenFile = (name: string): boolean =>
  /Screen\.tsx$/.test(name) && !/\.(test|spec)\.tsx$/.test(name);

const isSourceFile = (name: string): boolean =>
  /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name);

/** A named import binding is a mount only if it carries a runtime value. */
function isTypeOnlyClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined || clause.name !== undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) {
    return false;
  }
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

function literalSpecifier(node: ts.Expression | undefined): string | null {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : null;
}

/** The module specifier of a value-carrying import/export, else null. */
function valueModuleSpecifier(node: ts.Statement): string | null {
  if (ts.isImportDeclaration(node)) {
    return isTypeOnlyClause(node.importClause) ? null : literalSpecifier(node.moduleSpecifier);
  }
  if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
    return literalSpecifier(node.moduleSpecifier);
  }
  return null;
}

function valueImports(file: string): string[] {
  const specifiers: string[] = [];
  for (const statement of parseFile(file).statements) {
    const specifier = valueModuleSpecifier(statement);
    if (specifier !== null) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** ``@/x`` mirrors the jest ``moduleNameMapper``; bare packages are not ours. */
function basePath(specifier: string, importerDir: string): string | null {
  if (specifier.startsWith('@/')) {
    return path.join(SRC, specifier.slice(2));
  }
  return specifier.startsWith('.') ? path.resolve(importerDir, specifier) : null;
}

function resolveModule(specifier: string, importerDir: string): string | null {
  const base = basePath(specifier, importerDir);
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

/** A pure re-export hub: nothing but imports and exports, at least one of which
 * forwards another module. Screens reached through one still count as mounted. */
function isBarrel(file: string): boolean {
  const { statements } = parseFile(file);
  const forwards = statements.some(
    (s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined,
  );
  return (
    forwards && statements.every((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s))
  );
}

function noteReference(
  resolved: string,
  referenced: Set<string>,
  visited: Set<string>,
  queue: string[],
): void {
  referenced.add(resolved);
  if (!visited.has(resolved) && isBarrel(resolved)) {
    visited.add(resolved);
    queue.push(resolved);
  }
}

function referencedModules(roots: string[]): Set<string> {
  const referenced = new Set<string>();
  const visited = new Set<string>(roots);
  const queue = [...roots];
  let file = queue.pop();
  while (file !== undefined) {
    for (const specifier of valueImports(file)) {
      const resolved = resolveModule(specifier, path.dirname(file));
      if (resolved !== null) {
        noteReference(resolved, referenced, visited, queue);
      }
    }
    file = queue.pop();
  }
  return referenced;
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

function unmountedScreens(): string[] {
  const roots = [APP_ENTRY, ...walk(NAVIGATION_DIR, isSourceFile)];
  const referenced = referencedModules(roots);
  return walk(FEATURES_DIR, isScreenFile)
    .filter((screen) => !referenced.has(screen))
    .map((screen) => path.relative(SRC, screen))
    .sort();
}

/**
 * Static reachability guard: every ``*Screen.tsx`` under ``src/features`` is
 * imported by a navigator root (``src/navigation/**`` or ``src/App.tsx``).
 *
 * Limitation, stated honestly: "mounted" here means "statically imported by a
 * navigator". A screen that is imported but never rendered in a
 * ``<Stack.Screen component={...}>`` would slip past. That hole is closed by a
 * different gate -- ESLint runs at zero warnings with ``no-unused-vars``, so an
 * import nothing renders fails lint. JSX-level verification is deliberately not
 * attempted: it would require resolving component identifiers through the type
 * checker for no coverage the composed gates do not already give.
 */
describe('wiring: every feature screen is mounted in a navigator', () => {
  it('has no screen missing from every navigator root', () => {
    // Non-emptiness first: a walk that finds nothing would otherwise report
    // zero violations forever, and the guard would pass by doing nothing.
    expect(walk(FEATURES_DIR, isScreenFile).length).toBeGreaterThan(0);
    const violations = unmountedScreens().filter((screen) => !(screen in SCREEN_ALLOWLIST));
    expect(violations).toEqual([]);
  });

  it('keeps allowlist entries justified and current', () => {
    const unmounted = new Set(unmountedScreens());
    const problems = Object.entries(SCREEN_ALLOWLIST).flatMap(([screen, justification]) =>
      allowlistProblems(screen, justification, unmounted),
    );
    expect(problems).toEqual([]);
  });
});
