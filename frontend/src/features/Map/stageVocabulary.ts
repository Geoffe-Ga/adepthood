/**
 * The Map's stage vocabulary, derived from the stage the server served (#2666).
 *
 * Every word the Map shows for a stage -- the persona and descriptor in the left
 * column, the short label on the arrow loop, the UNITY / EMPTINESS watermark
 * over the two title stages, and the category in the right column -- used to be
 * a hand-kept copy in ``mapLayout.ts``. They are now read from ``StageData``,
 * which ``stageService`` fills from ``GET /stages``, so a correction to the
 * ``coursestage`` table reaches the screen without a frontend change. Pure
 * functions; no React.
 */

import { STAGE_ORDER } from '../../design/tokens';

import type { StageData } from './stageData';

/** The stages whose aspect is a title watermark rather than an arrow label, top line first. */
export const TITLE_STAGE_NUMBERS: readonly number[] = [10, 9];

/** An aspect needs at least this many words before the arrow label shortens it. */
export const MIN_ASPECT_WORDS_TO_SHORTEN = 2;

/** How many trailing words a shortened arrow label drops ('True Self Connection' -> 'True Self'). */
export const ASPECT_WORDS_DROPPED_ON_ARROW = 1;

/** What separates the words of an aspect. */
const ASPECT_WORD_SEPARATOR = ' ';

/** The fields of a served stage the vocabulary reads. */
export type VocabularySource = Pick<
  StageData,
  'stageNumber' | 'title' | 'category' | 'aspect' | 'relationshipToFreeWill'
>;

/** Every Map word for one stage. */
export interface StageVocabulary {
  /** The stage's free-will archetype, the left column's first line. */
  persona: string;
  /** The stage's name, the left column's second line. */
  descriptor: string;
  /** The arrow-loop word; '' for a title stage. */
  arrowLabel: string;
  /** The title watermark of a title stage; undefined below them. */
  watermark: string | undefined;
  /** The right-column category of the row the stage sits in. */
  category: string;
}

/** Loaded stages by number; a stage not yet served is absent. */
export type StageVocabularyLookup = Readonly<Record<number, VocabularySource | undefined>>;

/** Whether a stage carries the title watermark instead of an arrow label. */
export const isTitleStage = (stageNumber: number): boolean =>
  TITLE_STAGE_NUMBERS.includes(stageNumber);

/** The stage's free-will archetype. */
export const stagePersona = (stage: VocabularySource): string => stage.relationshipToFreeWill;

/** The stage's name: its curriculum title, never its Growing Up stage. */
export const stageDescriptor = (stage: VocabularySource): string => stage.title;

/** The stage's category, which names the right-column row it sits in. */
export const stageCategory = (stage: VocabularySource): string => stage.category;

/**
 * The word on the stage's arrow loop: its aspect, less its last word when it has
 * several ('Community Love' -> 'Community'), whole when it is one word, and ''
 * on a title stage, whose aspect is the watermark instead.
 */
export const stageArrowLabel = (stage: VocabularySource): string => {
  if (isTitleStage(stage.stageNumber)) return '';
  const words = stage.aspect.split(ASPECT_WORD_SEPARATOR).filter((word) => word.length > 0);
  const kept =
    words.length >= MIN_ASPECT_WORDS_TO_SHORTEN
      ? words.slice(0, words.length - ASPECT_WORDS_DROPPED_ON_ARROW)
      : words;
  return kept.join(ASPECT_WORD_SEPARATOR);
};

/** A title stage's watermark, its aspect in capitals; undefined below the title stages. */
export const stageWatermark = (stage: VocabularySource): string | undefined =>
  isTitleStage(stage.stageNumber) ? stage.aspect.toUpperCase() : undefined;

/** The word a stage is headed by: its arrow label, or its watermark on a title stage. */
export const stageHeadline = (stage: VocabularySource): string =>
  stageArrowLabel(stage) || stageWatermark(stage) || '';

/** All the Map words for one served stage. */
export const deriveStageVocabulary = (stage: VocabularySource): StageVocabulary => ({
  persona: stagePersona(stage),
  descriptor: stageDescriptor(stage),
  arrowLabel: stageArrowLabel(stage),
  watermark: stageWatermark(stage),
  category: stageCategory(stage),
});

/** A row's category, read from the first of its stages that has loaded. */
export const rowCategory = (
  stageNumbers: readonly number[],
  lookup: StageVocabularyLookup,
): string | undefined => {
  const loaded = stageNumbers.map((n) => lookup[n]).find((stage) => stage !== undefined);
  return loaded === undefined ? undefined : stageCategory(loaded);
};

/** The watermarks the loaded title stages carry, top line first. */
export const mapWatermarkLines = (lookup: StageVocabularyLookup): string[] =>
  TITLE_STAGE_NUMBERS.map((n) => {
    const stage = lookup[n];
    return stage === undefined ? undefined : stageWatermark(stage);
  }).filter((line): line is string => line !== undefined);

/**
 * A stage's name when nothing about it has loaded: its Spiral colour, never an
 * empty string, so a control offered before the server answers still reads.
 */
export const stageFallbackName = (stageNumber: number): string =>
  STAGE_ORDER[stageNumber - 1] ?? `Stage ${stageNumber}`;
