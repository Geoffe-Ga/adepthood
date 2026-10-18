import ts from 'typescript';

/**
 * Whether a suite that read backend source declared itself, and what to say.
 *
 * The observation half of this guard lives in `jest.setup.crossBoundary.js`,
 * which instruments `fs` for every suite. The judgement half lives here, as a
 * pure function over what was observed, so the rule can be exercised by a test
 * instead of only by being tripped: a check nobody has watched fire is
 * indistinguishable from one that cannot.
 */

/**
 * The module specifier that makes a cross-boundary test discoverable.
 *
 * `scripts/frontend/cross-boundary-drift.sh` recognizes imports of this exact
 * module specifier to decide which tests backend CI runs, so a test that reads
 * backend source without importing the helper is invisible to the change it
 * exists to catch.
 */
export const CROSS_BOUNDARY_MARKER = '@/testing/backendSource';

function declaresCrossBoundaryImport(testFile: string, testSource: string): boolean {
  const kind = testFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(testFile, testSource, ts.ScriptTarget.Latest, true, kind);
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === CROSS_BOUNDARY_MARKER,
  );
}

/**
 * Describe an undeclared crossing of the frontend/backend boundary.
 *
 * @param testFile - The suite's path, as it should appear in the message.
 * @param testSource - That file's own source, searched for the marker.
 * @param reads - Repository-relative backend paths the suite read.
 * @returns The failure message, or null when there is nothing to report --
 *   either the suite stayed inside `frontend/`, or it declared itself.
 */
export function undeclaredCrossBoundaryRead(
  testFile: string,
  testSource: string,
  reads: readonly string[],
): string | null {
  if (reads.length === 0) return null;
  if (declaresCrossBoundaryImport(testFile, testSource)) return null;
  return (
    `${testFile} read ${reads.join(', ')} but does not import '${CROSS_BOUNDARY_MARKER}'. ` +
    `Backend CI discovers the cross-boundary guards by that import, so as written this ` +
    `test cannot run on the backend change it exists to catch. Read backend source ` +
    `through the helper instead of resolving a path by hand.`
  );
}
