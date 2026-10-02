/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect } from '@jest/globals';
import * as ts from 'typescript';

import { HYPHENATION_BREAKS } from '../../../design/hyphenation';
import { MAP_ROWS, STAGE_DISPLAY } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';

import { readBackendSource } from '@/testing/backendSource';

/**
 * What the Map still keeps of its own, and proof it keeps no stage words (#2666).
 *
 * The Map's stage words -- persona, descriptor, arrow label, watermark and
 * category -- used to be hand-kept copies in `mapLayout.ts`, guarded here
 * against the backend. Since #2666 they are derived from the stage the server
 * served (`stageVocabulary.ts`), and `stageVocabulary.test.ts` runs that
 * derivation over the backend's own sources. What is left in `mapLayout.ts` is
 * each stage's practice line, which mirrors the seeder's canonical preset and is
 * still joined to it here, and the artwork colours, which are design data.
 *
 * Two guards keep the words from coming back. `STAGE_DISPLAY` and `MAP_ROWS`
 * may carry only the fields named here. And no production file may spell a
 * persona, aspect or category of the generated
 * `backend/src/curriculum/stage_correspondence.json` as a string of its own,
 * save the right column's typographic break table.
 *
 * The reads go through `@/testing/backendSource`, which is what makes backend
 * CI run this file on the change that would break it.
 */

/**
 * The `_CANONICAL_PRESETS: list[dict[str, Any]] = [ ... ]` literal, up to the
 * `]` that closes it in column zero.
 *
 * Scoping to that block is load-bearing rather than tidy: `_ALTERNATIVE_PRESETS`
 * further down the same module builds more presets the same way, several of
 * them extra stage-1 entries, so an unscoped sweep collects fourteen names for
 * ten stages and quietly keeps the wrong one. The seeder deliberately excludes
 * the alternatives from `STAGE_TO_PRESET_NAME`, and so does this.
 */
const CANONICAL_PRESETS_BLOCK = /_CANONICAL_PRESETS[^=]*=\s*\[([\s\S]*?)\n\]/;

/** One `_build_preset(8, "Dog Walkin' Shamanism",` opening inside that literal. */
const PRESET_ENTRY = /_build_preset\(\s*(\d+),\s*"((?:[^"\\]|\\.)*)"/g;

/** A regex's first capture group, failing loudly rather than matching nothing. */
const capture = (pattern: RegExp, source: string, what: string): string => {
  const group = pattern.exec(source)?.[1];
  if (group === undefined) {
    throw new Error(`${what} not found; the backend module it mirrors was reshaped.`);
  }
  return group;
};

const canonPracticeByStage = (): ReadonlyMap<number, string> => {
  const block = capture(
    CANONICAL_PRESETS_BLOCK,
    readBackendSource('src', 'seed_practices.py'),
    'the _CANONICAL_PRESETS literal',
  );
  return new Map(
    [...block.matchAll(PRESET_ENTRY)].map(([, stageNumber = '', name = '']) => [
      Number(stageNumber),
      name,
    ]),
  );
};

/** One stage's correspondences as the generated artifact declares them. */
interface CorrespondenceStage {
  stage_number: number;
  category: string;
  aspect: string;
  relationship_to_free_will: string;
}

const CORRESPONDENCES: readonly CorrespondenceStage[] = (
  JSON.parse(readBackendSource('src', 'curriculum', 'stage_correspondence.json')) as {
    stages: CorrespondenceStage[];
  }
).stages;

const PRACTICE_BY_STAGE = canonPracticeByStage();

/** Stage numbers bottom → top, the order the canon itself is written in. */
const ALL_STAGES = Array.from({ length: STAGE_COUNT }, (_, index) => index + 1);

/** The identity key — a stage's own number, not copy, so nothing to join. */
const IDENTITY_FIELD = 'stageNumber';

/** The one `StageDisplay` field joined to a backend source: the seeded practice. */
const CANON_JOINED_FIELDS = ['practice'];

/**
 * The two fields deliberately not joined. `mapLayout.ts` states the rationale
 * at its top: these are sampled from the supplied spiral artwork rather than
 * taken from the app-wide swatches, so stage 8 is `#6d92a6` where the Teal
 * token is `#50c9c3` — a difference that is design intent, not drift. The
 * colour axis proper, which is the ontology's primary key, is already joined
 * to the backend by `constants/__tests__/stageOntologyDrift.test.ts`.
 */
const DESIGN_ONLY_FIELDS = ['leftTextColor', 'textColor'];

/** The longest line a right-column fallback may set; longer categories must break. */
const MAX_RIGHT_LABEL_LINE_LENGTH = 9;

/** Locate a stage's static display, failing loudly rather than as `undefined`. */
const requireDisplay = (stageNumber: number) => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) {
    throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
  }
  return display;
};

// --- The no-hardcoded-vocabulary guard --------------------------------------

const SRC = path.resolve(__dirname, '..', '..', '..');

/** Directories whose files are test support, not production code. */
const IGNORED_DIRS = new Set(['__tests__', '__mocks__', 'testing', 'node_modules']);

/**
 * The one production file allowed to spell a category: the right column's
 * break table, which is typographic design data keyed by the word it breaks.
 * Whitelisted by path, so the same word anywhere else is still caught.
 */
const VOCABULARY_WHITELIST = new Set([path.join(SRC, 'design', 'hyphenation.ts')]);

const isSourceFile = (name: string): boolean =>
  /\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name);

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      found.push(...productionFiles(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Every whole string a file spells: string literals, plain templates and JSX text. */
function spelledStrings(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isJsxText(node)) {
      found.push(node.text.trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every persona, aspect (and its watermark spelling) and category the backend serves. */
const servedVocabulary = (stages: readonly CorrespondenceStage[]): ReadonlySet<string> =>
  new Set(
    stages.flatMap((stage) => [
      stage.relationship_to_free_will,
      stage.aspect,
      stage.aspect.toUpperCase(),
      stage.category,
    ]),
  );

/** `file: word` for every served word a non-whitelisted file spells. */
const hardcodedVocabulary = (
  files: readonly string[],
  vocabulary: ReadonlySet<string>,
  whitelist: ReadonlySet<string>,
): string[] =>
  files
    .filter((file) => !whitelist.has(file))
    .flatMap((file) =>
      spelledStrings(file)
        .filter((text) => vocabulary.has(text))
        .map((text) => `${path.relative(SRC, file)}: ${text}`),
    );

describe('the Map keeps no stage words of its own', () => {
  // Both of these guard a parse rather than a value. A regex or a JSON shape
  // that silently matched nothing would leave every check below comparing an
  // empty set to an empty set, which passes while checking nothing.
  it('reads the ten APTITUDE stages out of the correspondence artifact', () => {
    expect(CORRESPONDENCES.map((stage) => stage.stage_number).sort((a, b) => a - b)).toEqual(
      ALL_STAGES,
    );
  });

  it('reads the ten canonical practice presets out of the seeder', () => {
    expect([...PRACTICE_BY_STAGE.keys()].sort((a, b) => a - b)).toEqual(ALL_STAGES);
  });

  it.each(ALL_STAGES)('stage %i practice is the seeded canonical preset', (stageNumber) => {
    expect(requireDisplay(stageNumber).practice).toBe(PRACTICE_BY_STAGE.get(stageNumber));
  });

  it.each(ALL_STAGES)('stage %i declares no unjoined copy field', (stageNumber) => {
    // A word field added back to StageDisplay is red here until it is either
    // joined to a backend source above or named as design-only, so a hardcoded
    // stage string cannot return unguarded.
    expect(Object.keys(requireDisplay(stageNumber)).sort()).toEqual(
      [IDENTITY_FIELD, ...CANON_JOINED_FIELDS, ...DESIGN_ONLY_FIELDS].sort(),
    );
  });

  it('lays out the ten stages in six rows that carry no label of their own', () => {
    for (const row of MAP_ROWS) {
      expect(Object.keys(row)).toEqual(['stageNumbers']);
    }
    expect(MAP_ROWS.flatMap((row) => row.stageNumbers).sort((a, b) => a - b)).toEqual(ALL_STAGES);
  });

  it('can break every served category that is too long for one right-column line', () => {
    const unbroken = CORRESPONDENCES.map((stage) => stage.category).filter(
      (category) =>
        category.length > MAX_RIGHT_LABEL_LINE_LENGTH && !HYPHENATION_BREAKS.has(category),
    );
    expect(unbroken).toEqual([]);
    for (const lines of HYPHENATION_BREAKS.values()) {
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(MAX_RIGHT_LABEL_LINE_LENGTH);
      }
    }
  });

  it('finds no persona, aspect or category spelled in production code', () => {
    const files = productionFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    expect(
      hardcodedVocabulary(files, servedVocabulary(CORRESPONDENCES), VOCABULARY_WHITELIST),
    ).toEqual([]);
  });

  it('would catch a served word spelled outside the whitelist, and only there', () => {
    const hyphenation = path.join(SRC, 'design', 'hyphenation.ts');
    const vocabulary = servedVocabulary(CORRESPONDENCES);
    // The break table spells three categories: caught once the path is not
    // whitelisted, ignored while it is.
    expect(hardcodedVocabulary([hyphenation], vocabulary, new Set()).length).toBeGreaterThan(0);
    expect(hardcodedVocabulary([hyphenation], vocabulary, VOCABULARY_WHITELIST)).toEqual([]);
    expect(vocabulary.has('UNITY')).toBe(true);
    expect(vocabulary.has('Victim')).toBe(true);
  });
});
