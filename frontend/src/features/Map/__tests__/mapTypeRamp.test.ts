/* global describe, it, expect */
import { StyleSheet } from 'react-native';

import { legalFontSizes } from '../../../../e2e/textCensus';
import { INTERACTIVE_TEXT_MIN } from '../../../design/tokens';
import styles from '../Map.styles';
import { stageExpressionsStyles } from '../StageExpressionsSection';

/**
 * Every size the Map sets sits on the Candle & Ink type ramp (#2960).
 *
 * A StyleSheet literal cannot know the window width, so a static size must be
 * legal at the phone AND the desktop profile the text census measures: the
 * intersection of ``legalFontSizes(390)`` and ``legalFontSizes(1280)``, the
 * same set ``src/design/__tests__/textCensus.test.ts`` pins to the tokens.
 */

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
/** DESIGN.md "One face per role": no Map region shows more than three sizes. */
const MAX_SIZES_PER_REGION = 3;

const desktopLegal = legalFontSizes(DESKTOP_WIDTH);
const STATIC_LEGAL = new Set([...legalFontSizes(PHONE_WIDTH)].filter((s) => desktopLegal.has(s)));

type Region = 'grid' | 'lens' | 'chrome' | 'modal';

/** Every style that sets a size, keyed to the one Map region it paints. */
const REGION: Readonly<Record<string, Region>> = {
  // The grid ring: stage copy, aspect labels, the watermark and its chips.
  personaText: 'grid',
  lineText: 'grid',
  arrowLabelText: 'grid',
  titleText: 'grid',
  lockText: 'grid',
  lockLeft: 'grid',
  unlockTimeline: 'grid',
  completedBadgeText: 'grid',
  // The glass magnifier riding the center column.
  magnifierHeadline: 'lens',
  magnifierDetail: 'lens',
  youAreHereText: 'lens',
  // Screen chrome: loading/error, refresh banner, journey header, Begin again.
  loadingText: 'chrome',
  errorText: 'chrome',
  emptyText: 'chrome',
  errorHint: 'chrome',
  errorRetryText: 'chrome',
  celebrationText: 'chrome',
  journeyReadText: 'chrome',
  cycleIndicator: 'chrome',
  beginAgainHeading: 'chrome',
  beginAgainBody: 'chrome',
  refreshBannerText: 'chrome',
  refreshRetryText: 'chrome',
  // The stage-detail modal, its history and its expressions section.
  closeText: 'modal',
  modalTitle: 'modal',
  modalSubtitle: 'modal',
  progressionSentence: 'modal',
  rankedStatValue: 'modal',
  rankedStatLabel: 'modal',
  progressLabel: 'modal',
  metadataLabel: 'modal',
  metadataValue: 'modal',
  freeWillDescription: 'modal',
  primaryActionText: 'modal',
  secondaryActionText: 'modal',
  historyTitle: 'modal',
  historyToggle: 'modal',
  historyEmpty: 'modal',
  historyErrorText: 'modal',
  historyRetryText: 'modal',
  historySubheading: 'modal',
  historyItemIcon: 'modal',
  historyItemName: 'modal',
  historyItemDetail: 'modal',
  goalBadgeText: 'modal',
  'expr.phaseEyebrow': 'modal',
  'expr.expressionHeading': 'modal',
  'expr.expressionName': 'modal',
  'expr.expressionDescription': 'modal',
};

/** Text the reader taps: held to the interactive floor, never a caption. */
const TAPPABLE = [
  'errorRetryText',
  'refreshRetryText',
  'closeText',
  'primaryActionText',
  'secondaryActionText',
  'historyTitle',
  'historyToggle',
  'historyRetryText',
] as const;

/** Both sheets under one namespace, the modal section's keys prefixed so none can mask another. */
const sheets: Readonly<Record<string, unknown>> = {
  ...styles,
  ...Object.fromEntries(
    Object.entries(stageExpressionsStyles).map(([key, style]) => [`expr.${key}`, style]),
  ),
};

const sizeOf = (key: string): number | undefined =>
  (StyleSheet.flatten(sheets[key] as object) as { fontSize?: number } | undefined)?.fontSize;

const sized = Object.keys(sheets).filter((key) => typeof sizeOf(key) === 'number');

const keysIn = (regions: readonly Region[]): string[] =>
  sized.filter((key) => regions.includes(REGION[key] as Region));

const offRamp = (keys: readonly string[]): string[] =>
  keys
    .filter((key) => !STATIC_LEGAL.has(sizeOf(key) as number))
    .map((key) => `${key}=${sizeOf(key)}`)
    .sort();

describe('Map text is on the type ramp (#2960)', () => {
  it('derives the static-legal sizes as the 390 and 1280 ramps intersected', () => {
    expect([...STATIC_LEGAL].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 18, 20, 26, 34]);
  });

  it('files every sized style under exactly one region, so none escapes the rules below', () => {
    expect(sized.filter((key) => REGION[key] === undefined)).toEqual([]);
    expect(Object.keys(REGION).filter((key) => !sized.includes(key))).toEqual([]);
  });

  it('sets the lens, screen chrome and modal on sizes legal at both 390 and 1280', () => {
    expect(offRamp(keysIn(['lens', 'chrome', 'modal']))).toEqual([]);
  });

  it('holds tappable text to the interactive floor', () => {
    const below = TAPPABLE.filter((key) => (sizeOf(key) ?? 0) < INTERACTIVE_TEXT_MIN);
    expect(below).toEqual([]);
  });

  it.each(['lens', 'chrome', 'modal'] as const)(
    'shows at most three sizes in the %s region',
    (region) => {
      const sizes = new Set(keysIn([region]).map(sizeOf));
      expect(sizes.size).toBeLessThanOrEqual(MAX_SIZES_PER_REGION);
    },
  );
});
