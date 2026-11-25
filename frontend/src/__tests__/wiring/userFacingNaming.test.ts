import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * The app's own names for things, held against the copy it ships (epic #3802).
 *
 * "Creek" is the internal name of the software behind a person's body of
 * writing. Nobody using the app was ever told it, so no screen, error message
 * or accessibility label may say it: the app says **your Corpus**, and what
 * speaks back from it is **your Simulated Higher Self Voice** ("your Higher
 * Self Voice" once a screen has said it in full). The glossary is the "Naming"
 * section of `src/design/DESIGN.md`.
 *
 * The guard parses each source file rather than grepping it, because the
 * internal names stay everywhere a user cannot read them: comments,
 * identifiers (`FromYourCreekPanel`), import paths, test IDs and API tokens
 * (`'creek_vault'`). Only text a user can be shown is inspected: string
 * literals, template literal text and JSX text.
 *
 * **Extending it.** Each row of {@link NAMING_RULES} is one forbidden word, the
 * directories it is forbidden in, and the strings allowed to keep it. A sweep
 * that retires another word (standalone "vault", #3804 and #3805) adds a row
 * scoped to the directories it has finished, and widens the scope as it goes.
 */

const SRC = path.resolve(__dirname, '..', '..');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

/** One string allowed to keep a forbidden word, and why. */
interface AllowedString {
  /** The file, relative to `src`, with forward slashes. */
  file: string;
  /** A fragment of the string, enough to pick it out. */
  text: string;
  /** Why this one stays. Never empty. */
  why: string;
}

/** One word the app does not say, where it does not say it, and the exceptions. */
interface NamingRule {
  /** The name a failure reports. */
  name: string;
  /** What a user-facing string must not match. */
  pattern: RegExp;
  /** Directories under `src` the rule covers, with forward slashes; `''` is all of `src`. */
  scope: readonly string[];
  /** What to say instead, printed with a failure. */
  instead: string;
  /** Strings that keep the word on purpose. Expected to stay empty. */
  allowlist: readonly AllowedString[];
}

export const NAMING_RULES: readonly NamingRule[] = [
  {
    name: 'Creek',
    pattern: /Creek/u,
    scope: [''],
    instead: 'your Corpus',
    allowlist: [],
  },
  {
    // "Higher Self" names what writes reflections and letters only as part of
    // the full name. "your Higher Self Voice" is the allowed short form.
    name: 'Higher Self without Voice',
    pattern: /Higher Self(?! Voice)/u,
    scope: [''],
    instead: 'your Simulated Higher Self Voice',
    allowlist: [],
  },
  {
    // Standalone "vault", Settings first (#3804). Any case and either number,
    // so "Your vault", "a managed vault" and "managed vaults" are all held.
    // The word has to stand as a word in something longer than itself: a
    // token that only starts with it (`vault-agent-row-`, `vault:read`,
    // `vault_url_malformed`, `VaultSettings`) or is nothing else (`'vault'`,
    // the export format) is a test ID, a scope, a refusal code or a route.
    name: 'vault (Settings)',
    pattern: /(?<=\W)vaults?(?![\w:-])|(?<!\w)vaults?(?=[^\w:-])/iu,
    scope: ['features/Settings'],
    instead: 'your Corpus',
    allowlist: [
      {
        file: 'features/Settings/vaultLinks.ts',
        text: 'running-your-own-vault',
        why: 'the anchor of a heading in docs/your-data.md, opened as a link and never shown',
      },
      {
        file: 'features/Settings/saveDataExport.ts',
        text: 'adepthood-vault',
        why: 'the export file name, which the server and docs/your-data.md name the same way',
      },
    ],
  },
  {
    // Standalone "vault" outside Settings (#3805): every top-level area of
    // `src` except `features/Settings`, which #3804 sweeps. The word as a
    // word, in a capitalised label ("Reconnect Vault", "Vault") or anywhere
    // in a string with a space in it ("in your vault"). Tokens a user never
    // reads have neither: API values (`'vault_busy'`, `'vault'`), route
    // names (`'VaultDashboard'`), paths (`'/vault/agents'`), hint keys.
    name: 'vault outside Settings',
    pattern: /\bV(?:aults?|AULTS?)\b|^(?=[^]*\s)[^]*\bvaults?\b/u,
    scope: [
      'App.tsx',
      'config.ts',
      'index.ts',
      'zodJitless.ts',
      'api',
      'components',
      'constants',
      'context',
      'crypto',
      'design',
      'domain',
      'hooks',
      'navigation',
      'observability',
      'storage',
      'store',
      'test-utils',
      'testing',
      'utils',
      'features/AdminFeedback',
      'features/Auth',
      'features/Course',
      'features/Depth',
      'features/Feedback',
      'features/Habits',
      'features/Invitations',
      'features/Journal',
      'features/Map',
      'features/Practice',
      'features/Program',
      'features/Return',
      'features/Seed',
      'features/Welcome',
    ],
    instead: 'your Corpus',
    allowlist: [],
  },
];

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

const relative = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');

const isDisplayable = (node: ts.Node): node is ts.LiteralLikeNode =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) ||
  ts.isTemplateTail(node) ||
  ts.isJsxText(node);

/** JSX attributes whose value names an element for tests or the platform, never for a reader. */
const NON_COPY_ATTRIBUTES = new Set(['testID', 'nativeID']);

/**
 * Whether a literal is somewhere a user never reads it: a module path
 * (`import x from './FromYourCreekPanel'`), a type (`type T = 'Creek'`), or a
 * test ID.
 */
function isNeverShown(node: ts.Node): boolean {
  const { parent } = node;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  return (
    ts.isJsxAttribute(parent) &&
    ts.isIdentifier(parent.name) &&
    NON_COPY_ATTRIBUTES.has(parent.name.text)
  );
}

/** Every `line: text` in `source` where a user-facing string matches `pattern`. */
export function findForbiddenNames(fileName: string, source: string, pattern: RegExp): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isDisplayable(node) && !isNeverShown(node) && pattern.test(node.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      hits.push(`${String(line + 1)}: ${node.text.replace(/\s+/gu, ' ').trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

const inScope = (file: string, scope: readonly string[]): boolean =>
  scope.some((dir) => dir === '' || file === dir || file.startsWith(`${dir}/`));

const isAllowed = (file: string, hit: string, allowlist: readonly AllowedString[]): boolean =>
  allowlist.some((entry) => entry.file === file && hit.includes(entry.text));

/** Every `file:line: text` under `src` that breaks `rule`, allowlist applied. */
function offendersOf(rule: NamingRule): string[] {
  return walk(SRC).flatMap((full) => {
    const file = relative(full);
    if (!inScope(file, rule.scope)) return [];
    return findForbiddenNames(full, fs.readFileSync(full, 'utf-8'), rule.pattern)
      .filter((hit) => !isAllowed(file, hit, rule.allowlist))
      .map((hit) => `${file}:${hit}`);
  });
}

const CREEK = /Creek/u;

// A deliberately violating fixture: every shape the app's copy takes.
const VIOLATING = `
export const HEADING = 'What Creek has done';
const place = \`a Creek vault before \${day}, so a copy may still be in your Creek vault\`;
const body = 'Removal of earlier ' + 'Creek vault copies is requested too.';
const names = { creek: 'Creek' };
`;

const VIOLATING_JSX = `
export const Notice = () => (
  <View accessibilityLabel="Your Creek vault" accessibilityHint={'Opens Creek'}>
    <Text>
      anyone with enough access at Adepthood or at Creek could read it.
    </Text>
    <TextInput placeholder="Creek Vault address" />
  </View>
);
`;

// Everywhere the internal name stays: nothing here is read by a user.
const INTERNAL_ONLY = `
// What Creek has done, in a comment
/** The writer Creek names for it. */
import FromYourCreekPanel from './FromYourCreekPanel';
export { CreekSection } from './CreekSection';
type Provider = 'Creek' | 'stub';
const VAULT_CREEK_HEADING = 'What has been done with your writing';
const source = 'creek_vault';
function EntryCreekSurface(): null {
  return null;
}
`;

const INTERNAL_ONLY_JSX = `
export const Panel = () => <View testID="Creek-panel" nativeID="CreekRegion" />;
`;

describe('findForbiddenNames', () => {
  it('flags the word in string literals, concatenations, templates and object values', () => {
    expect(findForbiddenNames('fixture.ts', VIOLATING, CREEK)).toEqual([
      '2: What Creek has done',
      '3: a Creek vault before',
      '3: , so a copy may still be in your Creek vault',
      '4: Creek vault copies is requested too.',
      '5: Creek',
    ]);
  });

  it('flags the word in JSX text, accessibility props and placeholders', () => {
    expect(findForbiddenNames('fixture.tsx', VIOLATING_JSX, CREEK)).toEqual([
      '3: Your Creek vault',
      '3: Opens Creek',
      '5: anyone with enough access at Adepthood or at Creek could read it.',
      '7: Creek Vault address',
    ]);
  });

  it('leaves comments, identifiers, import paths, types and API tokens alone', () => {
    expect(findForbiddenNames('fixture.ts', INTERNAL_ONLY, CREEK)).toEqual([]);
  });

  it('leaves test IDs alone', () => {
    expect(findForbiddenNames('fixture.tsx', INTERNAL_ONLY_JSX, CREEK)).toEqual([]);
  });

  it('lets the voice be named in full or in its short form, and nothing less', () => {
    const [, voice] = NAMING_RULES;
    const named = (text: string): string[] =>
      findForbiddenNames('fixture.ts', `const line = '${text}';`, voice!.pattern);

    expect(named('a reflection from your Simulated Higher Self Voice')).toEqual([]);
    expect(named('your Higher Self Voice may draw a few passages')).toEqual([]);
    expect(named('a reflection from your Higher Self can reach')).toHaveLength(1);
    expect(named('Higher Self may draw a few passages')).toHaveLength(1);
  });
});

describe('the allowlist and scope of a naming rule', () => {
  it('scopes a rule to a directory and everything beneath it, and to nothing beside it', () => {
    expect(inScope('features/Settings/vaultCopy.ts', ['features/Settings'])).toBe(true);
    expect(inScope('features/SettingsExtra/copy.ts', ['features/Settings'])).toBe(false);
    expect(inScope('features/Journal/sourceLabel.ts', ['features/Settings'])).toBe(false);
    expect(inScope('api/errorMessages.ts', [''])).toBe(true);
  });

  it('lets through only the string an entry names, in the file it names', () => {
    const allowlist = [{ file: 'a.ts', text: 'Creek Street', why: 'a place name' }];

    expect(isAllowed('a.ts', '3: Meet on Creek Street', allowlist)).toBe(true);
    expect(isAllowed('a.ts', '4: What Creek has done', allowlist)).toBe(false);
    expect(isAllowed('b.ts', '3: Meet on Creek Street', allowlist)).toBe(false);
  });

  it('gives every allowlisted string a reason', () => {
    for (const rule of NAMING_RULES) {
      for (const entry of rule.allowlist) expect(entry.why.trim()).not.toBe('');
    }
  });
});

describe('user-facing copy uses the names in the glossary', () => {
  it('walks the copy modules and the screens, so the sweep cannot pass by reading nothing', () => {
    const files = walk(SRC).map(relative);
    expect(files).toContain('features/Settings/vaultDashboardCopy.ts');
    expect(files).toContain('features/Journal/deleteEntryCopy.ts');
    expect(files).toContain('api/errorMessages.ts');
    expect(files).toContain('features/Settings/PrivateVaultActivationScreen.tsx');
  });

  it.each(NAMING_RULES.map((rule) => [rule.name, rule] as const))(
    'never says "%s" to a user',
    (_name, rule) => {
      const offenders = offendersOf(rule).map((hit) => `${hit}  (say: ${rule.instead})`);
      expect(offenders).toEqual([]);
    },
  );
});
