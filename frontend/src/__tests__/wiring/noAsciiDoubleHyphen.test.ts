import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * No copy the app shows may stand an ASCII double hyphen in for a dash (#2823).
 *
 * The password-recovery screens shipped "ignore the original email -- nothing
 * happens..." to readers, beside some three hundred strings that already used
 * the house dash: a spaced em dash, `` — ``. A ``--`` in prose reads as a typo
 * or a terminal, and on the recovery screens it lands on someone already
 * worried about their account.
 *
 * The guard parses each source file rather than grepping it, because the same
 * spelling is the codebase's convention in comments (``// pragma: allowlist
 * secret -- ...``) and those are not copy. Only the text a user can be shown
 * is inspected: string literals, template literal text and JSX text. A ``--``
 * counts as a dash when whitespace or the edge of the text sits on both sides
 * of it, so a fragment split across a concatenation (``'triangle ' + '-- in
 * the room'``) is still caught, while ``--flag``, ``a--b`` and a Markdown
 * ``---`` rule are not prose dashes and are left alone.
 */

const SRC = path.resolve(__dirname, '..', '..');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

/** A ``--`` with whitespace (or the edge of the text) on both sides. */
const ASCII_DOUBLE_HYPHEN_DASH = /(?:^|\s)--(?:\s|$)/u;

const isSourceFile = (name: string): boolean =>
  /\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...walk(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The node kinds that carry text a user can be shown, by the name a hit reports.
 * Named here rather than read back from ``ts.SyntaxKind``, whose reverse map
 * resolves the template kinds to their ``First``/``LastTemplateToken`` aliases.
 */
type DisplayableGuard = (node: ts.Node) => node is ts.LiteralLikeNode;

const DISPLAYABLE_KINDS: ReadonlyArray<readonly [string, DisplayableGuard]> = [
  ['StringLiteral', ts.isStringLiteral],
  ['NoSubstitutionTemplateLiteral', ts.isNoSubstitutionTemplateLiteral],
  ['TemplateHead', ts.isTemplateHead],
  ['TemplateMiddle', ts.isTemplateMiddle],
  ['TemplateTail', ts.isTemplateTail],
  ['JsxText', ts.isJsxText],
];

/** The kind name and text of a node that carries displayable text, or null otherwise. */
function displayable(node: ts.Node): { kind: string; text: string } | null {
  for (const [kind, isKind] of DISPLAYABLE_KINDS) {
    if (isKind(node)) return { kind, text: node.text };
  }
  return null;
}

/** Every ``line: kind`` in ``source`` whose displayable text uses ``--`` as a dash. */
export function findAsciiDoubleHyphens(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const shown = displayable(node);
    if (shown !== null && ASCII_DOUBLE_HYPHEN_DASH.test(shown.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      hits.push(`${line + 1}: ${shown.kind}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

// The shape CancelResetScreen shipped: the dash in the second concatenated fragment.
const CONCATENATED = `
const body =
  'If you did not request a reset, you can ignore ' +
  'the original email -- nothing happens until the link is clicked.';
const split = 'Spot the shapes -- square, circle, triangle ' + '-- in the room.';
`;

const TEMPLATES = `
const plain = \`expired -- request a new one\`;
const parts = \`head -- \${a} -- middle \${b} -- tail\`;
`;

const JSX = `
export const View = () => (
  <Text>
    Links expire in 30 minutes -- nothing happens until you click.
  </Text>
);
`;

// Spellings that are not a prose dash, and comments, which are not copy.
const NOT_COPY_DASHES = `
// pragma: allowlist secret -- a comment is not copy
/* a block comment -- also not copy */
const flag = '--email';
const joined = 'support--care';
const rule = '\\n--- server output ---\\n';
const html = '<!-- marker -->';
const typographic = 'You are offline — changes will sync.';
`;

describe('findAsciiDoubleHyphens', () => {
  it('flags a dash in a string literal, including either fragment of a concatenation', () => {
    expect(findAsciiDoubleHyphens('fixture.ts', CONCATENATED)).toEqual([
      '4: StringLiteral',
      '5: StringLiteral',
      '5: StringLiteral',
    ]);
  });

  it('flags a dash in every part of a template literal', () => {
    expect(findAsciiDoubleHyphens('fixture.ts', TEMPLATES)).toEqual([
      '2: NoSubstitutionTemplateLiteral',
      '3: TemplateHead',
      '3: TemplateMiddle',
      '3: TemplateTail',
    ]);
  });

  it('flags a dash in JSX text', () => {
    expect(findAsciiDoubleHyphens('fixture.tsx', JSX)).toEqual(['4: JsxText']);
  });

  it('leaves comments, CLI flags, joined words, rules, markup and em dashes alone', () => {
    expect(findAsciiDoubleHyphens('fixture.ts', NOT_COPY_DASHES)).toEqual([]);
  });
});

describe('no user-facing copy uses an ASCII double hyphen as a dash', () => {
  it('walks the feature screens, so the sweep below cannot pass by reading nothing', () => {
    const files = walk(SRC).map((file) => path.relative(SRC, file));
    expect(files).toContain(path.join('features', 'Auth', 'CancelResetScreen.tsx'));
    expect(files).toContain(path.join('features', 'Auth', 'ResetPasswordScreen.tsx'));
  });

  it('finds no double-hyphen dash in any string or JSX text in src', () => {
    const offenders = walk(SRC).flatMap((file) =>
      findAsciiDoubleHyphens(file, fs.readFileSync(file, 'utf-8')).map(
        (hit) => `${path.relative(SRC, file)}:${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
