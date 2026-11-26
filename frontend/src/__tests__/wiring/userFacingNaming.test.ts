import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

/**
 * The app's own names for things, held against the copy it ships (epic #3802).
 *
 * "Creek" is the internal name of the software behind a person's body of
 * writing. Nobody using the app was ever told it, so no screen, error message
 * or accessibility label may say it, with one exception: the three sentences
 * that disclose who can read a managed Corpus name every party, Creek among
 * them (#3828). Everywhere else the app says **your Corpus**, and what
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
 * directories it is forbidden in, and the strings allowed to keep it. Every
 * row covers all of `src` today, standalone "vault" included (#3804, #3805).
 * A sweep that retires another word may start with a row scoped to the
 * directories it has finished, and widens the scope as it goes.
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

/** Why the custody disclosures, and nothing else, say "Creek" (#3828). */
const CUSTODY_NAMES_EVERY_PARTY =
  'custody disclosure names every party (owner decision 2026-11-26)';

export const NAMING_RULES: readonly NamingRule[] = [
  {
    name: 'Creek',
    pattern: /Creek/u,
    scope: [''],
    instead: 'your Corpus',
    // The three sentences that say who can read a managed Corpus, and no
    // other string (#3828). Each entry is the whole clause naming the parties.
    allowlist: [
      {
        file: 'features/Settings/PrivateVaultActivationScreen.tsx',
        text: 'so Fly, and anyone with enough access at Adepthood or at Creek (the software behind it), could read what is stored there.',
        why: CUSTODY_NAMES_EVERY_PARTY,
      },
      {
        file: 'features/Settings/PrivateVaultActivationScreen.tsx',
        text: 'Fly, and people with enough access at Adepthood or at Creek (the software behind it), can read what is stored there.',
        why: CUSTODY_NAMES_EVERY_PARTY,
      },
      {
        file: 'features/Settings/VaultSettingsScreen.tsx',
        text: 'Fly, the people who run Adepthood, and the people at Creek (the software behind it) can read what is stored there;',
        why: CUSTODY_NAMES_EVERY_PARTY,
      },
    ],
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
    // Standalone "vault", everywhere under `src` (#3804, #3805): the word as a
    // word, lower-case, capitalised or shouted, singular or plural, wherever
    // something stands beside it ("Your vault", "vault's", "managed vaults",
    // "https://your-vault.example"), and a capitalised label that is nothing
    // else ("Vault"). What keeps the word is what no user reads: a token that
    // only starts with it (`vault-agent-row-`, `vault:read`, `vault_busy`,
    // `VaultSettings`), a lower-case token that is nothing else (`'vault'`,
    // the export format), and a segment of an API path (`/vault/agents`,
    // `/users/me/export/vault`), which is why a slash on either side lets it
    // through.
    name: 'vault',
    pattern:
      /(?<=[^\w/])(?:[Vv]aults?|VAULTS?)(?![\w:/-])|(?<![\w/])(?:[Vv]aults?|VAULTS?)(?=[^\w:/-])|^(?:Vaults?|VAULTS?)$/u,
    scope: [''],
    instead: 'your Corpus',
    allowlist: [
      {
        file: 'features/Settings/saveDataExport.ts',
        text: 'adepthood-vault',
        why: 'the name of the export file a person downloads, which the server and docs/your-data.md spell the same way; renaming it is not part of #3802',
      },
      {
        file: 'features/Settings/vaultLinks.ts',
        text: 'running-your-own-vault',
        why: 'the anchor of a heading in docs/your-data.md, opened as a link and never shown',
      },
    ],
  },
  {
    // "Corpus" always means the writing (#3827). A word straight before it
    // that counts it, points at it, or connects it makes it a place instead:
    // "a Corpus you run", "this Corpus", "No Corpus connected", "a managed
    // Corpus", "Reconnect Corpus". The place is "where your Corpus is kept",
    // or plain "storage" where it needs a noun.
    //
    // The server's sentences are held to the same pattern, written out again in
    // backend/tests/services/test_corpus_place_copy.py. Change the two together.
    name: 'Corpus as a place',
    pattern:
      /\b(?:an?|another|this|that|the|no|new|fresh|previous|managed|connected|isolated|(?:re|dis)?connect|create|replace) Corpus\b/iu,
    scope: [''],
    instead: 'where your Corpus is kept, or "storage"',
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

const VAULT_RULE_NAME = 'vault';
const CREEK_RULE_NAME = 'Creek';

function ruleNamed(name: string): NamingRule {
  const rule = NAMING_RULES.find((candidate) => candidate.name === name);
  if (!rule) throw new Error(`NAMING_RULES has no "${name}" row any more.`);
  return rule;
}

const vaultRule = (): NamingRule => ruleNamed(VAULT_RULE_NAME);
const creekRule = (): NamingRule => ruleNamed(CREEK_RULE_NAME);

// Every shape the app's copy took when it said "vault".
const VAULT_VIOLATING = `
export const VAULT_DASHBOARD_TITLE = 'Your vault';
export const VAULT_NONE_CONNECTED = 'No vault connected yet.';
export const VAULT_SHAPE_HEADING = "Your vault's shape";
const opening = 'Managed vaults are opening gradually';
const waiting = 'Waiting for room to open up for your vault…';
const landed = \`\${count} items from your vault\`;
const paid = \`Paid by your own \${vendor} key, through your vault\`;
const body = 'Removal is requested; ' + 'they may remain until the vault confirms.';
const labels = { reconnect: 'Reconnect vault', heading: 'Vault settings', one: 'Vault' };
const shout = 'VAULT';
const placeholder = 'https://your-vault.example';
const download = 'adepthood-vault';
`;

const VAULT_VIOLATING_JSX = `
export const Offer = () => (
  <View accessibilityLabel="Continue managed vault setup">
    <Text>
      Readings your vault answers use BotMason credits.
    </Text>
    <TextInput placeholder="Private vault address" />
  </View>
);
`;

// Everywhere "vault" stays: nothing here is read by a user.
const VAULT_INTERNAL_ONLY = `
// A vault is an optional depth, in a comment.
import { vault } from '@/api';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';
type ExportFormat = 'json' | 'markdown' | 'vault';
const run = () => exportAs('vault');
const destination = z.enum(['vault', 'corpus']);
const scopes = new Map([['vault:read', 'Read and search your Open and Personal writing']]);
const refusals = { vault_url_malformed: VAULT_ADDRESS_INCOMPLETE };
const status = 'vault_busy';
const location = 'connected_vault';
const source = 'creek_vault';
const hint = 'vaultWithdrawalPending';
navigation.navigate(first ? 'VaultDashboard' : 'VaultActivation');
const landed = receipt.vault_status === 'accepted';
const agents = '/vault/agents';
const agent = \`/vault/agents/\${id}\`;
const exported = '/users/me/export/vault';
const VAULT_FIRST_CTA = 'Give your writing a place to live';
`;

const VAULT_INTERNAL_ONLY_JSX = `
export const Row = ({ id }) => (
  <View testID={\`vault-agent-row-\${id}\`}>
    <Pressable testID="seed-vault-invitation-link" />
  </View>
);
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

describe('the "vault" rule', () => {
  const hits = (fileName: string, source: string): string[] =>
    findForbiddenNames(fileName, source, vaultRule().pattern);

  it('flags the word in headings, sentences, plurals, possessives, templates, bare labels and hyphenated names', () => {
    expect(hits('fixture.ts', VAULT_VIOLATING)).toEqual([
      '2: Your vault',
      '3: No vault connected yet.',
      "4: Your vault's shape",
      '5: Managed vaults are opening gradually',
      '6: Waiting for room to open up for your vault…',
      '7: items from your vault',
      '8: key, through your vault',
      '9: they may remain until the vault confirms.',
      '10: Reconnect vault',
      '10: Vault settings',
      '10: Vault',
      '11: VAULT',
      '12: https://your-vault.example',
      '13: adepthood-vault',
    ]);
  });

  it('flags the word in JSX text, accessibility labels and placeholders', () => {
    expect(hits('fixture.tsx', VAULT_VIOLATING_JSX)).toEqual([
      '3: Continue managed vault setup',
      '5: Readings your vault answers use BotMason credits.',
      '7: Private vault address',
    ]);
  });

  it('leaves comments, identifiers, routes, scopes, API values and API paths alone', () => {
    expect(hits('fixture.ts', VAULT_INTERNAL_ONLY)).toEqual([]);
  });

  it('leaves test IDs alone, templated or plain', () => {
    expect(hits('fixture.tsx', VAULT_INTERNAL_ONLY_JSX)).toEqual([]);
  });

  it('is one rule over all of src, and keeps only the download name and a link anchor', () => {
    expect(NAMING_RULES.filter((rule) => /vault/iu.test(rule.name))).toHaveLength(1);
    expect(vaultRule().scope).toEqual(['']);
    expect(vaultRule().allowlist.map((entry) => entry.text)).toEqual([
      'adepthood-vault',
      'running-your-own-vault',
    ]);
  });
});

describe('the "Corpus as a place" rule', () => {
  const placed = (text: string): string[] =>
    findForbiddenNames(
      'fixture.ts',
      `const line = ${JSON.stringify(text)};`,
      ruleNamed('Corpus as a place').pattern,
    );

  it.each([
    'No Corpus was connected, so nothing of yours is held outside Adepthood.',
    'Reconnect Corpus',
    'A connected Corpus reads richer formats for you.',
    'Advanced: connect a Corpus you run yourself',
    'Create managed Corpus',
    'Replace this Corpus?',
    'Reconnect that Corpus in Settings to allow retry.',
    'It may remain in the Corpus you disconnected.',
  ])('flags %j', (text) => {
    expect(placed(text)).toHaveLength(1);
  });

  it.each([
    'In your Corpus. It will show up in reflections from here on.',
    'fills as your Corpus learns how you write',
    'Readings your Corpus writes use BotMason credits.',
    'Nothing is connected to keep your Corpus.',
    "Where your Corpus is kept didn't answer.",
    'With Corpus sorting enabled, every eligible page joins your private Corpus.',
    'Corpus upload',
  ])('leaves %j alone', (text) => {
    expect(placed(text)).toEqual([]);
  });

  it('covers all of src and allows nothing', () => {
    expect(ruleNamed('Corpus as a place').scope).toEqual(['']);
    expect(ruleNamed('Corpus as a place').allowlist).toEqual([]);
  });
});

describe('the "Creek" rule', () => {
  it('is one rule over all of src, and keeps only the three custody disclosures', () => {
    expect(NAMING_RULES.filter((rule) => /creek/iu.test(rule.name))).toHaveLength(1);
    expect(creekRule().scope).toEqual(['']);
    expect(creekRule().allowlist.map(({ file, text }) => ({ file, text }))).toEqual([
      {
        file: 'features/Settings/PrivateVaultActivationScreen.tsx',
        text: 'so Fly, and anyone with enough access at Adepthood or at Creek (the software behind it), could read what is stored there.',
      },
      {
        file: 'features/Settings/PrivateVaultActivationScreen.tsx',
        text: 'Fly, and people with enough access at Adepthood or at Creek (the software behind it), can read what is stored there.',
      },
      {
        file: 'features/Settings/VaultSettingsScreen.tsx',
        text: 'Fly, the people who run Adepthood, and the people at Creek (the software behind it) can read what is stored there;',
      },
    ]);
  });

  it('gives each of the three the owner decision as its reason', () => {
    expect(creekRule().allowlist.map((entry) => entry.why)).toEqual([
      'custody disclosure names every party (owner decision 2026-11-26)',
      'custody disclosure names every party (owner decision 2026-11-26)',
      'custody disclosure names every party (owner decision 2026-11-26)',
    ]);
  });

  it('glosses the name where it is said, and says it once per sentence', () => {
    for (const entry of creekRule().allowlist) {
      expect(entry.text).toContain('Creek (the software behind it)');
      expect(entry.text.match(/Creek/gu)).toHaveLength(1);
    }
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

  it('keeps no entry for a string the app no longer says', () => {
    const stale = NAMING_RULES.flatMap((rule) =>
      rule.allowlist
        .filter((entry) => {
          const source = fs.readFileSync(path.join(SRC, entry.file), 'utf-8');
          const hits = findForbiddenNames(entry.file, source, rule.pattern);
          return !hits.some((hit) => hit.includes(entry.text));
        })
        .map((entry) => `${rule.name}: ${entry.file}: ${entry.text}`),
    );

    expect(stale).toEqual([]);
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
