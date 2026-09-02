/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { MAP_ROWS, STAGE_DISPLAY, TITLE_BY_STAGE } from '../mapLayout';
import { STAGE_COUNT } from '../stageData';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The Map's left column, right column and title watermark restate vocabulary
 * the backend owns: each stage's archetype word, its free-will persona, its
 * aspect of wholeness, its category, and the practice the Practice tab seeds
 * for it. Every one of those is a second copy, and a second copy is only
 * honest while something fails when it drifts from the first.
 *
 * Until now three of them were guarded against tables hand-copied into
 * `mapLayout.test.ts` under a "keep in sync" comment — which is the same
 * duplication one level removed, and is exactly how a stage vocabulary the
 * ontology never had once reached the screen. This reads the curriculum
 * dataset and the practice seeder instead, so the next divergence fails here.
 *
 * What this cannot catch, and must not pretend to: a value that is wrong *in*
 * the canon. Expectations derived from a source stay green when that source
 * is itself mistaken. The drift this fails on is a frontend hardcode moving
 * away from a correct canon.
 *
 * The read goes through `@/testing/backendSource`, which is what makes backend
 * CI run this file on the change that would break it.
 */

/** One APTITUDE stage as the curriculum dataset declares it. */
interface CanonStage {
  stage_number: number;
  /** The stage's archetype word — the Map's `descriptor`. */
  title: string;
  /** The aspect of wholeness — the Map's `arrowLabel` and title watermark. */
  aspect: string;
  /** The band the stage sits in — a `MAP_ROWS` right-column label. */
  category: string;
  /** The egoic character — the Map's `persona`. */
  relationship_to_free_will: string;
}

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

const canonStages = (): CanonStage[] => {
  const dataset = JSON.parse(
    readBackendSource('src', 'curriculum', 'archetypal_wavelength.json'),
  ) as { stages: CanonStage[] };
  return dataset.stages;
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

const CANON_BY_STAGE: ReadonlyMap<number, CanonStage> = new Map(
  canonStages().map((stage) => [stage.stage_number, stage]),
);

const PRACTICE_BY_STAGE = canonPracticeByStage();

/** Stage numbers bottom → top, the order the canon itself is written in. */
const ALL_STAGES = Array.from({ length: STAGE_COUNT }, (_, index) => index + 1);

/** The two stages whose aspect is the title watermark rather than an arrow label. */
const TITLE_STAGES = [9, 10];

/** Locate a stage in the canon, failing loudly rather than as `undefined`. */
const requireCanon = (stageNumber: number): CanonStage => {
  const stage = CANON_BY_STAGE.get(stageNumber);
  if (!stage) {
    throw new Error(`the curriculum dataset has no stage ${stageNumber}`);
  }
  return stage;
};

/** Locate a stage's Map copy, failing loudly rather than as `undefined`. */
const requireDisplay = (stageNumber: number) => {
  const display = STAGE_DISPLAY[stageNumber];
  if (!display) {
    throw new Error(`no STAGE_DISPLAY entry for stage ${stageNumber}`);
  }
  return display;
};

/** The first `count` space-separated words of `text`. */
const leadingWords = (text: string, count: number): string =>
  text.split(' ').slice(0, count).join(' ');

/** The identity key — a stage's own number, not copy, so nothing to join. */
const IDENTITY_FIELD = 'stageNumber';

/** Every `StageDisplay` field this guard joins to a backend source. */
const CANON_JOINED_FIELDS = ['arrowLabel', 'descriptor', 'persona', 'practice'];

/**
 * The two fields deliberately not joined. `mapLayout.ts` states the rationale
 * at its top: these are sampled from the supplied spiral artwork rather than
 * taken from the app-wide swatches, so stage 8 is `#6d92a6` where the Teal
 * token is `#50c9c3` — a difference that is design intent, not drift. The
 * colour axis proper, which is the ontology's primary key, is already joined
 * to the backend by `constants/__tests__/stageOntologyDrift.test.ts`.
 */
const DESIGN_ONLY_FIELDS = ['leftTextColor', 'textColor'];

/** Every stage number paired with the right-column label of the row holding it. */
const ROW_LABEL_BY_STAGE = MAP_ROWS.flatMap((row) =>
  row.stageNumbers.map((stageNumber) => [stageNumber, row.rightLabel] as const),
);

describe('the Map mirrors of the APTITUDE ten', () => {
  // Both of these guard a parse rather than a value. A regex or a JSON shape
  // that silently matched nothing would leave every join below comparing an
  // empty set to an empty set, which passes while checking nothing.
  it('reads the ten APTITUDE stages out of the curriculum dataset', () => {
    expect([...CANON_BY_STAGE.keys()].sort((a, b) => a - b)).toEqual(ALL_STAGES);
  });

  it('reads the ten canonical practice presets out of the seeder', () => {
    expect([...PRACTICE_BY_STAGE.keys()].sort((a, b) => a - b)).toEqual(ALL_STAGES);
  });

  it.each(ALL_STAGES)('stage %i descriptor is the curriculum title', (stageNumber) => {
    expect(requireDisplay(stageNumber).descriptor).toBe(requireCanon(stageNumber).title);
  });

  it.each(ALL_STAGES)(
    'stage %i persona is the curriculum relationship to free will',
    (stageNumber) => {
      expect(requireDisplay(stageNumber).persona).toBe(
        requireCanon(stageNumber).relationship_to_free_will,
      );
    },
  );

  it.each(ALL_STAGES)('stage %i practice is the seeded canonical preset', (stageNumber) => {
    expect(requireDisplay(stageNumber).practice).toBe(PRACTICE_BY_STAGE.get(stageNumber));
  });

  it.each(ROW_LABEL_BY_STAGE)(
    'stage %i sits in the row labelled %s, its curriculum category',
    (stageNumber, rightLabel) => {
      expect(rightLabel).toBe(requireCanon(stageNumber).category);
    },
  );

  it.each(ALL_STAGES.filter((stageNumber) => !TITLE_STAGES.includes(stageNumber)))(
    'stage %i arrow label opens the curriculum aspect',
    (stageNumber) => {
      const { arrowLabel } = requireDisplay(stageNumber);
      const { aspect } = requireCanon(stageNumber);
      // The arrow loop is narrow, so the label is allowed to carry only the
      // opening words of the aspect ('True Self' for 'True Self Connection').
      // Comparing against exactly that prefix keeps the failure diff readable
      // while still rejecting a word the aspect does not begin with.
      expect(arrowLabel).not.toBe('');
      expect(arrowLabel).toBe(leadingWords(aspect, arrowLabel.split(' ').length));
    },
  );

  it.each(TITLE_STAGES)(
    'stage %i spells its aspect as the title watermark and carries no arrow label',
    (stageNumber) => {
      expect(requireDisplay(stageNumber).arrowLabel).toBe('');
      expect(TITLE_BY_STAGE[stageNumber]).toBe(requireCanon(stageNumber).aspect.toUpperCase());
    },
  );

  it.each(ALL_STAGES)('stage %i declares no unjoined copy field', (stageNumber) => {
    // An eighth field added to StageDisplay is red here until it is either
    // joined to a backend source above or named as design-only, so the next
    // hardcoded stage string cannot arrive unguarded.
    expect(Object.keys(requireDisplay(stageNumber)).sort()).toEqual(
      [IDENTITY_FIELD, ...CANON_JOINED_FIELDS, ...DESIGN_ONLY_FIELDS].sort(),
    );
  });
});
