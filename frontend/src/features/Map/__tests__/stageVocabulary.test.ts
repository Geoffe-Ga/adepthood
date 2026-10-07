/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { mockMakeStage } from './mapTestHarness';
import {
  CANON_STAGE_OVERRIDES,
  GOLDEN_ROWS,
  GOLDEN_STAGE_NUMBERS,
  goldenStage,
} from './stageVocabularyGolden';

import { hyphenate } from '@/design/hyphenation';
import type { StageData } from '@/features/Map/stageData';
import {
  deriveStageVocabulary,
  isTitleStage,
  mapWatermarkLines,
  rowCategory,
  stageArrowLabel,
  stageDescriptor,
  stageFallbackName,
  stageHeadline,
  stagePersona,
  stageWatermark,
  TITLE_STAGE_NUMBERS,
} from '@/features/Map/stageVocabulary';
import { readBackendSource } from '@/testing/backendSource';

/**
 * The Map's stage vocabulary derives from the stage the server served (#2666).
 *
 * Each rule is pinned with exact values, and then the whole derivation is run
 * over the backend's own sources -- the generated `stage_correspondence.json`
 * for category, aspect and persona, the curriculum dataset for the title -- and
 * must reproduce the golden the Map rendered from its old static mirror. The
 * backend read goes through `@/testing/backendSource`, so backend CI runs this
 * file on any change to those sources.
 */

/** A stage with only the vocabulary fields that matter set, by name. */
const stage = (stageNumber: number, fields: Partial<StageData> = {}): StageData =>
  mockMakeStage(stageNumber, fields);

describe('stagePersona and stageDescriptor', () => {
  it('reads the persona from relationshipToFreeWill and nothing else', () => {
    const s = stage(3, {
      relationshipToFreeWill: 'Sentinel Persona',
      title: 'Sentinel Title',
      growingUpStage: 'Sentinel Growing',
    });
    expect(stagePersona(s)).toBe('Sentinel Persona');
  });

  it('reads the descriptor from the title, never the Growing Up stage', () => {
    // Stage 2 is where the two differ: the course calls it Magick, the Growing
    // Up column Magic. The Map has always shown the title.
    const s = stage(2, { title: 'Magick', growingUpStage: 'Magic' });
    expect(stageDescriptor(s)).toBe('Magick');
  });
});

describe('stageArrowLabel', () => {
  it.each([
    [1, 'Agency', 'Agency'],
    [3, 'Self-Love', 'Self-Love'],
    [4, 'Community Love', 'Community'],
    [5, 'Intellectual Understanding', 'Intellectual'],
    [8, 'True Self Connection', 'True Self'],
  ])('stage %i reads aspect %s as %s on its arrow', (n, aspect, expected) => {
    expect(stageArrowLabel(stage(n, { aspect }))).toBe(expected);
  });

  it.each([9, 10])('title stage %i carries no arrow label', (n) => {
    expect(stageArrowLabel(stage(n, { aspect: 'Unity Of Everything' }))).toBe('');
  });

  it('collapses extra spaces rather than counting them as words', () => {
    expect(stageArrowLabel(stage(4, { aspect: '  Community   Love ' }))).toBe('Community');
    expect(stageArrowLabel(stage(1, { aspect: ' Agency ' }))).toBe('Agency');
  });

  it('reads an empty aspect as an empty label', () => {
    expect(stageArrowLabel(stage(2, { aspect: '' }))).toBe('');
  });
});

describe('stageWatermark and the title stages', () => {
  it('names stages 10 and 9 as the title stages, top line first', () => {
    expect(TITLE_STAGE_NUMBERS).toEqual([10, 9]);
  });

  it.each([
    [9, true],
    [10, true],
    [8, false],
    [1, false],
    [11, false],
  ])('isTitleStage(%i) is %s', (n, expected) => {
    expect(isTitleStage(n)).toBe(expected);
  });

  it('upper-cases a title stage aspect into its watermark', () => {
    expect(stageWatermark(stage(9, { aspect: 'Unity' }))).toBe('UNITY');
    expect(stageWatermark(stage(10, { aspect: 'Stillness' }))).toBe('STILLNESS');
  });

  it('gives every other stage no watermark', () => {
    for (let n = 1; n <= 8; n += 1) {
      expect(stageWatermark(stage(n, { aspect: 'Agency' }))).toBeUndefined();
    }
  });

  it('heads a stage with its arrow label, or with its watermark on a title stage', () => {
    expect(stageHeadline(stage(8, { aspect: 'True Self Connection' }))).toBe('True Self');
    expect(stageHeadline(stage(10, { aspect: 'Emptiness' }))).toBe('EMPTINESS');
    expect(stageHeadline(stage(2, { aspect: '' }))).toBe('');
  });

  it('lists the watermarks the loaded title stages carry, top line first', () => {
    const lookup = { 9: stage(9, { aspect: 'Unity' }), 10: stage(10, { aspect: 'Emptiness' }) };
    expect(mapWatermarkLines(lookup)).toEqual(['EMPTINESS', 'UNITY']);
    expect(mapWatermarkLines({ 9: lookup[9] })).toEqual(['UNITY']);
    expect(mapWatermarkLines({})).toEqual([]);
  });
});

describe('rowCategory', () => {
  it("reads a row's category from its first loaded stage", () => {
    const lookup = { 8: stage(8, { category: 'Wisdom' }), 7: stage(7, { category: 'Other' }) };
    expect(rowCategory([8, 7], lookup)).toBe('Wisdom');
    expect(rowCategory([8, 7], { 7: lookup[7] })).toBe('Other');
  });

  it('gives a row with no loaded stage no category', () => {
    expect(rowCategory([8, 7], {})).toBeUndefined();
  });
});

describe('stageFallbackName', () => {
  it('names a stage by its colour when nothing has loaded', () => {
    expect(stageFallbackName(1)).toBe('Beige');
    expect(stageFallbackName(2)).toBe('Purple');
    expect(stageFallbackName(10)).toBe('Clear Light');
  });

  it('never returns an empty name, even off the end of the colour list', () => {
    expect(stageFallbackName(11)).toBe('Stage 11');
  });
});

// --- The whole derivation, from the backend's own words ---------------------

/** The artifact fields the Map vocabulary derives from. */
interface CorrespondenceStage {
  stage_number: number;
  category: string;
  aspect: string;
  relationship_to_free_will: string;
}

/** The curriculum dataset field the descriptor derives from. */
interface CurriculumTitle {
  stage_number: number;
  title: string;
}

const readStages = <T>(file: string): T[] =>
  (JSON.parse(readBackendSource('src', 'curriculum', file)) as { stages: T[] }).stages;

/** Ten stages built from the backend sources exactly as the seeder joins them. */
const backendStages = (): Record<number, StageData> => {
  const titles = new Map(
    readStages<CurriculumTitle>('archetypal_wavelength.json').map((s) => [s.stage_number, s.title]),
  );
  const result: Record<number, StageData> = {};
  for (const s of readStages<CorrespondenceStage>('stage_correspondence.json')) {
    const title = titles.get(s.stage_number);
    if (title === undefined) throw new Error(`no curriculum title for stage ${s.stage_number}`);
    result[s.stage_number] = mockMakeStage(s.stage_number, {
      title,
      category: s.category,
      aspect: s.aspect,
      relationshipToFreeWill: s.relationship_to_free_will,
    });
  }
  return result;
};

describe('the derivation over the backend sources', () => {
  const lookup = backendStages();

  it('reads all ten stages out of the backend', () => {
    expect(
      Object.keys(lookup)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(GOLDEN_STAGE_NUMBERS);
  });

  it('serves the golden fixture exactly what the backend seeds', () => {
    for (const n of GOLDEN_STAGE_NUMBERS) {
      const s = lookup[n];
      expect(
        s && {
          title: s.title,
          category: s.category,
          aspect: s.aspect,
          relationshipToFreeWill: s.relationshipToFreeWill,
        },
      ).toEqual(CANON_STAGE_OVERRIDES[n]);
    }
  });

  it.each(GOLDEN_STAGE_NUMBERS)('derives the golden vocabulary for stage %i', (n) => {
    const s = lookup[n];
    if (s === undefined) throw new Error(`no backend stage ${n}`);
    const { persona, descriptor, arrowLabel, watermark, category } = goldenStage(n);
    expect(deriveStageVocabulary(s)).toEqual({
      persona,
      descriptor,
      arrowLabel,
      watermark,
      category,
    });
  });

  it('derives the golden rows and their fallback lines', () => {
    for (const row of GOLDEN_ROWS) {
      const category = rowCategory(row.stageNumbers, lookup);
      expect(category).toBe(row.category);
      expect(hyphenate(category ?? '')).toEqual(row.fallbackLines);
    }
  });

  it('derives the golden watermarks', () => {
    expect(mapWatermarkLines(lookup)).toEqual(['EMPTINESS', 'UNITY']);
  });
});
