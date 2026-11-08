import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

/**
 * One seam moves the program anchor (#3097).
 *
 * The server owns the start date, and the client store is its mirror. If any
 * screen could call the PUT, or write the server-sourced anchor, on its own,
 * the Course, Journal, Practice, Map and habit reveal would drift apart again --
 * the two-anchor defect this issue closed. Only ``src/features/Program`` may do
 * either; the habit-derived fallback in ``habitManager`` is the one other
 * writer of the store's anchor, and only for the offline / no-server-row case.
 *
 * The scan matches any REFERENCE to a named writer, not one spelling of a call,
 * so an aliased client (``stagesApi.setProgramStart``), a selector-bound or
 * destructured setter (``useProgramStore((s) => s.setProgramStartDay)``,
 * ``const { hydrateProgramStartDate: w } = useProgramStore.getState()``) are
 * caught (#3097 review). The store's raw ``setState`` has no name of its own,
 * so it is matched on every name the file binds the store to: the import, an
 * ``as`` alias, or a ``const`` that takes the store itself (#3097 re-review).
 * Comments are stripped first, so naming a writer in prose is not a write.
 *
 * What it does not claim: a writer reached through a computed key
 * (``stages['setProgram' + 'Start']``) or a store handed in from another
 * module under a name this file never binds is beyond a text scan.
 */

const SRC = path.resolve(__dirname, '..', '..', '..');
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

const PROGRAM_DIR = path.join('features', 'Program');
const STORE_FILE = path.join('store', 'useProgramStore.ts');
const API_CLIENT_FILE = path.join('api', 'index.ts');
const HABIT_FALLBACK_FILE = path.join('features', 'Habits', 'services', 'habitManager.ts');

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

/** Drop block and line comments; a ``//`` after a colon (a URL) is kept. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

const inProgram = (file: string): boolean => file.startsWith(PROGRAM_DIR + path.sep);

interface WriterRule {
  readonly name: string;
  /** Whether comment-free ``code`` references the writer. */
  readonly matches: (_code: string) => boolean;
  /** Files (relative to ``src``) that may reference the writer. */
  readonly allowed: (_file: string) => boolean;
}

const STORE_NAME = 'useProgramStore';
/** ``import { useProgramStore as ps }`` -- the alias, when there is one. */
const STORE_IMPORT_RE = /\buseProgramStore\b(?:\s+as\s+([A-Za-z_$][\w$]*))?/gu;
/** ``const ps = useProgramStore;`` -- the store itself, not a selector call on it. */
const STORE_BINDING_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useProgramStore\b(?!\s*[(.])/gu;

/** Every name ``code`` can reach the program store by. */
const storeNames = (code: string): Set<string> => {
  const names = new Set<string>();
  if (!code.includes(STORE_NAME)) return names;
  names.add(STORE_NAME);
  for (const match of code.matchAll(STORE_IMPORT_RE)) if (match[1]) names.add(match[1]);
  for (const match of code.matchAll(STORE_BINDING_RE)) if (match[1]) names.add(match[1]);
  return names;
};

const referencesRawStoreWrite = (code: string): boolean =>
  [...storeNames(code)].some((name) =>
    new RegExp(`(?<![\\w$])${name.replace(/\$/gu, '\\$')}\\.setState\\b`, 'u').test(code),
  );

const pattern =
  (re: RegExp) =>
  (code: string): boolean =>
    re.test(code);

const RULES: readonly WriterRule[] = [
  {
    name: 'PUT /stages/program-calendar',
    // The client method, under any receiver or alias; not the store setters.
    matches: pattern(/\bsetProgramStart\b(?!Date|Day)/u),
    allowed: (file) => inProgram(file) || file === API_CLIENT_FILE,
  },
  {
    name: 'server anchor adoption',
    matches: pattern(/\badoptServerProgramStart\b/u),
    allowed: (file) => inProgram(file) || file === STORE_FILE,
  },
  {
    name: 'client-side anchor write',
    matches: pattern(/\bsetProgramStart(?:Date|Day)\b/u),
    allowed: (file) => file === HABIT_FALLBACK_FILE || file === STORE_FILE,
  },
  {
    // The cold-start restore; only the store's own hydrate hook may run it.
    name: 'cached anchor restore',
    matches: pattern(/\bhydrateProgramStartDate\b/u),
    allowed: (file) => file === STORE_FILE,
  },
  {
    name: 'raw program store write',
    matches: referencesRawStoreWrite,
    allowed: (file) => file === STORE_FILE,
  },
];

/** ``rule: file`` for every reference a rule does not allow. */
const violationsIn = (sources: ReadonlyArray<readonly [string, string]>): string[] =>
  sources.flatMap(([file, source]) => {
    const code = withoutComments(source);
    return RULES.filter((rule) => !rule.allowed(file) && rule.matches(code)).map(
      (rule) => `${rule.name}: ${file}`,
    );
  });

const productionSources = (): Array<readonly [string, string]> =>
  walk(SRC).map((file) => [path.relative(SRC, file), fs.readFileSync(file, 'utf8')] as const);

describe('the program anchor has one writer (#3097)', () => {
  it('no production file outside the seam references a writer', () => {
    expect(violationsIn(productionSources())).toEqual([]);
  });

  it('the habit-derived fallback is the only client-side anchor writer', () => {
    const writers = productionSources()
      .filter(([file]) => file !== STORE_FILE)
      .filter(([, source]) => /\bsetProgramStart(?:Date|Day)\b/u.test(withoutComments(source)))
      .map(([file]) => file);

    expect(writers).toEqual([HABIT_FALLBACK_FILE]);
  });
});

describe('the scan catches every spelling of a second writer', () => {
  const MAP_SERVICE = path.join('features', 'Map', 'services', 'stageService.ts');
  const MAP_SCREEN = path.join('features', 'Map', 'MapScreen.tsx');

  it.each<[string, string, string]>([
    [
      'an aliased API client',
      MAP_SERVICE,
      "import { stages as stagesApi } from '../../../api';\nvoid stagesApi.setProgramStart(day);",
    ],
    [
      'a selector-bound setter',
      MAP_SCREEN,
      'const setDay = useProgramStore((s) => s.setProgramStartDay);\nsetDay(day);',
    ],
    [
      'a destructured getState',
      MAP_SCREEN,
      'const { adoptServerProgramStart } = useProgramStore.getState();\nadoptServerProgramStart(x);',
    ],
    [
      'a raw setState',
      MAP_SCREEN,
      "useProgramStore.setState({ programStartDay: day, anchorSource: 'server' });",
    ],
    ['a literal client call', MAP_SERVICE, 'await stages.setProgramStart(day, token);'],
    [
      "an aliased store's setState",
      MAP_SERVICE,
      "import { useProgramStore as ps } from '../../../store/useProgramStore';\n" +
        "ps.setState({ programStartDay: day, anchorSource: 'server' });",
    ],
    [
      "a store bound to a local name's setState",
      MAP_SCREEN,
      'const program = useProgramStore;\nprogram.setState({ programStartDay: day });',
    ],
    [
      'a destructured, renamed hydrate',
      MAP_SERVICE,
      'const { hydrateProgramStartDate: w } = useProgramStore.getState();\nw(date);',
    ],
    [
      'a selector-bound hydrate',
      MAP_SCREEN,
      'const hydrate = useProgramStore((s) => s.hydrateProgramStartDate);\nhydrate(date);',
    ],
  ])('flags %s', (_shape, file, source) => {
    expect(violationsIn([[file, source]])).not.toEqual([]);
  });

  it('does not flag a writer named only in a comment', () => {
    const source = '// adoptServerProgramStart is the seam\n/** setProgramStartDay(...) */\n';

    expect(violationsIn([[MAP_SCREEN, source]])).toEqual([]);
  });

  it("does not flag a component's own React setState beside a program store read", () => {
    const source =
      "import { useProgramStore } from '../../store/useProgramStore';\n" +
      'const anchor = useProgramStore((s) => s.programStartDate);\n' +
      'const [state, setState] = useState(0);\nsetState(1);';

    expect(violationsIn([[MAP_SCREEN, source]])).toEqual([]);
  });

  it('lets the store restore its own cached anchor', () => {
    const source = 'const hydrate = useProgramStore((s) => s.hydrateProgramStartDate);';

    expect(violationsIn([[STORE_FILE, source]])).toEqual([]);
  });

  it('lets the seam itself through', () => {
    const source = 'await stages.setProgramStart(day, token);';

    expect(violationsIn([[path.join(PROGRAM_DIR, 'programAnchor.ts'), source]])).toEqual([]);
  });
});
